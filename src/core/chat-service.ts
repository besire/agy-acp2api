import {
  compileDeltaPrompt,
  compileFullPrompt,
} from "../compiler/prompt-compiler.js";
import {
  resolveModelAndThinking,
  ResolvedModelTarget,
} from "../compiler/model-resolver.js";
import { ParserEvent, ToolCallStreamParser } from "../parser/stream-parser.js";
import {
  LeaseAcquisition,
  PoolUnavailableError,
  WorkerPool,
} from "../pool/worker-pool.js";
import { telemetryStore } from "../telemetry/metrics-store.js";
import { AcpContentBlock, AcpPromptResult } from "../types/acp.js";
import {
  AssistantMessage,
  ChatMessage,
  ChatRequest,
  FinishReason,
  GatewayError,
  TokenUsage,
  ToolCall,
  TurnEvent,
  TurnResult,
} from "./chat.js";
import { resolveImages } from "./images.js";
import { StopSequenceFilter } from "./stop-sequences.js";

export function errorMessage(err: unknown): string {
  return (err as { message?: string } | null)?.message || String(err);
}

const NO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  thoughtTokens: 0,
  totalTokens: 0,
};

function normalizeUsage(usage: AcpPromptResult["usage"]): TokenUsage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cachedReadTokens: usage?.cachedReadTokens ?? 0,
    cachedWriteTokens: usage?.cachedWriteTokens ?? 0,
    thoughtTokens: usage?.thoughtTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
  };
}

