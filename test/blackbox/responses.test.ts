import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Gateway, startGateway } from "../helpers/gateway.js";

const tools = [
  {
    type: "function",
    name: "get_weather",
    description: "Weather lookup",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
  { type: "web_search_preview" },
];

interface ResponsesEvent {
  event?: string;
  type: string;
  sequence_number: number;
  [key: string]: any;
}

async function readEvents(res: Response): Promise<ResponsesEvent[]> {
  const events: ResponsesEvent[] = [];
  for (const block of (await res.text()).split("\n\n")) {
    let event: string | undefined;
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (data) events.push({ event, ...JSON.parse(data) });
  }
  return events;
}

describe("OpenAI Responses API", () => {
  let gw: Gateway;
  before(async () => {
    gw = await startGateway();
  });
  after(async () => {
    await gw?.stop();
  });

  const post = (body: Record<string, unknown>, auth = true) =>
    gw.fetch("/v1/responses", {
      method: "POST",
      auth,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const promptsOf = (sessionId: string | null) =>
    gw
      .acpRequests("session/prompt")
      .filter((m) => m.params.sessionId === sessionId)
      .map((m) => m.params.prompt[0].text as string);

  test("requires the API key", async () => {
    const res = await post({ model: "gemini-3.8-flash", input: "hi" }, false);
    assert.equal(res.status, 401);
  });

  test("non-streaming: string input, instructions, output items and usage", async () => {
    const res = await post({
      model: "gemini-3.8-flash",
      instructions: "Be brief.",
      input: "hello responses",
      metadata: { tag: "t1" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Agy2Api-Session-Cache"), "MISS");
    const body = (await res.json()) as any;

    assert.match(body.id, /^resp_/);
    assert.equal(body.object, "response");
    assert.equal(body.status, "completed");
    assert.equal(body.instructions, "Be brief.");
    assert.deepEqual(body.metadata, { tag: "t1" });
    assert.deepEqual(
      body.output.map((item: any) => item.type),
      ["reasoning", "message"]
    );
    assert.equal(body.output[0].summary[0].text, "thinking...");
    const message = body.output[1];
    assert.equal(message.role, "assistant");
    assert.equal(message.status, "completed");
    assert.equal(message.content[0].type, "output_text");
    assert.match(message.content[0].text, /^echo: hello responses/);

    assert.equal(body.usage.input_tokens + body.usage.output_tokens, body.usage.total_tokens);
    assert.equal(body.usage.input_tokens_details.cached_tokens, 3);
    assert.equal(body.usage.output_tokens_details.reasoning_tokens, 2);

    const append = gw.acpRequests("session/new").at(-1)!.params._meta.antigravity.systemPrompt
      .append as string;
    assert.match(append, /Be brief\./);
  });

  test("streams a function call, then continues from previous_response_id with only the tool output", async () => {
    const res1 = await post({
      model: "gemini-3.8-flash",
      input: 'weather please [[tool:get_weather:{"city":"Shanghai"}]]',
      tools,
      stream: true,
    });
    assert.equal(res1.status, 200);
    const sessionId = res1.headers.get("X-Agy2Api-Session-Id");
    const events = await readEvents(res1);

    assert.deepEqual(
      events.map((e) => e.sequence_number),
      events.map((_, i) => i)
    );
    assert.ok(events.every((e) => e.event === e.type));
    assert.equal(events[0].type, "response.created");
    assert.equal(events[1].type, "response.in_progress");
    const completed = events.at(-1)!;
    assert.equal(completed.type, "response.completed");
    assert.equal(completed.response.status, "completed");

    const deltas = events
      .filter((e) => e.type === "response.output_text.delta")
      .map((e) => e.delta)
      .join("");
    assert.equal(deltas, "Calling a tool. ");
    const done = events.filter((e) => e.type === "response.output_item.done").map((e) => e.item);
    assert.deepEqual(
      done.map((item) => item.type),
      ["reasoning", "message", "function_call"]
    );
    assert.deepEqual(completed.response.output, done);

    const call = done[2];
    assert.equal(call.name, "get_weather");
    assert.match(call.call_id, /^call_/);
    assert.deepEqual(JSON.parse(call.arguments), { city: "Shanghai" });
    assert.equal(call.status, "completed");

    const res2 = await post({
      model: "gemini-3.8-flash",
      reasoning: { effort: "high" },
      previous_response_id: completed.response.id,
      input: [{ type: "function_call_output", call_id: call.call_id, output: '{"code":"OMEGA-7"}' }],
      tools,
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get("X-Agy2Api-Session-Cache"), "HIT");
    assert.equal(res2.headers.get("X-Agy2Api-Session-Id"), sessionId);
    assert.equal(res2.headers.get("X-Agy2Api-Thinking-Level"), "high");
    const body2 = (await res2.json()) as any;
    assert.equal(body2.previous_response_id, completed.response.id);
    assert.match(body2.output.at(-1).content[0].text, /OMEGA-7/);

    const prompts = promptsOf(sessionId);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /^<tool_response id="call_[^"]+" name="get_weather">/);
    assert.doesNotMatch(prompts[1], /weather please/, "history must not be resent");
  });

  test("stateless clients that resend the whole history also reuse the session", async () => {
    const input: any[] = [
      { role: "user", content: [{ type: "input_text", text: "first question" }] },
    ];
    const res1 = await post({ model: "gemini-3.8-flash", store: false, input });
    assert.equal(res1.status, 200);
    const sessionId = res1.headers.get("X-Agy2Api-Session-Id");
    const body1 = (await res1.json()) as any;
    assert.equal(body1.store, false);

    input.push(...body1.output, { role: "user", content: "second question" });
    const res2 = await post({ model: "gemini-3.8-flash", store: false, input });
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get("X-Agy2Api-Session-Cache"), "HIT");
    assert.equal(res2.headers.get("X-Agy2Api-Session-Id"), sessionId);
    await res2.arrayBuffer();
    assert.deepEqual(promptsOf(sessionId), ["first question", "second question"]);

    // Not stored, so it cannot be continued by id
    const res3 = await post({ model: "gemini-3.8-flash", previous_response_id: body1.id, input: "x" });
    assert.equal(res3.status, 400);
    assert.equal(((await res3.json()) as any).error.code, "previous_response_not_found");
  });

  test("rejects malformed requests", async () => {
    for (const body of [
      { model: "gemini-3.8-flash" },
      { model: "gemini-3.8-flash", input: 5 },
      { model: "gemini-3.8-flash", input: [{ role: "wizard", content: "hi" }] },
      { model: "gemini-3.8-flash", input: [{ type: "item_reference", id: "msg_1" }] },
      { model: "gemini-3.8-flash", input: "x", tools: [{ type: "function" }] },
    ]) {
      const res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      const err = ((await res.json()) as any).error;
      assert.equal(err.type, "invalid_request_error");
    }
  });
});
