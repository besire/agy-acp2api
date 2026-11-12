import "../helpers/isolate-env.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { runtimePaths } from "../../src/config.js";
import {
  cleanupWorkerSandbox,
  createWorkerSandbox,
  sweepStaleSandboxes,
} from "../../src/pool/sandbox.js";

describe("sandbox sweep", () => {
  test("removes only sandboxes whose owner is gone, or unowned ones older than a day", () => {
    const base = runtimePaths.geminiBaseDir;
    fs.mkdirSync(base, { recursive: true });
    const dir = (name: string) => path.join(base, name);
    const make = (name: string, owner?: number) => {
      fs.mkdirSync(dir(name), { recursive: true });
      if (owner !== undefined) {
        fs.writeFileSync(path.join(dir(name), ".agy2api-owner.json"), JSON.stringify({ pid: owner }));
      }
    };

    const mine = createWorkerSandbox("unit-mine");
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
    make("agy2api-worker-dead", deadPid);
    make("agy2api-worker-legacy-fresh");
    make("agy2api-worker-legacy-old");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    fs.utimesSync(dir("agy2api-worker-legacy-old"), twoDaysAgo, twoDaysAgo);
    make("antigravity-cli");

    try {
      sweepStaleSandboxes();
      const left = fs.readdirSync(base).sort();
      assert.deepEqual(left, ["agy2api-worker-legacy-fresh", "agy2api-worker-unit-mine", "antigravity-cli"]);
    } finally {
      cleanupWorkerSandbox(mine);
    }
  });
});
