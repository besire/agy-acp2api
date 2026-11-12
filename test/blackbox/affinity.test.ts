import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Gateway, startGateway, waitFor } from "../helpers/gateway.js";

type Msg = { role: string; content: string };

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

/** One non-streaming turn; returns the reply and the session bookkeeping headers. */
async function turn(gw: Gateway, messages: Msg[], signal?: AbortSignal) {
  const res = await gw.fetch("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gemini-3.8-flash", messages }),
    signal,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  return {
    reply: { role: "assistant", content: body.choices[0].message.content as string },
    cache: res.headers.get("X-Agy2Api-Session-Cache"),
    sessionId: res.headers.get("X-Agy2Api-Session-Id")!,
  };
}

async function requestsOf(gw: Gateway, sessionId: string): Promise<any[]> {
  const ov = (await (await gw.fetch("/api/admin/overview")).json()) as any;
  return ov.telemetry.recentRequests.filter((r: any) => r.sessionId === sessionId);
}

const boots = (gw: Gateway) => gw.acpLog().filter((e) => e.event === "boot").length;

describe("session affinity", () => {
  test("a regenerated turn starts a new session instead of replaying into the old one", async () => {
    await withGateway({}, async (gw) => {
      const u1 = { role: "user", content: "first question" };
      const u2 = { role: "user", content: "second question" };
      const t1 = await turn(gw, [u1]);
      const t2 = await turn(gw, [u1, t1.reply, u2]);
      assert.equal(t2.cache, "HIT");
      assert.equal(t2.sessionId, t1.sessionId);

      // The session already holds u2 and its answer; sending u2 to it again would duplicate it
      const regen = await turn(gw, [u1, t1.reply, u2]);
      assert.equal(regen.cache, "MISS");
      assert.notEqual(regen.sessionId, t1.sessionId);
      const [prompt] = gw
        .acpRequests("session/prompt")
        .filter((m) => m.params.sessionId === regen.sessionId);
      assert.match(prompt.params.prompt[0].text, /first question[\s\S]*second question/);

      // Both branches stay continuable from their own head
      const onOld = await turn(gw, [u1, t1.reply, u2, t2.reply, { role: "user", content: "a" }]);
      assert.equal(onOld.cache, "HIT");
      assert.equal(onOld.sessionId, t1.sessionId);
      const onNew = await turn(gw, [u1, t1.reply, u2, regen.reply, { role: "user", content: "b" }]);
      assert.equal(onNew.cache, "HIT");
      assert.equal(onNew.sessionId, regen.sessionId);

      assert.equal((await requestsOf(gw, t1.sessionId)).at(-1).missReason, "new_conversation");
      assert.equal((await requestsOf(gw, regen.sessionId)).at(-1).missReason, "no_match");
    });
  });

  test("a turn the client abandons discards its session; the retry starts clean", async () => {
    await withGateway({}, async (gw) => {
      const u1 = { role: "user", content: "hello" };
      const t1 = await turn(gw, [u1]);

      const ac = new AbortController();
      const hung = turn(gw, [u1, t1.reply, { role: "user", content: "[[hang]]" }], ac.signal);
      await waitFor(
        () =>
          gw
            .acpRequests("session/prompt")
            .some((m) => m.params.sessionId === t1.sessionId && /hang/.test(m.params.prompt[0].text)),
        { what: "the hanging prompt" }
      );
      ac.abort();
      await assert.rejects(hung);

      await waitFor(
        () => gw.acpRequests("session/close").some((m) => m.params.sessionId === t1.sessionId),
        { what: "session/close for the abandoned session" }
      );
      const retry = await turn(gw, [u1, t1.reply, { role: "user", content: "try again" }]);
      assert.equal(retry.cache, "MISS");
      assert.notEqual(retry.sessionId, t1.sessionId);
    });
  });

  test("waits for the busy worker holding the session instead of replaying history elsewhere", async () => {
    await withGateway({ env: { AGY_MAX_WORKERS: "2" } }, async (gw) => {
      const u1 = { role: "user", content: "conversation A" };
      const a1 = await turn(gw, [u1]);

      // Another conversation occupies the same (only) worker for a while
      const other = turn(gw, [{ role: "user", content: "conversation B [[slow:800]]" }]);
      await waitFor(
        () => gw.acpRequests("session/prompt").some((m) => /slow/.test(m.params.prompt[0].text)),
        { what: "conversation B to start" }
      );

      const a2 = await turn(gw, [u1, a1.reply, { role: "user", content: "follow-up" }]);
      await other;
      assert.equal(a2.cache, "HIT");
      assert.equal(a2.sessionId, a1.sessionId);
      assert.equal(boots(gw), 1, "no burst worker was needed");
    });
  });

  test("a request that queued earlier is served before a later affinity wait", async () => {
    await withGateway({ env: { AGY_MAX_WORKERS: "1" } }, async (gw) => {
      const u1 = { role: "user", content: "conversation A" };
      const a1 = await turn(gw, [u1]);
      const started = (text: RegExp) =>
        gw.acpRequests("session/prompt").findIndex((m) => text.test(m.params.prompt[0].text));

      const busy = turn(gw, [{ role: "user", content: "conversation B [[slow:600]]" }]);
      await waitFor(() => started(/conversation B/) !== -1, { what: "conversation B to start" });
      // C queues for any worker first, then A's follow-up waits for its own session's worker
      const c = turn(gw, [{ role: "user", content: "conversation C" }]);
      await new Promise((r) => setTimeout(r, 100));
      const a2 = turn(gw, [u1, a1.reply, { role: "user", content: "follow-up A" }]);

      const [, , second] = await Promise.all([busy, c, a2]);
      assert.ok(started(/conversation C/) < started(/follow-up A/), "C was waiting longer");
      assert.equal(second.cache, "HIT");
      assert.equal(second.sessionId, a1.sessionId);
    });
  });

  test("gives up after the affinity wait and records why", async () => {
    await withGateway({ env: { AGY_MAX_WORKERS: "2", AGY2API_AFFINITY_WAIT_MS: "100" } }, async (gw) => {
      const u1 = { role: "user", content: "conversation A" };
      const a1 = await turn(gw, [u1]);

      const other = turn(gw, [{ role: "user", content: "conversation B [[slow:1500]]" }]);
      await waitFor(
        () => gw.acpRequests("session/prompt").some((m) => /slow/.test(m.params.prompt[0].text)),
        { what: "conversation B to start" }
      );

      const a2 = await turn(gw, [u1, a1.reply, { role: "user", content: "follow-up" }]);
      assert.equal(a2.cache, "MISS");
      assert.notEqual(a2.sessionId, a1.sessionId);
      assert.equal((await requestsOf(gw, a2.sessionId)).at(-1).missReason, "worker_busy");
      await other;

      const ov = (await (await gw.fetch("/api/admin/overview")).json()) as any;
      assert.equal(ov.telemetry.summary.missReasons.worker_busy, 1);
    });
  });
});
