import { unitTestHome } from "../helpers/isolate-env.js";
import assert from "node:assert/strict";
import path from "node:path";
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
});
