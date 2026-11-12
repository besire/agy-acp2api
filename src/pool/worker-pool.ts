import crypto from "node:crypto";
import { config, onConfigChange } from "../config.js";
import {
  SessionAffinityEntry,
  SessionAffinityRegistry,
} from "../compiler/session-hash.js";
import { ChatMessage, ToolDefinition } from "../core/chat.js";
import { AcpInitializeResult, AcpModelInfo } from "../types/acp.js";
import { AcpWorker } from "./acp-worker.js";
import { sweepStaleSandboxes } from "./sandbox.js";

/**
 * Why a request could not continue a warm session:
 * - `new_conversation`: there is no earlier assistant turn to continue from
 * - `no_match`: no live session's history matches (edited/regenerated history, expired or
 *   closed session, gateway restart)
 * - `worker_busy`: the matching session's worker stayed busy longer than the affinity wait
 */
export type MissReason = "new_conversation" | "no_match" | "worker_busy";

export interface LeaseAcquisition {
  worker: AcpWorker;
  sessionId: string | null;
  isReusedSession: boolean;
  deltaMessages: ChatMessage[];
  matchedPrefixLength: number;
  /** Set on a reused session: the registry head this lease took over. */
  claimed?: SessionAffinityEntry;
  missReason?: MissReason;
}

export interface WorkerPoolOptions {
  /** How often idle workers are reaped and stale sessions closed. */
  sweepIntervalMs?: number;
  /** First respawn delay after a worker fails to start or dies young; doubles per failure. */
  respawnBaseDelayMs?: number;
  respawnMaxDelayMs?: number;
  /** A worker that lived at least this long is considered healthy and resets the backoff. */
  stableUptimeMs?: number;
  queueTimeoutMs?: number;
  /**
   * How long a request waits for the busy worker that holds its warm session before giving up
   * and replaying the whole history into a new session elsewhere. 0 never waits.
   */
  affinityWaitMs?: number;
}

/**
 * Thrown when no worker can serve a request (all dead and respawn is backing off,
 * or a fresh worker failed to start). Maps to HTTP 503.
 */
export class PoolUnavailableError extends Error {}

