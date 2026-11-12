import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runtimePaths, ThinkingLevel } from "../config.js";

export interface RequestTelemetryRecord {
  requestId: string;
  timestamp: number;
  sessionId: string;
  workerId: string;
  sessionCache: "HIT" | "MISS";
  /** Why a MISS could not continue a warm session (see `MissReason`); null on a HIT. */
  missReason?: string | null;
  requestedModel: string;
  resolvedBaseModel: string;
  thinkingLevel: ThinkingLevel;
  acpModelId: string;
  actualModelVersion: string;
  ttftMs: number;
  durationMs: number;
  stream: boolean;
  finishReason: string;
  toolCallsCount: number;
  /** `<tool_call>` blocks in the reply that could not be parsed. */
  toolParseFailures?: number;
  inputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  cacheHitRate: number;
  status: "success" | "error";
  errorMessage?: string;
}

export interface SessionTelemetryRecord {
  sessionId: string;
  workerId: string;
  baseModelId: string;
  lastAcpModelId: string;
  lastThinkingLevel: ThinkingLevel;
  lastActualModelVersion: string;
  createdAt: number;
  lastActiveAt: number;
  status: "ACTIVE" | "CLOSED";
  turns: number;
  hashHits: number;
  inputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  cacheHitRate: number;
  avgTtftMs: number;
  totalTtftMs: number;
}

const DEFAULT_DB_PATH = path.join(runtimePaths.dataDir, "telemetry.db");