/** Maps an ACP stop reason onto the finish reason clients understand. */
export function finishReasonFor(stopReason: string | undefined, toolCalls: number): FinishReason {
  if (toolCalls > 0) return "tool_calls";
  switch (stopReason) {
    case "max_tokens":
    case "max_turn_requests":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

/**
 * Protocol-independent chat pipeline: resolve model → lease worker → compile prompt →
 * open or reuse an ACP session (`prepare`), then run the prompt and turn its output into
 * neutral events (`ChatTurn.run`).
 */
export class ChatService {
  constructor(private readonly pool: WorkerPool) {}

  /**
   * Leases a worker with a ready ACP session: the warm session whose history prefix matches
   * (only the new messages are sent), or a fresh one primed with the full transcript.
   * Failures are `GatewayError`s; nothing needs releasing when this throws.
   */
  async prepare(req: ChatRequest, requestId: string): Promise<ChatTurn> {
    const target = resolveModelAndThinking(req, this.pool.getAvailableModels());
    let lease = await this.acquire(target, req);
    const reuse = lease.isReusedSession && lease.sessionId !== null;
    const images =
      lease.worker.agentInfo?.agentCapabilities?.promptCapabilities?.image === true;

    // Images are only fetched for what is actually sent; a bad image is the client's fault
    // and must not cost the worker or the warm session
    let outgoing: ChatMessage[];
    try {
      const pending = reuse ? lease.deltaMessages : req.messages;
      outgoing = images ? await resolveImages(pending) : pending;
    } catch (err) {
      this.pool.releaseUnusedLease(lease);
      throw err instanceof GatewayError
        ? err
        : new GatewayError(errorMessage(err), 400, "invalid_request_error");
    }

    let sessionId = lease.sessionId;
    let prompt: AcpContentBlock[];
    try {
      if (reuse && sessionId) {
        prompt = compileDeltaPrompt(outgoing, { images });
      } else {
        const compiled = compileFullPrompt(outgoing, req.tools, req.toolChoice, { images });
        try {
          sessionId = await lease.worker.createSession(
            compiled.systemPromptAppend,
            target.acpModelId
          );
        } catch {
          // If the worker had cached an unauthenticated state before login, recycle it and retry once
          this.pool.terminateWorker(lease.worker.id);
          lease = { ...(await this.pool.acquireFresh(req.messages)), missReason: lease.missReason };
          sessionId = await lease.worker.createSession(
            compiled.systemPromptAppend,
            target.acpModelId
          );
        }
        telemetryStore.registerNewSession(
          sessionId,
          lease.worker.id,
          target.baseModelId,
          target.acpModelId,
          target.thinkingLevel
        );
        prompt = compiled.prompt;
      }
    } catch (err) {
      this.pool.terminateWorker(lease.worker.id);
      throw new GatewayError(
        `Failed to initialize ACP session: ${errorMessage(err)}`,
        500,
        "server_error"
      );
    }

    return new ChatTurn(this.pool, requestId, req, target, lease, sessionId, prompt);
  }

  private async acquire(
    target: ResolvedModelTarget,
    req: ChatRequest
  ): Promise<LeaseAcquisition> {
    try {
      // `baseModelId` keeps session affinity across reasoning-effort changes
      return await this.pool.acquireForRequest(target.baseModelId, req.tools, req.messages);
    } catch (err) {
      throw err instanceof PoolUnavailableError
        ? new GatewayError(errorMessage(err), 503, "service_unavailable")
        : new GatewayError(errorMessage(err), 500, "server_error");
    }
  }
}

/** A leased worker with a ready session. `run` must be called exactly once. */
export class ChatTurn {
  private started = false;

  constructor(
    private readonly pool: WorkerPool,
    readonly requestId: string,
    readonly request: ChatRequest,
    readonly target: ResolvedModelTarget,
    private readonly lease: LeaseAcquisition,
    readonly sessionId: string,
    private readonly prompt: AcpContentBlock[]
  ) {}

  get workerId(): string {
    return this.lease.worker.id;
  }

  get sessionCache(): "HIT" | "MISS" {
    return this.lease.isReusedSession ? "HIT" : "MISS";
  }

  /**
   * Runs the prompt, forwarding output to `onEvent` as it arrives. Registers the new history
   * for session reuse, records telemetry and returns the worker to the pool, success or not.
   */
  async run(
    onEvent: (event: TurnEvent) => void,
    signal?: AbortSignal
  ): Promise<TurnResult> {
    if (this.started) throw new Error("A chat turn can only run once");
    this.started = true;

    const { worker } = this.lease;
    const { request, target } = this;
    const toolNames = request.tools.map((t) => t.name);

    // What the client actually receives: text past a stop sequence and anything after it is not
    const stop = request.stop?.length ? new StopSequenceFilter(request.stop) : null;
    const cutShort = new AbortController();
    let text = "";
    const toolCalls: ToolCall[] = [];
    const emitText = (visible: string | undefined) => {
      if (!visible) return;
      text += visible;
      onEvent({ type: "text", text: visible });
    };
    const forward = (event: ParserEvent) => {
      if (cutShort.signal.aborted) return;
      if (event.type === "tool_call") {
        emitText(stop?.flush());
        toolCalls.push(event.call);
        onEvent(event);
        return;
      }
      emitText(stop ? stop.push(event.text) : event.text);
      // Stop generating upstream too: the rest would only burn quota
      if (stop?.stopped) cutShort.abort();
    };
    const parser = new ToolCallStreamParser(forward, toolNames);
    let reasoning = "";
    let sent = false;
    let intact = false;

    try {
      if (signal?.aborted) {
        throw new Error("The client went away before the prompt was sent");
      }
      sent = true;
      const res = await worker.runPrompt(
        this.sessionId,
        this.prompt,
        target.acpModelId,
        {
          onActualModelDetected: (model) => onEvent({ type: "model", model }),
          onThoughtChunk: (chunk) => {
            if (cutShort.signal.aborted) return;
            reasoning += chunk;
            onEvent({ type: "thought", text: chunk });
          },
          onMessageChunk: (chunk) => parser.feed(chunk),
          onNativeToolCall: (name, rawInput) => {
            if (toolNames.includes(name)) {
              parser.injectDirectToolCall(name, rawInput);
            }
          },
        },
        signal ? AbortSignal.any([signal, cutShort.signal]) : cutShort.signal
      );

      if (res.actualModelVersion) {
        onEvent({ type: "model", model: res.actualModelVersion });
      }
      parser.flush();
      if (!cutShort.signal.aborted) emitText(stop?.flush());

      const message: AssistantMessage = {
        role: "assistant",
        content: text ? [{ type: "text", text }] : [],
        toolCalls,
      };
      // A cancelled or cut-short turn leaves upstream history the client never saw
      intact = res.stopReason !== "cancelled" && !cutShort.signal.aborted;
      if (intact) {
        this.pool.sessionRegistry.registerTurnState(
          target.baseModelId,
          request.tools,
          [...request.messages, message],
          worker.id,
          this.sessionId
        );
      }

      const result: TurnResult = {
        message,
        reasoning,
        finishReason: cutShort.signal.aborted
          ? "stop"
          : finishReasonFor(res.stopReason, toolCalls.length),
        usage: normalizeUsage(res.usage),
        actualModel: res.actualModelVersion || target.baseModelId,
        ttftMs: res.ttftMs,
        durationMs: res.durationMs,
      };
      this.record(result, parser.parseFailures);
      return result;
    } catch (err) {
      this.record(null, parser.parseFailures, errorMessage(err));
      throw err;
    } finally {
      if (!sent) {
        // Nothing reached agy: a reused session is still good, a new one is only primed
        this.pool.releaseUnusedLease(this.lease);
      } else {
        if (!intact) this.pool.discardSession(worker.id, this.sessionId);
        this.pool.releaseWorker(worker);
      }
    }
  }

  private record(result: TurnResult | null, toolParseFailures: number, error?: string): void {
    try {
      telemetryStore.recordCompletedRequest({
        requestId: this.requestId,
        timestamp: Date.now(),
        sessionId: this.sessionId,
        workerId: this.workerId,
        sessionCache: this.sessionCache,
        missReason: this.lease.isReusedSession ? null : (this.lease.missReason ?? null),
        requestedModel: this.target.requestedModel,
        resolvedBaseModel: this.target.baseModelId,
        thinkingLevel: this.target.thinkingLevel,
        acpModelId: this.target.acpModelId,
        actualModelVersion: result?.actualModel ?? this.target.baseModelId,
        ttftMs: result?.ttftMs ?? 0,
        durationMs: result?.durationMs ?? 0,
        stream: this.request.stream,
        finishReason: result?.finishReason ?? "error",
        toolCallsCount: result?.message.toolCalls.length ?? 0,
        toolParseFailures,
        ...(result?.usage ?? NO_USAGE),
        status: result ? "success" : "error",
        ...(error !== undefined ? { errorMessage: error } : {}),
      });
    } catch (err) {
      // Telemetry must never turn a finished turn into a failed request
      console.warn(`[agy-acp2api] Failed to record telemetry: ${errorMessage(err)}`);
    }
  }
}
