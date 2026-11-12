import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  Gateway,
  requestWithHost,
  runGatewayExpectingExit,
  startGateway,
  TEST_API_KEY,
} from "../helpers/gateway.js";

describe("admin API and network exposure", () => {
  let gw: Gateway;
  before(async () => {
    gw = await startGateway();
  });
  after(async () => {
    await gw?.stop();
  });

  test("dashboard page and health probe are public but carry no secrets", async () => {
    const page = await gw.fetch("/", { auth: false });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('id="auth-dlg"'));
    assert.ok(!html.includes(TEST_API_KEY));

    const health = await gw.fetch("/health", { auth: false });
    assert.equal(health.status, 200);
    assert.deepEqual(Object.keys((await health.json()) as object).sort(), ["status", "workers"]);
  });

  test("admin endpoints require the API key", async () => {
    for (const [method, p] of [
      ["GET", "/api/admin/overview"],
      ["POST", "/api/admin/config"],
      ["POST", "/api/admin/workers/spawn"],
      ["POST", "/api/admin/sessions/clear-cache"],
      ["DELETE", "/api/admin/workers?id=x"],
      ["DELETE", "/api/admin/sessions?workerId=x&sessionId=y"],
    ]) {
      const res = await gw.fetch(p, { method, auth: false });
      assert.equal(res.status, 401, `${method} ${p}`);
    }
  });

  test("overview accepts X-Agy2Api-Key or Bearer and never echoes the key", async () => {
    const viaHeader = await gw.fetch("/api/admin/overview", {
      headers: { "X-Agy2Api-Key": TEST_API_KEY },
    });
    assert.equal(viaHeader.status, 200);
    const text = await viaHeader.text();
    assert.ok(!text.includes(TEST_API_KEY), "API key leaked in overview");
    const body = JSON.parse(text);
    assert.equal(body.config.apiKey, undefined);
    assert.equal(body.config.apiKeyIsDefault, false);

    const viaBearer = await gw.fetch("/api/admin/overview");
    assert.equal(viaBearer.status, 200);
  });

  test("state cannot be changed through GET (no ?_body= tunnel)", async () => {
    const before = (await (await gw.fetch("/api/admin/overview")).json()) as any;
    const res = await gw.fetch(
      `/api/admin/config?_body=${encodeURIComponent(JSON.stringify({ maxWorkers: 7 }))}`
    );
    assert.equal(res.status, 404);
    for (const p of ["/api/admin/workers/spawn", "/api/admin/sessions/clear-cache"]) {
      assert.equal((await gw.fetch(p)).status, 404, `GET ${p}`);
    }
    const afterCfg = (await (await gw.fetch("/api/admin/overview")).json()) as any;
    assert.equal(afterCfg.config.maxWorkers, before.config.maxWorkers);
  });

  test("POST config updates and persists settings without returning the key", async () => {
    const res = await gw.fetch("/api/admin/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxSessionsPerWorker: 5, sessionTtlMs: 120000 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.config.maxSessionsPerWorker, 5);
    assert.equal(body.config.apiKey, undefined);

    const saved = JSON.parse(fs.readFileSync(path.join(gw.home, "settings.json"), "utf-8"));
    assert.equal(saved.maxSessionsPerWorker, 5);
    assert.equal(saved.sessionTtlMs, 120000);
  });

  test("rejects foreign Host headers while bound to loopback (DNS rebinding)", async () => {
    assert.equal(await requestWithHost(gw.port, "/health", `evil.example:${gw.port}`), 403);
    assert.equal(await requestWithHost(gw.port, "/health", `localhost:${gw.port}`), 200);
    assert.equal(await requestWithHost(gw.port, "/health", `127.0.0.1:${gw.port}`), 200);
  });
});

describe("startup guards", () => {
  test("refuses to listen on a non-loopback address with the default API key", async () => {
    const { code, output } = await runGatewayExpectingExit({
      AGY2API_HOST: "0.0.0.0",
      AGY2API_KEY: "",
    });
    assert.equal(code, 1);
    assert.match(output, /Refusing to listen on 0\.0\.0\.0 with the default API key/);
  });
});
