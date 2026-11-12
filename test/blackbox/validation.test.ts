import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Gateway, startGateway } from "../helpers/gateway.js";

describe("request validation", () => {
  let gw: Gateway;
  before(async () => {
    gw = await startGateway();
  });
  after(async () => {
    await gw?.stop();
  });

  const boots = () => gw.acpLog().filter((e) => e.event === "boot").length;

  test("malformed messages are a 400 and do not cost a worker", async () => {
    const ok = await gw.chat({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "first" }] });
    assert.equal(ok.status, 200);
    const workerId = ok.headers.get("X-Agy2Api-Worker-Id");
    await ok.text();
    const bootsBefore = boots();

    for (const messages of [
      [{ role: "wizard", content: "hi" }],
      ["just a string"],
      [{ role: "user", content: "a" }, null],
    ]) {
      const res = await gw.chat({ model: "gemini-3.8-flash", messages });
      assert.equal(res.status, 400, JSON.stringify(messages));
      const body = (await res.json()) as any;
      assert.equal(body.error.type, "invalid_request_error");
    }

    const again = await gw.chat({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "second" }] });
    assert.equal(again.status, 200);
    assert.equal(again.headers.get("X-Agy2Api-Worker-Id"), workerId);
    await again.text();
    assert.equal(boots(), bootsBefore, "no worker was restarted");
  });

  test("function tools need a name; hosted tool entries are ignored", async () => {
    const missingName = await gw.chat({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { description: "no name" } }],
    });
    assert.equal(missingName.status, 400);

    const hosted = await gw.chat({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "hosted tools" }],
      tools: [{ type: "web_search_preview" }],
    });
    assert.equal(hosted.status, 200);
    const body = (await hosted.json()) as any;
    assert.match(body.choices[0].message.content, /^echo: hosted tools/);
  });
});