interface QueuedWaiter {
  resolve: (worker: AcpWorker) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** Waits for one particular worker; resolves true once that worker is handed over BUSY. */
interface AffinityWaiter {
  resolve: (granted: boolean) => void;
  timer: NodeJS.Timeout;
}

function envNonNegativeInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const DEFAULT_FALLBACK_MODELS: AcpModelInfo[] = [
  { modelId: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
  { modelId: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)" },
  { modelId: "gemini-4-carbon-low", name: "Gemini 4 Carbon (Low)" },
  { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
  { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
  { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
  { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
  { modelId: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)" },
  { modelId: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)" },
  { modelId: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)" },
  { modelId: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)" },
  { modelId: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)" },
  { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];

function envPositiveInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export class WorkerPool {
  private workers = new Map<string, AcpWorker>();
  private waitQueue: QueuedWaiter[] = [];
  private affinityWaiters = new Map<string, AffinityWaiter[]>();
  private sweepInterval: NodeJS.Timeout | null = null;
  private respawnTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private nextSpawnAt = 0;
  private lastWorkerError: string | null = null;
  private shuttingDown = false;
  private cachedModels: AcpModelInfo[] = [...DEFAULT_FALLBACK_MODELS];
  private lastAgentInfo: AcpInitializeResult | null = null;
  private readonly opts: Required<WorkerPoolOptions>;
  public readonly sessionRegistry: SessionAffinityRegistry;

  constructor(options: WorkerPoolOptions = {}) {
    this.opts = {
      sweepIntervalMs:
        options.sweepIntervalMs ?? envPositiveInt("AGY_POOL_SWEEP_INTERVAL_MS", 10_000),
      respawnBaseDelayMs:
        options.respawnBaseDelayMs ?? envPositiveInt("AGY_RESPAWN_BASE_DELAY_MS", 1_000),
      respawnMaxDelayMs:
        options.respawnMaxDelayMs ?? envPositiveInt("AGY_RESPAWN_MAX_DELAY_MS", 60_000),
      stableUptimeMs:
        options.stableUptimeMs ?? envPositiveInt("AGY_WORKER_STABLE_UPTIME_MS", 30_000),
      queueTimeoutMs: options.queueTimeoutMs ?? 60_000,
      affinityWaitMs:
        options.affinityWaitMs ?? envNonNegativeInt("AGY2API_AFFINITY_WAIT_MS", 30_000),
    };
    this.sessionRegistry = new SessionAffinityRegistry(config.sessionTtlMs);
    onConfigChange((newCfg) => {
      this.sessionRegistry.setTtlMs(newCfg.sessionTtlMs);
      this.ensureMinWorkers();
      this.reapIdleBurstWorkers();
    });
  }

  /**
   * Starts `minWorkers` workers. Failures do not throw: the pool keeps retrying with
   * exponential backoff so the gateway can come up before `agy` is logged in.
   */
  public async initialize(): Promise<{ started: number; failed: number }> {
    sweepStaleSandboxes();

    const results = await Promise.allSettled(
      Array.from({ length: config.minWorkers }, () => this.spawnNewWorker())
    );

    this.sweepInterval = setInterval(() => {
      this.runMaintenance();
    }, this.opts.sweepIntervalMs);
    this.sweepInterval.unref?.();

    const started = results.filter((r) => r.status === "fulfilled").length;
    return { started, failed: results.length - started };
  }

  /**
   * Acquires a worker for the given conversation.
   * Uses `baseModelId` for Session Prefix Hash affinity so changing `reasoning_effort`
   * mid-conversation still hits the warm session!
   */
  public async acquireForRequest(
    baseModelId: string,
    tools: ToolDefinition[],
    messages: ChatMessage[]
  ): Promise<LeaseAcquisition> {
    const findMatch = () =>
      this.sessionRegistry.findBestMatchingPrefix(
        baseModelId,
        tools,
        messages,
        (workerId, sessionId) => {
          const w = this.workers.get(workerId);
          return Boolean(
            w && (w.state === "IDLE" || w.state === "BUSY") && w.hasSession(sessionId)
          );
        }
      );
    const reuse = (worker: AcpWorker, match: NonNullable<ReturnType<typeof findMatch>>) => {
      this.sessionRegistry.claim(match.entry);
      return {
        worker,
        sessionId: match.entry.sessionId,
        isReusedSession: true,
        deltaMessages: match.deltaMessages,
        matchedPrefixLength: match.matchedPrefixLength,
        claimed: match.entry,
      };
    };

    // 1. Session affinity: continue the warm session whose head matches the history
    let missReason: MissReason = messages.slice(1, -1).some((m) => m.role === "assistant")
      ? "no_match"
      : "new_conversation";
    const match = findMatch();
    if (match) {
      const worker = this.workers.get(match.entry.workerId)!;
      if (worker.state === "IDLE") {
        this.reserve(worker);
        return reuse(worker, match);
      }

      // Its worker is serving another session: waiting for it is usually far cheaper than
      // replaying the whole history into a new session
      missReason = "worker_busy";
      if (await this.waitForWorker(worker, this.opts.affinityWaitMs)) {
        const again = findMatch();
        if (again && again.entry.workerId === worker.id) {
          return reuse(worker, again);
        }
        return { ...this.freshLease(worker, messages), missReason: "no_match" };
      }
    }

    return { ...(await this.acquireFresh(messages)), missReason };
  }

  /** Leases any worker for a new session, starting or waiting for one if needed. */
  public async acquireFresh(messages: ChatMessage[]): Promise<LeaseAcquisition> {
    const freshLease = (worker: AcpWorker) => this.freshLease(worker, messages);

    // 2. Cache Miss: find any IDLE worker
    for (const worker of this.workers.values()) {
      if (worker.state === "IDLE") {
        this.reserve(worker);
        return freshLease(worker);
      }
    }

    // 3. All current workers are busy: spawn a burst worker if below maxWorkers
    //    (but never while respawn is backing off, or a request storm would hot-loop spawns)
    const inBackoff = Date.now() < this.nextSpawnAt;
    if (this.workers.size < config.maxWorkers && !inBackoff) {
      try {
        return freshLease(await this.spawnNewWorker(true));
      } catch (err: any) {
        throw new PoolUnavailableError(
          `Failed to start an ACP worker: ${err?.message || String(err)}`
        );
      }
    }

    if (this.workers.size === 0) {
      throw new PoolUnavailableError(this.describeUnavailable());
    }

    // 4. At capacity (or backing off with workers still starting/busy): wait for the next free worker
    return freshLease(await this.enqueueWaiter(this.opts.queueTimeoutMs));
  }

  /** Gives back a lease whose prompt was never sent, so a claimed session stays reusable. */
  public releaseUnusedLease(lease: LeaseAcquisition): void {
    if (lease.claimed) this.sessionRegistry.restore(lease.claimed);
    this.releaseWorker(lease.worker);
  }

  public releaseWorker(worker: AcpWorker): void {
    if (worker.state === "DEAD" || !this.workers.has(worker.id)) {
      this.ensureMinWorkers();
      return;
    }

    if (worker.availableModels.length > 0) {
      this.cachedModels = worker.availableModels;
    }

    // Requests waiting for this particular worker's sessions come first
    const affinity = this.affinityWaiters.get(worker.id)?.shift();
    if (affinity) {
      clearTimeout(affinity.timer);
      this.reserve(worker);
      affinity.resolve(true);
      return;
    }

    const waiter = this.waitQueue.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      this.reserve(worker);
      waiter.resolve(worker);
      return;
    }

    worker.state = "IDLE";
    worker.lastUsedAt = Date.now();
  }

  public getAvailableModels(): AcpModelInfo[] {
    return this.cachedModels;
  }

  /** What the most recently started `agy` declared in `initialize`; null until one has started. */
  public getAgentInfo(): AcpInitializeResult | null {
    return this.lastAgentInfo;
  }

  public getStats() {
    let idle = 0;
    let busy = 0;
    let starting = 0;
    for (const w of this.workers.values()) {
      if (w.state === "IDLE") idle++;
      else if (w.state === "BUSY") busy++;
      else if (w.state === "STARTING") starting++;
    }
    return {
      totalWorkers: this.workers.size,
      idleWorkers: idle,
      busyWorkers: busy,
      startingWorkers: starting,
      queuedRequests: this.waitQueue.length,
      affinityWaiters: Array.from(this.affinityWaiters.values()).reduce((n, w) => n + w.length, 0),
      cachedSessionHashes: this.sessionRegistry.size(),
      consecutiveSpawnFailures: this.consecutiveFailures,
      nextRespawnInMs: Math.max(0, this.nextSpawnAt - Date.now()),
      lastWorkerError: this.lastWorkerError,
    };
  }

  public getDetailedWorkers() {
    const now = Date.now();
    return Array.from(this.workers.values()).map((w) => {
      const idleElapsed = w.state === "IDLE" ? now - w.lastUsedAt : 0;
      const idleTtlRemainingMs = Math.max(0, config.workerIdleTtlMs - idleElapsed);
      return {
        id: w.id,
        pid: w.getPid(),
        state: w.state,
        snifferPort: w.getSnifferPort(),
        relAppDataDir: w.sandbox.relAppDataDir,
        activeSessions: w.getActiveSessionIds(),
        activeSessionCount: w.getActiveSessionIds().length,
        totalRequestsHandled: w.totalRequestsHandled,
        createdAt: w.createdAt,
        lastUsedAt: w.lastUsedAt,
        idleTtlRemainingMs,
      };
    });
  }

  public async spawnManualWorker(): Promise<AcpWorker> {
    if (this.workers.size >= config.maxWorkers) {
      throw new Error(`Maximum worker limit (${config.maxWorkers}) reached`);
    }
    return this.spawnNewWorker();
  }

  public terminateWorker(workerId: string): boolean {
    const w = this.workers.get(workerId);
    if (!w) return false;
    this.workers.delete(workerId);
    this.sessionRegistry.removeWorkerSessions(workerId);
    this.dropAffinityWaiters(workerId);
    w.destroy();
    this.ensureMinWorkers();
    return true;
  }

  public async closeWorkerSession(
    workerId: string,
    sessionId: string
  ): Promise<boolean> {
    const w = this.workers.get(workerId);
    if (!w || !w.hasSession(sessionId)) return false;
    await w.closeSession(sessionId);
    return true;
  }

  /**
   * Drops a session whose upstream history no longer matches what the client saw (failed,
   * cancelled or cut-short turn): it can never be continued, so close it now.
   */
  public discardSession(workerId: string, sessionId: string): void {
    this.sessionRegistry.removeSession(sessionId);
    void this.closeWorkerSession(workerId, sessionId).catch(() => {});
  }

  /**
   * Periodic housekeeping: reap idle burst workers, close ACP sessions idle past
   * `sessionTtlMs`, and reset the respawn backoff once a worker has proven stable.
   */
  public async runMaintenance(): Promise<void> {
    this.reapIdleBurstWorkers();
    this.sessionRegistry.pruneExpired();

    const now = Date.now();
    const cutoff = now - config.sessionTtlMs;
    await Promise.all(
      Array.from(this.workers.values())
        .filter((w) => w.state === "IDLE" || w.state === "BUSY")
        .map((w) => w.closeSessionsIdleSince(cutoff).catch(() => 0))
    );

    if (this.consecutiveFailures > 0) {
      for (const w of this.workers.values()) {
        if (w.readyAt !== null && now - w.readyAt >= this.opts.stableUptimeMs) {
          this.consecutiveFailures = 0;
          break;
        }
      }
    }
  }

  public shutdown(): void {
    this.shuttingDown = true;
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    this.rejectAllWaiters(new Error("WorkerPool shutting down"));

    for (const worker of this.workers.values()) {
      this.dropAffinityWaiters(worker.id);
      worker.destroy();
    }
    this.workers.clear();
  }

  /**
   * Starts a worker. With `reserve` the caller gets it BUSY; otherwise it is handed to a
   * queued request (if any) or parked IDLE.
   */
  private async spawnNewWorker(reserve = false): Promise<AcpWorker> {
    const id = crypto.randomUUID().slice(0, 8);
    let worker: AcpWorker;
    try {
      worker = new AcpWorker(id, {
        onDeath: (w, err) => this.handleWorkerGone(w, err),
        onSessionClosed: (sessionId) => this.sessionRegistry.removeSession(sessionId),
      });
    } catch (err) {
      this.recordFailure(err);
      this.ensureMinWorkers();
      throw err;
    }

    this.workers.set(id, worker);
    try {
      await worker.start();
    } catch (err) {
      this.handleWorkerGone(
        worker,
        err instanceof Error ? err : new Error(String(err))
      );
      worker.destroy();
      throw err;
    }

    this.lastAgentInfo = worker.agentInfo ?? this.lastAgentInfo;

    if (this.workers.get(id) !== worker) {
      // Terminated (admin action or shutdown) while it was still starting
      worker.destroy();
      throw new Error(`Worker ${id} was terminated during startup`);
    }

    if (reserve) {
      this.reserve(worker);
    } else {
      this.releaseWorker(worker);
    }
    return worker;
  }

  /**
   * Single place that accounts for a worker leaving the pool on its own (crash or failed start).
   * Idempotent: manual termination removes the worker from the map first, so it never counts.
   */
  private handleWorkerGone(worker: AcpWorker, err: Error): void {
    if (this.workers.get(worker.id) !== worker) return;
    this.workers.delete(worker.id);
    this.sessionRegistry.removeWorkerSessions(worker.id);
    this.dropAffinityWaiters(worker.id);

    const uptime = worker.readyAt === null ? 0 : Date.now() - worker.readyAt;
    if (uptime < this.opts.stableUptimeMs) {
      this.recordFailure(err);
    } else {
      this.consecutiveFailures = 0;
      this.lastWorkerError = err.message;
    }
    if (!this.shuttingDown) {
      console.warn(`[agy-acp2api] ${err.message}`);
    }

    this.ensureMinWorkers();
    if (this.workers.size === 0) {
      // Nothing is starting, so queued requests would only sit until their timeout
      this.rejectAllWaiters(new PoolUnavailableError(this.describeUnavailable()));
    }
  }

  private recordFailure(err: unknown): void {
    this.consecutiveFailures++;
    this.lastWorkerError = err instanceof Error ? err.message : String(err);
    const delay = Math.min(
      this.opts.respawnMaxDelayMs,
      this.opts.respawnBaseDelayMs * 2 ** (this.consecutiveFailures - 1)
    );
    this.nextSpawnAt = Date.now() + delay;
  }

  private describeUnavailable(): string {
    const waitMs = Math.max(0, this.nextSpawnAt - Date.now());
    const retry = waitMs > 0 ? ` Retrying in ${Math.ceil(waitMs / 1000)}s.` : "";
    return `No ACP worker is available.${retry}${
      this.lastWorkerError ? ` Last error: ${this.lastWorkerError}` : ""
    }`;
  }

  private ensureMinWorkers(): void {
    if (this.shuttingDown || this.respawnTimer) return;
    if (this.workers.size >= config.minWorkers) return;

    const waitMs = this.nextSpawnAt - Date.now();
    if (waitMs <= 0) {
      this.fillMinWorkers();
      return;
    }
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      this.fillMinWorkers();
    }, waitMs);
    this.respawnTimer.unref?.();
  }

  private fillMinWorkers(): void {
    // Compute the deficit once: a synchronous constructor failure must not loop forever
    const deficit = config.minWorkers - this.workers.size;
    for (let i = 0; i < deficit && !this.shuttingDown; i++) {
      this.spawnNewWorker().catch(() => {});
    }
  }

  private reserve(worker: AcpWorker): void {
    worker.state = "BUSY";
    worker.lastUsedAt = Date.now();
  }

  private freshLease(worker: AcpWorker, messages: ChatMessage[]): LeaseAcquisition {
    return {
      worker,
      sessionId: null,
      isReusedSession: false,
      deltaMessages: messages,
      matchedPrefixLength: 0,
    };
  }

  /**
   * Waits until `worker` is released and hands it over BUSY. False on timeout or when the
   * worker leaves the pool first.
   */
  private waitForWorker(worker: AcpWorker, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiters = this.affinityWaiters.get(worker.id) ?? [];
      this.affinityWaiters.set(worker.id, waiters);
      const waiter: AffinityWaiter = {
        resolve,
        timer: setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) waiters.splice(idx, 1);
          if (waiters.length === 0 && this.affinityWaiters.get(worker.id) === waiters) {
            this.affinityWaiters.delete(worker.id);
          }
          resolve(false);
        }, timeoutMs),
      };
      waiters.push(waiter);
    });
  }

  private dropAffinityWaiters(workerId: string): void {
    const waiters = this.affinityWaiters.get(workerId);
    if (!waiters) return;
    this.affinityWaiters.delete(workerId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
  }

  private enqueueWaiter(timeoutMs: number): Promise<AcpWorker> {
    return new Promise<AcpWorker>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waitQueue.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.waitQueue.splice(idx, 1);
        reject(
          new PoolUnavailableError(
            `Timed out waiting for an available ACP worker (${timeoutMs}ms)`
          )
        );
      }, timeoutMs);

      this.waitQueue.push({ resolve, reject, timer });
    });
  }

  private rejectAllWaiters(err: Error): void {
    const waiters = this.waitQueue;
    this.waitQueue = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  private reapIdleBurstWorkers(): void {
    if (this.workers.size <= config.minWorkers) return;

    const now = Date.now();
    for (const [id, worker] of this.workers.entries()) {
      if (this.workers.size <= config.minWorkers) break;
      if (
        worker.state === "IDLE" &&
        now - worker.lastUsedAt > config.workerIdleTtlMs
      ) {
        this.workers.delete(id);
        this.sessionRegistry.removeWorkerSessions(id);
        this.dropAffinityWaiters(id);
        worker.destroy();
      }
    }
  }
}
