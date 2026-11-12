import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Gateway, startGateway, waitFor } from "../helpers/gateway.js";

async function withGateway(
  opts: Parameters<typeof startGateway>[0],
  fn: (gw: Gateway) => Promise<void>
) {
  const gw = await startGateway(opts);
  try {
    await fn(gw);
  } catch (err) {
    console.error(`--- gateway output ---\n${gw.output()}`);
    throw err;
  } finally {
    await gw.stop();
  }
}

async function overview(gw: Gateway): Promise<any> {
  return (await gw.fetch("/api/admin/overview")).json();
}

function ask(gw: Gateway, content: string) {
  return gw.chat({ model: "gemini-3.8-flash", messages: [{ role: "user", content }] });
}

describe("worker and session lifecycle", () => {
  test("closes ACP sessions that stay idle past sessionTtlMs", async () => {
    await withGateway({ env: { AGY_SESSION_TTL_MS: "300" } }, async (gw) => {
      const res = await ask(gw, "short lived");
      assert.equal(res.status, 200);
      const sessionId = res.headers.get("X-Agy2Api-Session-Id");
      await res.arrayBuffer();

      await waitFor(
        () => gw.acpRequests("session/close").some((m) => m.params.sessionId === sessionId),
        { what: "session/close for the idle session" }
      );
      const ov = await overview(gw);
      assert.equal(ov.workers[0].activeSessionCount, 0);
    });
  });

  test("evicts the least recently used session beyond maxSessionsPerWorker", async () => {
    await withGateway(
      { env: { AGY_MAX_SESSIONS_PER_WORKER: "2", AGY_MAX_WORKERS: "1" } },
      async (gw) => {
        const ids: string[] = [];
        for (const topic of ["first", "second", "third"]) {
          const res = await ask(gw, `conversation ${topic}`);
          assert.equal(res.status, 200);
          ids.push(res.headers.get("X-Agy2Api-Session-Id")!);
          await res.arrayBuffer();
        }
        assert.equal(new Set(ids).size, 3);

        const closed = gw.acpRequests("session/close").map((m) => m.params.sessionId);
        assert.deepEqual(closed, [ids[0]], "only the oldest session is evicted");
        const ov = await overview(gw);
        assert.deepEqual(ov.workers[0].activeSessions.sort(), [ids[1], ids[2]].sort());
      }
    );
  });

  test("cancels the upstream turn when a request times out, and keeps serving", async () => {
    await withGateway({ env: { AGY_REQUEST_TIMEOUT_MS: "300" } }, async (gw) => {
      const res = await ask(gw, "never finishes [[hang]]");
      assert.equal(res.status, 500);
      const body = (await res.json()) as any;
      assert.match(body.error.message, /timed out after 300ms/);

      const prompt = gw.acpRequests("session/prompt").at(-1)!;
      await waitFor(
        () =>
          gw
            .acpRequests("session/cancel")
            .some((m) => m.params.sessionId === prompt.params.sessionId),
        { what: "session/cancel after timeout" }
      );

      const next = await ask(gw, "still alive?");
      assert.equal(next.status, 200);
    });
  });

  test("cancels the upstream turn when a streaming client disconnects", async () => {
    await withGateway({}, async (gw) => {
      const controller = new AbortController();
      const res = await gw.fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gemini-3.8-flash",
          stream: true,
          messages: [{ role: "user", content: "long answer [[slow:5000]]" }],
        }),
        signal: controller.signal,
      });
      const sessionId = res.headers.get("X-Agy2Api-Session-Id");
      const reader = res.body!.getReader();
      await reader.read();
      controller.abort();

      await waitFor(
        () => gw.acpRequests("session/cancel").some((m) => m.params.sessionId === sessionId),
        { what: "session/cancel after client disconnect" }
      );
    });
  });

  test("a crashing worker surfaces its stderr and is replaced", async () => {
    await withGateway({}, async (gw) => {
      const bootsBefore = gw.acpLog().filter((e) => e.event === "boot").length;
      const res = await ask(gw, "boom [[crash]]");
      assert.equal(res.status, 500);
      const body = (await res.json()) as any;
      assert.match(body.error.message, /exited unexpectedly \(code=3/);
      assert.match(body.error.message, /fake-agy: simulated crash/);

      await waitFor(
        async () => (await overview(gw)).pool.idleWorkers > 0,
        { what: "replacement worker" }
      );
      assert.ok(gw.acpLog().filter((e) => e.event === "boot").length > bootsBefore);
      const ok = await ask(gw, "after crash");
      assert.equal(ok.status, 200);
    });
  });

  test("backs off while agy cannot start, answers 503, then recovers", async () => {
    await withGateway(
      {
        fakeControl: { mode: "fail-start" },
        waitForWorkers: false,
        env: { AGY_RESPAWN_BASE_DELAY_MS: "100", AGY_RESPAWN_MAX_DELAY_MS: "400" },
      },
      async (gw) => {
        await new Promise((r) => setTimeout(r, 1500));
        const boots = gw.acpLog().filter((e) => e.event === "boot").length;
        // Backoff 100/200/400/400/... ms gives ~5 attempts in 1.5s; a hot loop would give hundreds
        assert.ok(boots >= 2 && boots <= 10, `expected backoff, saw ${boots} start attempts`);

        const res = await ask(gw, "anyone there?");
        assert.equal(res.status, 503);
        const body = (await res.json()) as any;
        assert.equal(body.error.type, "service_unavailable");
        assert.match(body.error.message, /not logged in/);

        const ov = await overview(gw);
        assert.ok(ov.pool.consecutiveSpawnFailures >= 2);
        assert.match(ov.pool.lastWorkerError, /not logged in/);

        gw.setFakeControl({});
        await waitFor(async () => (await overview(gw)).pool.idleWorkers > 0, {
          what: "recovery after agy becomes usable",
        });
        const ok = await ask(gw, "back online");
        assert.equal(ok.status, 200);
      }
    );
  });
});