export class TelemetryStore {
  private db: DatabaseSync;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        base_model_id TEXT NOT NULL,
        last_acp_model_id TEXT NOT NULL,
        last_thinking_level TEXT NOT NULL,
        last_actual_model_version TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        turns INTEGER NOT NULL DEFAULT 0,
        hash_hits INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_read_tokens INTEGER NOT NULL DEFAULT 0,
        cached_write_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        thought_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cache_hit_rate REAL NOT NULL DEFAULT 0,
        avg_ttft_ms INTEGER NOT NULL DEFAULT 0,
        total_ttft_ms INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        session_cache TEXT NOT NULL,
        requested_model TEXT NOT NULL,
        resolved_base_model TEXT NOT NULL,
        thinking_level TEXT NOT NULL,
        acp_model_id TEXT NOT NULL,
        actual_model_version TEXT NOT NULL,
        ttft_ms INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        stream INTEGER NOT NULL,
        finish_reason TEXT NOT NULL,
        tool_calls_count INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        cached_read_tokens INTEGER NOT NULL,
        cached_write_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        thought_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        cache_hit_rate REAL NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_requests_session_id ON requests(session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active_at DESC);
    `);

    // Columns added after the first release; older databases get them on startup
    const requestColumns = new Set(
      (this.db.prepare(`PRAGMA table_info(requests)`).all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    );
    if (!requestColumns.has("miss_reason")) {
      this.db.exec(`ALTER TABLE requests ADD COLUMN miss_reason TEXT`);
    }
    if (!requestColumns.has("tool_parse_failures")) {
      this.db.exec(
        `ALTER TABLE requests ADD COLUMN tool_parse_failures INTEGER NOT NULL DEFAULT 0`
      );
    }

    // Any sessions left ACTIVE from a previous process run are now CLOSED
    this.db.exec(`UPDATE sessions SET status = 'CLOSED' WHERE status = 'ACTIVE'`);
  }

  public registerNewSession(
    sessionId: string,
    workerId: string,
    baseModelId: string,
    acpModelId: string,
    thinkingLevel: ThinkingLevel
  ): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO sessions (
        session_id, worker_id, base_model_id, last_acp_model_id,
        last_thinking_level, last_actual_model_version, created_at,
        last_active_at, status, turns, hash_hits, input_tokens,
        cached_read_tokens, cached_write_tokens, output_tokens,
        thought_tokens, total_tokens, cache_hit_rate, avg_ttft_ms, total_ttft_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    `);
    stmt.run(
      sessionId,
      workerId,
      baseModelId,
      acpModelId,
      thinkingLevel,
      baseModelId,
      now,
      now
    );
  }

  public markSessionClosed(sessionId: string): void {
    const stmt = this.db.prepare(`
      UPDATE sessions
      SET status = 'CLOSED', last_active_at = ?
      WHERE session_id = ?
    `);
    stmt.run(Date.now(), sessionId);
  }

  public markWorkerSessionsClosed(workerId: string): void {
    const stmt = this.db.prepare(`
      UPDATE sessions
      SET status = 'CLOSED', last_active_at = ?
      WHERE worker_id = ? AND status = 'ACTIVE'
    `);
    stmt.run(Date.now(), workerId);
  }

  public recordCompletedRequest(
    rec: Omit<RequestTelemetryRecord, "cacheHitRate">
  ): RequestTelemetryRecord {
    const reqTotalPrompt =
      rec.inputTokens + rec.cachedReadTokens + rec.cachedWriteTokens;
    const cacheHitRate =
      reqTotalPrompt > 0
        ? Number(((rec.cachedReadTokens / reqTotalPrompt) * 100).toFixed(1))
        : 0;

    const fullRec: RequestTelemetryRecord = {
      ...rec,
      cacheHitRate,
    };

    // 1. Ensure session exists in `sessions` table
    this.registerNewSession(
      rec.sessionId,
      rec.workerId,
      rec.resolvedBaseModel,
      rec.acpModelId,
      rec.thinkingLevel
    );

    // 2. Insert request row into `requests` table
    const insertReqStmt = this.db.prepare(`
      INSERT OR REPLACE INTO requests (
        request_id, timestamp, session_id, worker_id, session_cache,
        requested_model, resolved_base_model, thinking_level, acp_model_id,
        actual_model_version, ttft_ms, duration_ms, stream, finish_reason,
        tool_calls_count, input_tokens, cached_read_tokens, cached_write_tokens,
        output_tokens, thought_tokens, total_tokens, cache_hit_rate, status, error_message,
        miss_reason, tool_parse_failures
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertReqStmt.run(
      fullRec.requestId,
      fullRec.timestamp,
      fullRec.sessionId,
      fullRec.workerId,
      fullRec.sessionCache,
      fullRec.requestedModel,
      fullRec.resolvedBaseModel,
      fullRec.thinkingLevel,
      fullRec.acpModelId,
      fullRec.actualModelVersion,
      fullRec.ttftMs,
      fullRec.durationMs,
      fullRec.stream ? 1 : 0,
      fullRec.finishReason,
      fullRec.toolCallsCount,
      fullRec.inputTokens,
      fullRec.cachedReadTokens,
      fullRec.cachedWriteTokens,
      fullRec.outputTokens,
      fullRec.thoughtTokens,
      fullRec.totalTokens,
      fullRec.cacheHitRate,
      fullRec.status,
      fullRec.errorMessage ?? null,
      fullRec.missReason ?? null,
      fullRec.toolParseFailures ?? 0
    );

    // 3. Read current session totals and update atomically
    const getSessStmt = this.db.prepare(`
      SELECT turns, hash_hits, input_tokens, cached_read_tokens, cached_write_tokens,
             output_tokens, thought_tokens, total_tokens, total_ttft_ms
      FROM sessions WHERE session_id = ?
    `);
    const existing = getSessStmt.get(rec.sessionId) as Record<string, number> | undefined;

    if (existing) {
      const turns = (existing.turns || 0) + 1;
      const hashHits = (existing.hash_hits || 0) + (rec.sessionCache === "HIT" ? 1 : 0);
      const inputTokens = (existing.input_tokens || 0) + rec.inputTokens;
      const cachedReadTokens = (existing.cached_read_tokens || 0) + rec.cachedReadTokens;
      const cachedWriteTokens = (existing.cached_write_tokens || 0) + rec.cachedWriteTokens;
      const outputTokens = (existing.output_tokens || 0) + rec.outputTokens;
      const thoughtTokens = (existing.thought_tokens || 0) + rec.thoughtTokens;
      const totalTokens = (existing.total_tokens || 0) + rec.totalTokens;
      const totalTtftMs = (existing.total_ttft_ms || 0) + (rec.ttftMs > 0 ? rec.ttftMs : 0);
      const avgTtftMs = turns > 0 ? Math.round(totalTtftMs / turns) : 0;

      const sessTotalPrompt = inputTokens + cachedReadTokens + cachedWriteTokens;
      const sessCacheHitRate =
        sessTotalPrompt > 0
          ? Number(((cachedReadTokens / sessTotalPrompt) * 100).toFixed(1))
          : 0;

      const updateSessStmt = this.db.prepare(`
        UPDATE sessions
        SET last_active_at = ?,
            last_acp_model_id = ?,
            last_thinking_level = ?,
            last_actual_model_version = ?,
            turns = ?,
            hash_hits = ?,
            input_tokens = ?,
            cached_read_tokens = ?,
            cached_write_tokens = ?,
            output_tokens = ?,
            thought_tokens = ?,
            total_tokens = ?,
            cache_hit_rate = ?,
            avg_ttft_ms = ?,
            total_ttft_ms = ?
        WHERE session_id = ?
      `);

      updateSessStmt.run(
        rec.timestamp,
        rec.acpModelId,
        rec.thinkingLevel,
        rec.actualModelVersion || rec.resolvedBaseModel,
        turns,
        hashHits,
        inputTokens,
        cachedReadTokens,
        cachedWriteTokens,
        outputTokens,
        thoughtTokens,
        totalTokens,
        sessCacheHitRate,
        avgTtftMs,
        totalTtftMs,
        rec.sessionId
      );
    }

    return fullRec;
  }

  public getSnapshot() {
    const summaryRow = this.db
      .prepare(
        `
      SELECT
        COUNT(*) AS totalRequests,
         COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS successfulRequests,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS failedRequests,
        COALESCE(SUM(CASE WHEN session_cache = 'HIT' THEN 1 ELSE 0 END), 0) AS sessionCacheHits,
        COALESCE(SUM(CASE WHEN session_cache = 'MISS' THEN 1 ELSE 0 END), 0) AS sessionCacheMisses,
        COALESCE(AVG(CASE WHEN ttft_ms > 0 THEN ttft_ms ELSE NULL END), 0) AS avgTtftMs,
        COALESCE(SUM(input_tokens), 0) AS totalInputTokens,
        COALESCE(SUM(cached_read_tokens), 0) AS totalCachedReadTokens,
        COALESCE(SUM(cached_write_tokens), 0) AS totalCachedWriteTokens,
        COALESCE(SUM(output_tokens), 0) AS totalOutputTokens,
        COALESCE(SUM(thought_tokens), 0) AS totalThoughtTokens,
        COALESCE(SUM(total_tokens), 0) AS totalTokens,
        COALESCE(SUM(tool_parse_failures), 0) AS toolParseFailures
      FROM requests
    `
      )
      .get() as Record<string, number>;

    const missReasons: Record<string, number> = {};
    for (const row of this.db
      .prepare(
        `SELECT miss_reason AS reason, COUNT(*) AS n FROM requests
         WHERE session_cache = 'MISS' AND miss_reason IS NOT NULL GROUP BY miss_reason`
      )
      .all() as Array<{ reason: string; n: number }>) {
      missReasons[row.reason] = Number(row.n);
    }

    const totalRequests = Number(summaryRow?.totalRequests ?? 0);
    const successfulRequests = Number(summaryRow?.successfulRequests ?? 0);
    const failedRequests = Number(summaryRow?.failedRequests ?? 0);
    const sessionCacheHits = Number(summaryRow?.sessionCacheHits ?? 0);
    const sessionCacheMisses = Number(summaryRow?.sessionCacheMisses ?? 0);
    const avgTtftMs = Math.round(Number(summaryRow?.avgTtftMs ?? 0));
    const totalInputTokens = Number(summaryRow?.totalInputTokens ?? 0);
    const totalCachedReadTokens = Number(summaryRow?.totalCachedReadTokens ?? 0);
    const totalCachedWriteTokens = Number(summaryRow?.totalCachedWriteTokens ?? 0);
    const totalOutputTokens = Number(summaryRow?.totalOutputTokens ?? 0);
    const totalThoughtTokens = Number(summaryRow?.totalThoughtTokens ?? 0);
    const totalTokens = Number(summaryRow?.totalTokens ?? 0);

    const globalTotalPrompt =
      totalInputTokens + totalCachedReadTokens + totalCachedWriteTokens;
    const cloudCacheHitRate =
      globalTotalPrompt > 0
        ? Number(((totalCachedReadTokens / globalTotalPrompt) * 100).toFixed(1))
        : 0;

    const sessionHashHitRate =
      totalRequests > 0
        ? Number(((sessionCacheHits / totalRequests) * 100).toFixed(1))
        : 0;

    const rawSessions = this.db
      .prepare(
        `
      SELECT * FROM sessions
      ORDER BY last_active_at DESC
      LIMIT 100
    `
      )
      .all() as Array<Record<string, any>>;

    const sessions: SessionTelemetryRecord[] = rawSessions.map((row) => ({
      sessionId: String(row.session_id),
      workerId: String(row.worker_id),
      baseModelId: String(row.base_model_id),
      lastAcpModelId: String(row.last_acp_model_id),
      lastThinkingLevel: row.last_thinking_level as ThinkingLevel,
      lastActualModelVersion: String(row.last_actual_model_version),
      createdAt: Number(row.created_at),
      lastActiveAt: Number(row.last_active_at),
      status: row.status as "ACTIVE" | "CLOSED",
      turns: Number(row.turns),
      hashHits: Number(row.hash_hits),
      inputTokens: Number(row.input_tokens),
      cachedReadTokens: Number(row.cached_read_tokens),
      cachedWriteTokens: Number(row.cached_write_tokens),
      outputTokens: Number(row.output_tokens),
      thoughtTokens: Number(row.thought_tokens),
      totalTokens: Number(row.total_tokens),
      cacheHitRate: Number(row.cache_hit_rate),
      avgTtftMs: Number(row.avg_ttft_ms),
      totalTtftMs: Number(row.total_ttft_ms),
    }));

    const rawRequests = this.db
      .prepare(
        `
      SELECT * FROM requests
      ORDER BY timestamp DESC
      LIMIT 100
    `
      )
      .all() as Array<Record<string, any>>;

    const recentRequests: RequestTelemetryRecord[] = rawRequests.map((row) => ({
      requestId: String(row.request_id),
      timestamp: Number(row.timestamp),
      sessionId: String(row.session_id),
      workerId: String(row.worker_id),
      sessionCache: row.session_cache as "HIT" | "MISS",
      missReason: row.miss_reason == null ? null : String(row.miss_reason),
      requestedModel: String(row.requested_model),
      resolvedBaseModel: String(row.resolved_base_model),
      thinkingLevel: row.thinking_level as ThinkingLevel,
      acpModelId: String(row.acp_model_id),
      actualModelVersion: String(row.actual_model_version),
      ttftMs: Number(row.ttft_ms),
      durationMs: Number(row.duration_ms),
      stream: Boolean(row.stream),
      finishReason: String(row.finish_reason),
      toolCallsCount: Number(row.tool_calls_count),
      toolParseFailures: Number(row.tool_parse_failures ?? 0),
      inputTokens: Number(row.input_tokens),
      cachedReadTokens: Number(row.cached_read_tokens),
      cachedWriteTokens: Number(row.cached_write_tokens),
      outputTokens: Number(row.output_tokens),
      thoughtTokens: Number(row.thought_tokens),
      totalTokens: Number(row.total_tokens),
      cacheHitRate: Number(row.cache_hit_rate),
      status: row.status as "success" | "error",
      ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
    }));

    return {
      summary: {
        totalRequests,
        successfulRequests,
        failedRequests,
        sessionCacheHits,
        sessionCacheMisses,
        sessionHashHitRate,
        cloudCacheHitRate,
        avgTtftMs,
        totalInputTokens,
        totalCachedReadTokens,
        totalCachedWriteTokens,
        totalOutputTokens,
        totalThoughtTokens,
        totalTokens,
        missReasons,
        toolParseFailures: Number(summaryRow?.toolParseFailures ?? 0),
      },
      sessions,
      recentRequests,
    };
  }

  public close(): void {
    try {
      this.db.close();
    } catch {}
  }
}

export const telemetryStore = new TelemetryStore();
