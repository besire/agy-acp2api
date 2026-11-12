import "../helpers/isolate-env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "node:test";
import { config, runtimePaths } from "../../src/config.js";
import { PoolUnavailableError, WorkerPool } from "../../src/pool/worker-pool.js";
import { FAKE_AGY } from "../helpers/gateway.js";

describe("WorkerPool", () => {
  test("does not start workers once it is shutting down", async () => {
    // A spawn would succeed, so only the shutdown guard can make these fail
    config.agyBin = FAKE_AGY;
    const pool = new WorkerPool();
    pool.shutdown();
    await assert.rejects(pool.acquireFresh([]), PoolUnavailableError);
    await assert.rejects(
      pool.acquireForRequest("m", [], [{ role: "user", content: [{ type: "text", text: "x" }] }]),
      PoolUnavailableError
    );
    const sandboxes = fs.existsSync(runtimePaths.geminiBaseDir)
      ? fs.readdirSync(runtimePaths.geminiBaseDir).filter((e) => e.startsWith("agy2api-worker-"))
      : [];
    assert.deepEqual(sandboxes, [], "no worker sandbox was created");
  });
});
