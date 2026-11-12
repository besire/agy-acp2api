import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Gateway, readSse, startGateway } from "../helpers/gateway.js";

const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Weather lookup",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

describe("OpenAI chat completions API", () => {
  let gw: Gateway;
  before(async () => {
    gw = await startGateway();
  });
  after(async () => {
    await gw?.stop();
  });

  test("rejects requests without a valid API key", async () => {
    const res = await gw.fetch("/v1/models", { auth: false });
    assert.equal(res.status, 401);
    const wrong = await gw.fetch("/v1/models", {
      headers: { Authorization: "Bearer sk-wrong" },
    });
    assert.equal(wrong.status, 401);
  });

  test("lists unified base models", async () => {
    const res = await gw.fetch("/v1/models");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<{ id: string; thinking_levels: string[] }> };
    const flash = body.data.find((m) => m.id === "gemini-3.8-flash");
    assert.ok(flash, "gemini-3.8-flash listed");
    assert.deepEqual(flash.thinking_levels, ["low", "medium", "high"]);
  });

  test("non-streaming completion returns content, reasoning and consistent usage", async () => {
    const res = await gw.chat({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "hello non-stream" }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Agy2Api-Session-Cache"), "MISS");
    const body = (await res.json()) as any;
    const choice = body.choices[0];
    assert.match(choice.message.content, /^echo: hello non-stream/);
    assert.equal(choice.message.reasoning_content, "thinking...");
    assert.equal(choice.finish_reason, "stop");
    assert.equal(
      body.usage.prompt_tokens + body.usage.completion_tokens,
      body.usage.total_tokens
    );
    assert.equal(body.usage.prompt_tokens_details.cached_tokens, 3);
  });

  test("resolves the thinking level from a model-name suffix", async () => {
    const res = await gw.chat({
      model: "gemini-4-carbon(high)",
      messages: [{ role: "user", content: "suffix" }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Agy2Api-Resolved-Model"), "gemini-4-carbon");
    assert.equal(res.headers.get("X-Agy2Api-Thinking-Level"), "high");
    await res.arrayBuffer();

    const sessionId = res.headers.get("X-Agy2Api-Session-Id");
    const setModel = gw
      .acpRequests("session/set_model")
      .find((m) => m.params.sessionId === sessionId);
    assert.equal(setModel?.params.modelId, "gemini-4-carbon-high");
  });

  test("streams a tool call, then reuses the session and sends only the delta", async () => {
    const messages: any[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: 'weather please [[tool:get_weather:{"city":"Shanghai"}]]' },
    ];

    const res1 = await gw.chat({ model: "gemini-3.8-flash", messages, tools, stream: true });
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get("X-Agy2Api-Session-Cache"), "MISS");
    const sessionId = res1.headers.get("X-Agy2Api-Session-Id");
    const turn1 = await readSse(res1);

    assert.equal(turn1.finishReason, "tool_calls");
    assert.equal(turn1.content, "Calling a tool. ");
    assert.equal(turn1.reasoning, "thinking...");
    assert.equal(turn1.toolCalls.length, 1);
    const call = turn1.toolCalls[0];
    assert.equal(call.function?.name, "get_weather");
    assert.deepEqual(JSON.parse(call.function?.arguments || ""), { city: "Shanghai" });
    assert.ok(turn1.sawDone);

    // The system prompt + tool schema go into session/new, not into the prompt
    const created = gw.acpRequests("session/new").at(-1)!;
    const append = created.params._meta.antigravity.systemPrompt.append as string;
    assert.match(append, /Use tools\./);
    assert.match(append, /"name":"get_weather"/);

    messages.push(
      {
        role: "assistant",
        content: turn1.content,
        tool_calls: [
          {
            id: call.id,
            type: "function",
            function: { name: "get_weather", arguments: call.function?.arguments },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: call.id,
        name: "get_weather",
        content: '{"code":"OMEGA-7"}',
      }
    );

    // Different effort on purpose: affinity is keyed on the base model
    const res2 = await gw.chat({
      model: "gemini-3.8-flash",
      reasoning_effort: "high",
      messages,
      tools,
      stream: true,
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get("X-Agy2Api-Session-Cache"), "HIT");
    assert.equal(res2.headers.get("X-Agy2Api-Session-Id"), sessionId);
    const turn2 = await readSse(res2);
    assert.equal(turn2.finishReason, "stop");
    assert.match(turn2.content, /OMEGA-7/);

    const prompts = gw
      .acpRequests("session/prompt")
      .filter((m) => m.params.sessionId === sessionId)
      .map((m) => m.params.prompt[0].text as string);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /<tool_response id="[^"]+" name="get_weather">/);
    assert.doesNotMatch(prompts[1], /weather please/, "history must not be resent");
  });

  test("rejects malformed bodies", async () => {
    const res = await gw.fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    const empty = await gw.chat({ model: "gemini-3.8-flash", messages: [] });
    assert.equal(empty.status, 400);
  });
});
