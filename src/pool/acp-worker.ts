import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";
import { stripModelThinkingSuffix } from "../compiler/model-resolver.js";
import { config } from "../config.js";
import { telemetryStore } from "../telemetry/metrics-store.js";
import {
  AcpConfigOption,
  AcpContentBlock,
  AcpInitializeResult,
  AcpModelInfo,
  AcpPromptResult,
  AcpSessionNewResult,
  AcpSessionUpdateParams,
  JsonRpcResponse,
} from "../types/acp.js";
import { CcpaModelSniffer } from "./ccpa-sniffer.js";
import {
  cleanupWorkerSandbox,
  createWorkerSandbox,
  syncWorkerSandboxAuth,
  WorkerSandboxEnv,
} from "./sandbox.js";

export interface PromptStreamCallbacks {
  onThoughtChunk: (text: string) => void;
  onMessageChunk: (text: string) => void;
  onNativeToolCall?: (toolName: string, rawInput: unknown) => void;
  onActualModelDetected?: (actualModelVersion: string) => void;
}

export interface ExtendedPromptExecutionResult extends AcpPromptResult {
  ttftMs: number;
  durationMs: number;
  actualModelVersion: string;
}

export interface AcpWorkerHooks {
  /** Fired once when the `agy` process dies on its own (not after `destroy()`). */
  onDeath?: (worker: AcpWorker, err: Error) => void;
  /** Fired whenever an ACP session on this worker is closed (TTL, eviction, admin). */
  onSessionClosed?: (sessionId: string) => void;
}

interface PendingRpc {
  resolve: (val: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export type WorkerState = "STARTING" | "IDLE" | "BUSY" | "DEAD";

/**
 * `AGY2API_MODEL_SNIFFER=1` proxies agy's backend traffic through a local sniffer to read the
 * model version that actually answered.
 */
export function modelSnifferEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.AGY2API_MODEL_SNIFFER?.trim() ?? "");
}

const STDERR_TAIL_LIMIT = 4096;
// After `exit`, wait this long for stdio to drain so the stderr tail is complete
const EXIT_DRAIN_GRACE_MS = 250;

export class AcpWorker {
  public readonly id: string;
  public readonly sandbox: WorkerSandboxEnv;
  public readonly createdAt: number = Date.now();
  public readyAt: number | null = null;
  public state: WorkerState = "STARTING";
  public lastUsedAt: number = Date.now();
  public availableModels: AcpModelInfo[] = [];
  /** The agent's `initialize` response (protocol version, prompt capabilities, agent info). */
  public agentInfo: AcpInitializeResult | null = null;
  public totalRequestsHandled: number = 0;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private sniffer: CcpaModelSniffer = new CcpaModelSniffer();
  private rpcIdCounter = 1;
  private pendingRpcs = new Map<number | string, PendingRpc>();
  private activeStreamListeners = new Map<string, PromptStreamCallbacks>();
  // sessionId -> last time a prompt started or finished on it
  private sessionLastUsedAt = new Map<string, number>();
  private sessionAssignedModel = new Map<string, string>();
  private sessionConfirmedConfig = new Map<
    string,
    { model: string; thoughtLevel: string }
  >();
  private stderrTail = "";
  private hooks: AcpWorkerHooks;

  constructor(id: string, hooks: AcpWorkerHooks = {}) {
    this.id = id;
    this.sandbox = createWorkerSandbox(id);
    this.hooks = hooks;
  }

