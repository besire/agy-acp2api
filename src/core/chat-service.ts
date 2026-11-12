import {
  compileDeltaPrompt,
  compileFullPrompt,
} from "../compiler/prompt-compiler.js";
import {
  resolveModelAndThinking,
  ResolvedModelTarget,
} from "../compiler/model-resolver.js";
import { ToolCallStreamParser } from "../parser/stream-parser.js";
import {
  LeaseAcquisition,
  PoolUnavailableError,
  WorkerPool,
} from "../pool/worker-pool.js";
import { telemetryStore } from "../telemetry/metrics-store.js";
import { AcpPromptResult } from "../types/acp.js";
import {
  ChatRequest,
  GatewayError,
  TokenUsage,
  TurnEvent,
  TurnResult,
} from "./chat.js";

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
    let sessionId = lease.sessionId;
    let promptText: string;

    try {
      if (lease.isReusedSession && sessionId) {
        promptText = compileDeltaPrompt(lease.deltaMessages);
      } else {
        const compiled = compileFullPrompt(req.messages, req.tools, req.toolChoice);
        try {
          sessionId = await lease.worker.createSession(
            compiled.systemPromptAppend,
            target.acpModelId
          );
        } catch {
          // If the worker had cached an unauthenticated state before login, recycle it and retry once
          this.pool.terminateWorker(lease.worker.id);
          const retry = await this.pool.acquireForRequest(
            target.baseModelId,
            req.tools,
            req.messages
          );
          // The retry always opens a new session, even if its lease matched a warm one
          lease = { ...retry, sessionId: null, isReusedSession: false };
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
        promptText = compiled.promptText;
      }
    } catch (err) {
      this.pool.terminateWorker(lease.worker.id);
      throw new GatewayError(
        `Failed to initialize ACP session: ${errorMessage(err)}`,
        500,
        "server_error"
      );
    }

    return new ChatTurn(this.pool, requestId, req, target, lease, sessionId, promptText);
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
    private readonly promptText: string
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
    const parser = new ToolCallStreamParser(onEvent);
    const externalToolNames = new Set(request.tools.map((t) => t.name));
    let reasoning = "";

    try {
      const res = await worker.runPrompt(
        this.sessionId,
        this.promptText,
        target.acpModelId,
        {
          onActualModelDetected: (model) => onEvent({ type: "model", model }),
          onThoughtChunk: (text) => {
            reasoning += text;
            onEvent({ type: "thought", text });
          },
          onMessageChunk: (text) => parser.feed(text),
          onNativeToolCall: (name, rawInput) => {
            if (externalToolNames.has(name)) {
              parser.injectDirectToolCall(name, rawInput);
            }
          },
        },
        signal
      );

      if (res.actualModelVersion) {
        onEvent({ type: "model", model: res.actualModelVersion });
      }
      const finishReason = parser.flush();
      const message = parser.toAssistantMessage();
      this.pool.sessionRegistry.registerTurnState(
        target.baseModelId,
        request.tools,
        [...request.messages, message],
        worker.id,
        this.sessionId
      );

      const result: TurnResult = {
        message,
        reasoning,
        finishReason,
        usage: normalizeUsage(res.usage),
        actualModel: res.actualModelVersion || target.baseModelId,
        ttftMs: res.ttftMs,
        durationMs: res.durationMs,
      };
      this.record(result);
      return result;
    } catch (err) {
      this.record(null, errorMessage(err));
      throw err;
    } finally {
      this.pool.releaseWorker(worker);
    }
  }

  private record(result: TurnResult | null, error?: string): void {
    try {
      telemetryStore.recordCompletedRequest({
        requestId: this.requestId,
        timestamp: Date.now(),
        sessionId: this.sessionId,
        workerId: this.workerId,
        sessionCache: this.sessionCache,
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
