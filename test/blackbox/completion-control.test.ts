import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Gateway, readSse, startGateway, waitFor } from "../helpers/gateway.js";

describe("finish reasons, stop sequences and tool names", () => {
  let gw: Gateway;
  before(async () => {
    gw = await startGateway();
  });
  after(async () => {
    await gw?.stop();
  });

  const user = (content: string) => [{ role: "user", content }];
  const responses = (body: Record<string, unknown>) =>
    gw.fetch("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini-3.8-flash", store: false, ...body }),
    });

  test("upstream max_tokens and refusal map to length and content_filter", async () => {
    for (const [reason, expected] of [
      ["max_tokens", "length"],
      ["refusal", "content_filter"],
      ["end_turn", "stop"],
    ]) {
      const res = await gw.chat({ model: "gemini-3.8-flash", messages: user(`hi [[stop:${reason}]]`) });
      const body = (await res.json()) as any;
      assert.equal(body.choices[0].finish_reason, expected, reason);

      const streamed = await readSse(
        await gw.chat({ model: "gemini-3.8-flash", stream: true, messages: user(`hi [[stop:${reason}]]`) })
      );
      assert.equal(streamed.finishReason, expected, `${reason} (stream)`);
    }
  });

  test("responses: a truncated or refused turn is incomplete, with the reason", async () => {
    const res = await responses({ input: "hi [[stop:max_tokens]]" });
    const body = (await res.json()) as any;
    assert.equal(body.status, "incomplete");
    assert.deepEqual(body.incomplete_details, { reason: "max_output_tokens" });

    const stream = await (await responses({ input: "hi [[stop:refusal]]", stream: true })).text();
    const events = stream
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5)));
    const last = events.at(-1);
    assert.equal(last.type, "response.incomplete");
    assert.equal(last.response.status, "incomplete");
    assert.deepEqual(last.response.incomplete_details, { reason: "content_filter" });
  });

  test("stop sequences cut the reply, even across chunk boundaries", async () => {
    // The fake echoes "echo: abcdefghij" in two chunks split after "echo: ab"
    const res = await gw.chat({ model: "gemini-3.8-flash", messages: user("abcdefghij"), stop: ["bcd", "zzz"] });
    const body = (await res.json()) as any;
    assert.equal(body.choices[0].message.content, "echo: a");
    assert.equal(body.choices[0].finish_reason, "stop");

    const streamed = await readSse(
      await gw.chat({ model: "gemini-3.8-flash", stream: true, messages: user("abcdefghij"), stop: "fgh" })
    );
    assert.equal(streamed.content, "echo: abcde");
    assert.equal(streamed.finishReason, "stop");
  });

  test("hitting a stop sequence cancels the turn upstream and retires its session", async () => {
    const started = Date.now();
    const res = await gw.chat({
      model: "gemini-3.8-flash",
      messages: user("dots [[slow:3000]]"),
      stop: ["..."],
    });
    const body = (await res.json()) as any;
    const sessionId = res.headers.get("X-Agy2Api-Session-Id");
    assert.equal(body.choices[0].message.content, "");
    assert.ok(Date.now() - started < 2500, "did not wait for the whole slow turn");
    assert.ok(gw.acpRequests("session/cancel").some((m) => m.params.sessionId === sessionId));
    await waitFor(
      () => gw.acpRequests("session/close").some((m) => m.params.sessionId === sessionId),
      { what: "session/close for the cut-short session" }
    );
  });

  test("an invalid stop parameter is a 400", async () => {
    for (const stop of [42, ["a", "b", "c", "d", "e"], [1]]) {
      const res = await gw.chat({ model: "gemini-3.8-flash", messages: user("x"), stop });
      assert.equal(res.status, 400, JSON.stringify(stop));
      const body = (await res.json()) as any;
      assert.equal(body.error.type, "invalid_request_error");
    }
  });

  test("namespaced or differently-cased tool names are mapped to the declared tool", async () => {
    const tools = [
      { type: "function", function: { name: "get_weather", parameters: { type: "object" } } },
    ];
    for (const written of ["functions.get_weather", "default_api:get_weather", "Get_Weather"]) {
      const res = await gw.chat({
        model: "gemini-3.8-flash",
        tools,
        messages: user(`[[tool:${written}:{"city":"Paris"}]]`),
      });
      const body = (await res.json()) as any;
      assert.equal(body.choices[0].message.tool_calls[0].function.name, "get_weather", written);
    }
  });
});