  public async start(): Promise<void> {
    const args = [
      "acp",
      "--sandbox",
      "--include-default-customizations=false",
      `--gemini-dir=${this.sandbox.absGeminiDir}`,
      `--agent=${this.sandbox.agentName}`,
    ];

    // Opt-in: routing agy's traffic through a local Node proxy changes what Google sees on the
    // wire (TLS stack, HTTP/1.1), so by default agy talks to its backend directly
    if (modelSnifferEnabled()) {
      const snifferPort = await this.sniffer.start((detectedVer) => {
        const cleanVer = stripModelThinkingSuffix(detectedVer);
        for (const listener of this.activeStreamListeners.values()) {
          listener.onActualModelDetected?.(cleanVer);
        }
      });
      args.push(`--cloud_code_endpoint=http://127.0.0.1:${snifferPort}`);
    }

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(process.platform === "linux"
        ? { SSH_CONNECTION: process.env.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 22" }
        : {}),
    };

    const proc = spawn(config.agyBin, args, {
      cwd: this.sandbox.jailCwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;

    // Writes racing a dying process raise EPIPE on stdin; without a listener that would crash the gateway
    proc.stdin.on("error", () => {});

    proc.on("exit", (code, signal) => {
      const die = () =>
        this.handleProcessDeath(
          new Error(
            `Worker ${this.id} exited unexpectedly (code=${code ?? "null"}, signal=${
              signal ?? "null"
            })${this.formatStderrTail()}`
          )
        );
      const fallback = setTimeout(die, EXIT_DRAIN_GRACE_MS);
      fallback.unref?.();
      proc.once("close", () => {
        clearTimeout(fallback);
        die();
      });
    });

    proc.on("error", (err) => {
      this.handleProcessDeath(
        new Error(
          `Worker ${this.id} failed to run '${config.agyBin}': ${err.message}`
        )
      );
    });

    const rl = readline.createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      this.handleStdoutLine(line);
    });

    // Keep only the tail of stderr so crash reasons can be surfaced without unbounded memory
    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });

    // Perform ACP JSON-RPC handshake
    try {
      this.agentInfo = await this.sendRpc<AcpInitializeResult>("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
    } catch (err: any) {
      // Prefer the death reason (exit code + stderr) over a bare RPC rejection
      const msg = err?.message || String(err);
      throw new Error(
        msg.includes("stderr:") ? msg : `${msg}${this.formatStderrTail()}`
      );
    }

    this.state = "IDLE";
    this.readyAt = Date.now();
    this.lastUsedAt = Date.now();
  }

  public getPid(): number | null {
    return this.proc?.pid ?? null;
  }

  public getSnifferPort(): number {
    return this.sniffer.getPort();
  }

  public getStderrTail(): string {
    return this.stderrTail;
  }

  public getActiveSessionIds(): string[] {
    return Array.from(this.sessionLastUsedAt.keys());
  }

  public hasSession(sessionId: string): boolean {
    return this.sessionLastUsedAt.has(sessionId);
  }

  public isSessionInFlight(sessionId: string): boolean {
    return this.activeStreamListeners.has(sessionId);
  }

  /** Marks a session as just used, so the idle sweep leaves it alone until its prompt starts. */
  public touchSession(sessionId: string): void {
    if (this.sessionLastUsedAt.has(sessionId)) {
      this.sessionLastUsedAt.set(sessionId, Date.now());
    }
  }

  /**
   * Creates a new ACP session on this worker in native `default` mode (no plan/build switching),
   * sets the target `acpModelId`, and injects `<system_override>` + external tool schemas.
   * Evicts least-recently-used idle sessions first so the worker never exceeds `maxSessionsPerWorker`.
   */
  public async createSession(
    systemPromptAppend: string,
    acpModelId: string
  ): Promise<string> {
    await this.evictIdleSessions(Math.max(0, config.maxSessionsPerWorker - 1));

    syncWorkerSandboxAuth(this.sandbox.absAppDataDir);
    const res = await this.sendRpc<AcpSessionNewResult>("session/new", {
      cwd: this.sandbox.jailCwd,
      mcpServers: [],
      _meta: {
        antigravity: {
          systemPrompt: {
            append: systemPromptAppend,
          },
        },
      },
    });

    const sessionId = res.sessionId;
    this.sessionLastUsedAt.set(sessionId, Date.now());

    if (res.models?.availableModels?.length) {
      this.availableModels = res.models.availableModels;
    }

    if (res.configOptions) {
      this.updateConfirmedConfigFromOptions(sessionId, res.configOptions);
    }

    await this.ensureSessionModel(sessionId, acpModelId);

    return sessionId;
  }

  /**
   * Ensures the session is configured to use `acpModelId`.
   * If a reused session requests a different thinking effort variant (e.g. `low` -> `high`),
   * calls `session/set_model` dynamically on the existing session.
   */
  public async ensureSessionModel(
    sessionId: string,
    acpModelId: string
  ): Promise<void> {
    if (!acpModelId) return;
    if (this.sessionAssignedModel.get(sessionId) === acpModelId) {
      return;
    }

    try {
      await this.sendRpc("session/set_model", {
        sessionId,
        modelId: acpModelId,
      });
      this.sessionAssignedModel.set(sessionId, acpModelId);
    } catch {
      // Non-fatal if modelId falls back to default
    }
  }

  /**
   * Executes a `session/prompt` turn on an existing `sessionId`, measuring TTFT,
   * capturing actual responding modelVersion via the local CCPA sniffer + ACP config updates,
   * and returning token + cache usage.
   */
  public async runPrompt(
    sessionId: string,
    prompt: AcpContentBlock[],
    acpModelId: string,
    callbacks: PromptStreamCallbacks,
    abortSignal?: AbortSignal
  ): Promise<ExtendedPromptExecutionResult> {
    await this.ensureSessionModel(sessionId, acpModelId);
    if (abortSignal?.aborted) {
      // A cancel sent ahead of the prompt would be ignored and the whole turn would still run
      throw new Error("Prompt aborted before it was sent");
    }

    this.sniffer.resetTurnModel();
    const startTime = Date.now();
    let firstTokenTime: number | null = null;
    this.sessionLastUsedAt.set(sessionId, startTime);

    const wrappedCallbacks: PromptStreamCallbacks = {
      onThoughtChunk: (text) => {
        if (firstTokenTime === null) {
          firstTokenTime = Date.now();
        }
        callbacks.onThoughtChunk(text);
      },
      onMessageChunk: (text) => {
        if (firstTokenTime === null) {
          firstTokenTime = Date.now();
        }
        callbacks.onMessageChunk(text);
      },
      onNativeToolCall: callbacks.onNativeToolCall,
      onActualModelDetected: callbacks.onActualModelDetected,
    };

    this.activeStreamListeners.set(sessionId, wrappedCallbacks);

    const onAbort = () => {
      this.sendNotification("session/cancel", { sessionId });
    };

    abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await this.sendRpc<AcpPromptResult>(
        "session/prompt",
        {
          sessionId,
          prompt,
        },
        config.requestTimeoutMs
      );

      const endTime = Date.now();
      const durationMs = endTime - startTime;
      const ttftMs =
        firstTokenTime !== null ? firstTokenTime - startTime : durationMs;

      this.totalRequestsHandled++;
      const actualModelVersion = this.resolveActualModelString(
        sessionId,
        acpModelId
      );

      return {
        ...result,
        ttftMs,
        durationMs,
        actualModelVersion,
      };
    } catch (err) {
      // On timeout (or any other failure) stop the turn upstream so it does not keep burning quota
      if (!abortSignal?.aborted) {
        this.sendNotification("session/cancel", { sessionId });
      }
      throw err;
    } finally {
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      this.activeStreamListeners.delete(sessionId);
      this.lastUsedAt = Date.now();
      if (this.sessionLastUsedAt.has(sessionId)) {
        this.sessionLastUsedAt.set(sessionId, this.lastUsedAt);
      }
    }
  }

  public resolveActualModelString(
    sessionId: string,
    fallbackAcpModelId: string
  ): string {
    const upstreamModel = this.sniffer.getDetectedModelVersion();
    const confirmed = this.sessionConfirmedConfig.get(sessionId);

    if (upstreamModel && upstreamModel !== "gemini-3.5-flash-lite") {
      return stripModelThinkingSuffix(upstreamModel);
    }

    if (confirmed?.model) {
      return stripModelThinkingSuffix(confirmed.model);
    }

    return stripModelThinkingSuffix(upstreamModel || fallbackAcpModelId);
  }

  public async closeSession(sessionId: string): Promise<void> {
    if (!this.sessionLastUsedAt.has(sessionId)) return;
    this.sessionLastUsedAt.delete(sessionId);
    this.sessionAssignedModel.delete(sessionId);
    this.sessionConfirmedConfig.delete(sessionId);
    telemetryStore.markSessionClosed(sessionId);
    this.hooks.onSessionClosed?.(sessionId);
    try {
      await this.sendRpc("session/close", { sessionId }, 5000);
    } catch (err: any) {
      // The session is forgotten locally either way; upstream may keep it alive until the worker exits
      console.warn(
        `[agy-acp2api] session/close failed for ${sessionId} on worker ${this.id}: ${
          err?.message || String(err)
        }`
      );
    }
  }

  /**
   * Closes sessions that are not mid-turn and were last used before `cutoffMs`.
   */
  public async closeSessionsIdleSince(cutoffMs: number): Promise<number> {
    const stale = Array.from(this.sessionLastUsedAt.entries())
      .filter(([id, ts]) => ts < cutoffMs && !this.isSessionInFlight(id))
      .map(([id]) => id);
    await Promise.all(stale.map((id) => this.closeSession(id)));
    return stale.length;
  }

  /**
   * Closes least-recently-used idle sessions until at most `keep` sessions remain.
   */
  private async evictIdleSessions(keep: number): Promise<void> {
    const excess = this.sessionLastUsedAt.size - keep;
    if (excess <= 0) return;
    const victims = Array.from(this.sessionLastUsedAt.entries())
      .filter(([id]) => !this.isSessionInFlight(id))
      .sort((a, b) => a[1] - b[1])
      .slice(0, excess)
      .map(([id]) => id);
    await Promise.all(victims.map((id) => this.closeSession(id)));
  }

  public destroy(): void {
    this.state = "DEAD";
    telemetryStore.markWorkerSessionsClosed(this.id);
    for (const [, pending] of this.pendingRpcs) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Worker ${this.id} destroyed`));
    }
    this.pendingRpcs.clear();
    this.activeStreamListeners.clear();
    this.sessionLastUsedAt.clear();
    this.sessionAssignedModel.clear();
    this.sessionConfirmedConfig.clear();

    this.sniffer.stop();

    if (this.proc) {
      try {
        this.proc.kill("SIGKILL");
      } catch {}
      this.proc = null;
    }

    cleanupWorkerSandbox(this.sandbox);
  }

  private formatStderrTail(): string {
    const tail = this.stderrTail.trim();
    if (!tail) return "";
    const lines = tail.split(/\r?\n/).slice(-10).join("\n");
    return `\nstderr:\n${lines}`;
  }

  private updateConfirmedConfigFromOptions(
    sessionId: string,
    options: AcpConfigOption[]
  ): void {
    const current = this.sessionConfirmedConfig.get(sessionId) || {
      model: "",
      thoughtLevel: "",
    };
    for (const opt of options) {
      if (opt.id === "model" && opt.currentValue) {
        current.model = opt.currentValue;
      } else if (opt.id === "thought_level" && opt.currentValue) {
        current.thoughtLevel = opt.currentValue;
      }
    }
    this.sessionConfirmedConfig.set(sessionId, current);
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;

    let msg: Record<string, any>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }

    // 1. Handle incoming JSON-RPC Requests from ACP Server (`session/request_permission`)
    if (typeof msg.method === "string" && msg.id !== undefined) {
      this.handleServerRequest(msg.id, msg.method, msg.params || {});
      return;
    }

    // 2. Handle incoming JSON-RPC Notifications (`session/update`)
    if (msg.method === "session/update" && msg.params) {
      this.handleSessionUpdate(msg.params as AcpSessionUpdateParams);
      return;
    }

    // 3. Handle JSON-RPC Responses to our requests
    if (msg.id !== undefined) {
      const pending = this.pendingRpcs.get(msg.id);
      if (!pending) return;
      this.pendingRpcs.delete(msg.id);
      clearTimeout(pending.timer);

      const rpcRes = msg as JsonRpcResponse;
      if (rpcRes.error) {
        pending.reject(
          new Error(
            `ACP RPC Error [${rpcRes.error.code}]: ${rpcRes.error.message}`
          )
        );
      } else {
        pending.resolve(rpcRes.result);
      }
    }
  }

  private handleServerRequest(
    id: number | string,
    method: string,
    params: Record<string, any>
  ): void {
    if (method === "session/request_permission") {
      const options: Array<{ optionId: string; kind?: string }> =
        params?.options || [];
      const rejectOpt = options.find(
        (o) =>
          o.kind === "reject_once" ||
          o.kind === "reject_always" ||
          o.optionId?.toLowerCase().includes("reject")
      );

      const resultPayload = rejectOpt
        ? { outcome: { outcome: "selected", optionId: rejectOpt.optionId } }
        : { outcome: { outcome: "cancelled" } };

      this.writeJson({
        jsonrpc: "2.0",
        id,
        result: resultPayload,
      });

      if (params?.sessionId) {
        this.sendNotification("session/cancel", {
          sessionId: params.sessionId,
        });
      }
      return;
    }

    this.writeJson({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Client method '${method}' is disabled by agy2api read-only sandbox.`,
      },
    });
  }

  private handleSessionUpdate(params: AcpSessionUpdateParams): void {
    if (!params.update) return;
    const { sessionUpdate, content, configOptions } = params.update;

    if (sessionUpdate === "config_option_update" && Array.isArray(configOptions)) {
      this.updateConfirmedConfigFromOptions(params.sessionId, configOptions);
    }

    const listener = this.activeStreamListeners.get(params.sessionId);
    if (!listener) return;

    if (sessionUpdate === "agent_thought_chunk" && content?.text) {
      listener.onThoughtChunk(content.text);
    } else if (sessionUpdate === "agent_message_chunk" && content?.text) {
      listener.onMessageChunk(content.text);
    } else if (sessionUpdate === "tool_call") {
      const title =
        params.update.title || params.update.kind || "unknown_native_tool";
      listener.onNativeToolCall?.(title, params.update.rawInput);
    }
  }

  private sendRpc<T = any>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = 60_000
  ): Promise<T> {
    if (this.state === "DEAD" || !this.proc?.stdin.writable) {
      return Promise.reject(new Error(`Worker ${this.id} is not writable`));
    }

    const id = this.rpcIdCounter++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(id);
        reject(new Error(`ACP RPC '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRpcs.set(id, { resolve, reject, timer });
      this.writeJson({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    });
  }

  private sendNotification(
    method: string,
    params: Record<string, unknown>
  ): void {
    this.writeJson({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  private writeJson(payload: Record<string, unknown>): void {
    if (this.proc?.stdin.writable) {
      this.proc.stdin.write(JSON.stringify(payload) + "\n");
    }
  }

  private handleProcessDeath(err: Error): void {
    if (this.state === "DEAD") return;
    this.state = "DEAD";
    telemetryStore.markWorkerSessionsClosed(this.id);
    for (const [, pending] of this.pendingRpcs) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRpcs.clear();
    this.activeStreamListeners.clear();
    this.sessionLastUsedAt.clear();
    this.sessionAssignedModel.clear();
    this.sessionConfirmedConfig.clear();
    this.sniffer.stop();
    cleanupWorkerSandbox(this.sandbox);
    this.hooks.onDeath?.(this, err);
  }
}
