import { unitTestHome } from "../helpers/isolate-env.js";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { TelemetryStore } from "../../src/telemetry/metrics-store.js";

describe("TelemetryStore", () => {
  test("persists requests, bounds the cache hit rate and closes stale sessions on reopen", () => {
    const dbPath = path.join(unitTestHome, "telemetry-test.db");
    const store = new TelemetryStore(dbPath);
    const rec = store.recordCompletedRequest({
      requestId: "req-1",
      timestamp: Date.now(),
      sessionId: "sess-1",
      workerId: "w-1",
      sessionCache: "HIT",
      requestedModel: "gemini-3.8-flash",
      resolvedBaseModel: "gemini-3.8-flash",
      thinkingLevel: "medium",
      acpModelId: "gemini-3.8-flash-medium",
      actualModelVersion: "gemini-3.8-flash",
      ttftMs: 500,
      durationMs: 1000,
      stream: true,
      finishReason: "stop",
      toolCallsCount: 0,
      inputTokens: 1000,
      cachedReadTokens: 9000,
      cachedWriteTokens: 0,
      outputTokens: 100,
      thoughtTokens: 50,
      totalTokens: 10150,
      status: "success",
    });
    // 9000 cached / (1000 uncached + 9000 cached)
    assert.equal(rec.cacheHitRate, 90);
    store.close();

    const reopened = new TelemetryStore(dbPath);
    const snap = reopened.getSnapshot();
    assert.equal(snap.summary.totalRequests, 1);
    assert.equal(snap.summary.cloudCacheHitRate, 90);
    assert.equal(snap.sessions[0].sessionId, "sess-1");
    assert.equal(snap.sessions[0].status, "CLOSED");
    reopened.close();
  });

  test("upgrades a database from before miss reasons and counts them", () => {
    const dbPath = path.join(unitTestHome, "telemetry-old.db");
    const old = new DatabaseSync(dbPath);
    // The requests table as the first release created it
    old.exec(`CREATE TABLE requests (
      request_id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, session_id TEXT NOT NULL,
      worker_id TEXT NOT NULL, session_cache TEXT NOT NULL, requested_model TEXT NOT NULL,
      resolved_base_model TEXT NOT NULL, thinking_level TEXT NOT NULL, acp_model_id TEXT NOT NULL,
      actual_model_version TEXT NOT NULL, ttft_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
      stream INTEGER NOT NULL, finish_reason TEXT NOT NULL, tool_calls_count INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL, cached_read_tokens INTEGER NOT NULL,
      cached_write_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      thought_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL, cache_hit_rate REAL NOT NULL,
      status TEXT NOT NULL, error_message TEXT)`);
    old.exec(`INSERT INTO requests VALUES ('old-1', 1, 's0', 'w0', 'MISS', 'm', 'm', 'medium', 'm',
      'm', 0, 0, 0, 'stop', 0, 0, 0, 0, 0, 0, 0, 0, 'success', NULL)`);
    old.close();

    const store = new TelemetryStore(dbPath);
    const base = {
      timestamp: Date.now(),
      workerId: "w",
      requestedModel: "m",
      resolvedBaseModel: "m",
      thinkingLevel: "medium" as const,
      acpModelId: "m",
      actualModelVersion: "m",
      ttftMs: 1,
      durationMs: 1,
      stream: false,
      finishReason: "stop",
      toolCallsCount: 0,
      inputTokens: 1,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      outputTokens: 1,
      thoughtTokens: 0,
      totalTokens: 2,
      status: "success" as const,
    };
    store.recordCompletedRequest({
      ...base,
      requestId: "r1",
      sessionId: "s1",
      sessionCache: "MISS",
      missReason: "worker_busy",
      toolParseFailures: 2,
    });
    store.recordCompletedRequest({
      ...base,
      requestId: "r2",
      sessionId: "s2",
      sessionCache: "MISS",
      missReason: "no_match",
    });
    store.recordCompletedRequest({ ...base, requestId: "r3", sessionId: "s1", sessionCache: "HIT" });

    const snap = store.getSnapshot();
    assert.equal(snap.summary.totalRequests, 4);
    assert.deepEqual(snap.summary.missReasons, { no_match: 1, worker_busy: 1 });
    assert.equal(snap.summary.toolParseFailures, 2);
    const r1 = snap.recentRequests.find((r) => r.requestId === "r1")!;
    assert.equal(r1.missReason, "worker_busy");
    assert.equal(r1.toolParseFailures, 2);
    assert.equal(snap.recentRequests.find((r) => r.requestId === "old-1")!.missReason, null);
    store.close();
  });
});
