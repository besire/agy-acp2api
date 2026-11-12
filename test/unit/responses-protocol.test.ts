import "../helpers/isolate-env.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ChatMessage, GatewayError, TurnResult } from "../../src/core/chat.js";
import { ResponseStore } from "../../src/protocols/openai/response-store.js";
import {
  createResponsesProtocol,
  decodeResponsesRequest,
} from "../../src/protocols/openai/responses.js";

const user = (text: string): ChatMessage => ({ role: "user", content: [{ type: "text", text }] });

const result: TurnResult = {
  message: { role: "assistant", content: [{ type: "text", text: "done" }], toolCalls: [] },
  reasoning: "",
  finishReason: "stop",
  usage: {
    inputTokens: 10,
    outputTokens: 7,
    cachedReadTokens: 3,
    cachedWriteTokens: 0,
    thoughtTokens: 2,
    totalTokens: 20,
  },
  actualModel: "actual-model",
  ttftMs: 5,
  durationMs: 9,
};

describe("OpenAI Responses codec", () => {
  test("decodes instructions, input items and flat function tools", () => {
    const { chat, state } = decodeResponsesRequest(
      {
        model: "gemini-4-carbon",
        instructions: "rules",
        reasoning: { effort: "minimal", summary: "auto" },
        input: [
          { role: "developer", content: "dev note" },
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "look" },
              { type: "input_image", image_url: "data:image/jpeg;base64,QUJD" },
              { type: "input_file", file_id: "file_1" },
            ],
          },
          { type: "reasoning", id: "rs_1", summary: [] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "calling" }] },
          { type: "function_call", call_id: "c1", name: "f", arguments: '{"a":1}' },
          { type: "function_call", call_id: "c2", name: "g", arguments: "{}" },
          { type: "function_call_output", call_id: "c1", output: "r1" },
          { type: "function_call_output", call_id: "c2", output: [{ type: "input_text", text: "r2" }] },
          { type: "function_call", call_id: "c3", name: "f", arguments: "{}" },
        ],
        tools: [
          { type: "function", name: "f", description: "d", parameters: { type: "object" } },
          { type: "web_search_preview" },
        ],
        tool_choice: { type: "function", name: "f" },
      },
      new ResponseStore()
    );

    assert.equal(chat.effort, "low");
    assert.equal(state.instructionMessages, 1);
    assert.deepEqual(state.echo.reasoning, { effort: "minimal", summary: "auto" });
    assert.deepEqual(chat.messages, [
      { role: "system", content: [{ type: "text", text: "rules" }] },
      { role: "system", content: [{ type: "text", text: "dev note" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/jpeg", data: "QUJD" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "calling" }],
        toolCalls: [
          { id: "c1", name: "f", arguments: '{"a":1}' },
          { id: "c2", name: "g", arguments: "{}" },
        ],
      },
      { role: "tool", content: [{ type: "text", text: "r1" }], toolCallId: "c1", name: "f" },
      { role: "tool", content: [{ type: "text", text: "r2" }], toolCallId: "c2", name: "g" },
      // A call with no assistant message right before it starts a new assistant turn
      { role: "assistant", content: [], toolCalls: [{ id: "c3", name: "f", arguments: "{}" }] },
    ]);
    assert.deepEqual(chat.tools, [{ name: "f", description: "d", parameters: { type: "object" } }]);
    assert.deepEqual(chat.toolChoice, { name: "f" });
  });

  test("previous_response_id prepends stored history under the current instructions", () => {
    const store = new ResponseStore();
    const protocol = createResponsesProtocol(store);
    const first = protocol.decodeRequest({ instructions: "old rules", input: "q1" });
    protocol.onTurnComplete!(
      { id: "resp_1", created: 1, model: "m", state: first.state },
      first.chat,
      result
    );
    assert.deepEqual(store.get("resp_1"), [user("q1"), result.message]);

    const second = protocol.decodeRequest({
      instructions: "new rules",
      previous_response_id: "resp_1",
      input: [{ type: "function_call_output", call_id: "c9", output: "x" }],
    });
    assert.deepEqual(second.chat.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
    assert.deepEqual(second.chat.messages[0].content, [{ type: "text", text: "new rules" }]);

    const unstored = protocol.decodeRequest({ store: false, input: "q" });
    protocol.onTurnComplete!(
      { id: "resp_2", created: 1, model: "m", state: unstored.state },
      unstored.chat,
      result
    );
    assert.equal(store.get("resp_2"), undefined);
  });

  test("rejects unusable requests with a 400", () => {
    const store = new ResponseStore();
    for (const [body, code] of [
      [null, undefined],
      [{}, undefined],
      [{ input: 1 }, undefined],
      [{ input: [7] }, undefined],
      [{ input: [{ role: "tool", content: "x" }] }, undefined],
      [{ input: [{ type: "item_reference", id: "x" }] }, undefined],
      [{ input: "x", tools: [{ type: "function", parameters: {} }] }, undefined],
      [{ input: "x", previous_response_id: "resp_missing" }, "previous_response_not_found"],
    ] as const) {
      assert.throws(
        () => decodeResponsesRequest(body, store),
        (err) =>
          err instanceof GatewayError &&
          err.status === 400 &&
          err.type === "invalid_request_error" &&
          err.code === code,
        JSON.stringify(body)
      );
    }
  });

  test("a thought after text closes the message and opens a new reasoning item", () => {
    const protocol = createResponsesProtocol();
    const { state } = protocol.decodeRequest({ input: "x" });
    const enc = protocol.createStreamEncoder({ id: "resp_x", created: 1, model: "base", state });
    const frames = [
      ...enc.start(),
      ...enc.event({ type: "text", text: "a" }),
      ...enc.event({ type: "thought", text: "t" }),
      ...enc.event({ type: "text", text: "b" }),
      ...enc.finish(result),
    ].map((f) => JSON.parse(f.data));

    const done = frames.filter((f) => f.type === "response.output_item.done");
    assert.deepEqual(
      done.map((f) => [f.output_index, f.item.type]),
      [
        [0, "message"],
        [1, "reasoning"],
        [2, "message"],
      ]
    );
    const completed = frames.at(-1);
    assert.equal(completed.type, "response.completed");
    assert.equal(completed.response.model, "actual-model");
    assert.deepEqual(completed.response.output, done.map((f) => f.item));
    assert.deepEqual(completed.response.usage, {
      input_tokens: 13,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 20,
    });
  });

  test("a failure mid-stream closes the open item and ends with response.failed", () => {
    const protocol = createResponsesProtocol();
    const { state } = protocol.decodeRequest({ input: "x" });
    const enc = protocol.createStreamEncoder({ id: "resp_x", created: 1, model: "base", state });
    enc.start();
    enc.event({ type: "text", text: "partial" });
    const frames = enc.fail("boom").map((f) => JSON.parse(f.data));
    assert.deepEqual(
      frames.map((f) => f.type),
      [
        "response.output_text.done",
        "response.content_part.done",
        "response.output_item.done",
        "response.failed",
      ]
    );
    const failed = frames.at(-1).response;
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.error, { code: "server_error", message: "boom" });
    assert.equal(failed.output[0].content[0].text, "partial");
  });

  test("errors carry param and code", () => {
    const body = createResponsesProtocol().encodeError(
      new GatewayError("nope", 400, "invalid_request_error", "previous_response_not_found", "previous_response_id")
    );
    assert.deepEqual(body, {
      error: {
        message: "nope",
        type: "invalid_request_error",
        param: "previous_response_id",
        code: "previous_response_not_found",
      },
    });
  });
});

describe("ResponseStore", () => {
  test("evicts the least recently used entry beyond the cap", () => {
    const store = new ResponseStore(60_000, 2);
    store.save("a", [user("a")]);
    store.save("b", [user("b")]);
    assert.ok(store.get("a"));
    store.save("c", [user("c")]);
    assert.equal(store.size(), 2);
    assert.equal(store.get("b"), undefined);
    assert.ok(store.get("a"));
    assert.ok(store.get("c"));
  });

  test("forgets entries after the TTL", async () => {
    const store = new ResponseStore(5);
    store.save("a", [user("a")]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.get("a"), undefined);
  });

  test("stays within its size budget but always keeps the newest entry", () => {
    const store = new ResponseStore(60_000, 100, 10);
    store.save("a", [user("1234")]);
    store.save("b", [user("5678")]);
    assert.equal(store.size(), 2);
    store.save("c", [user("abcd")]);
    assert.equal(store.size(), 2);
    assert.equal(store.get("a"), undefined);

    store.save("huge", [user("x".repeat(50))]);
    assert.equal(store.size(), 1);
    assert.ok(store.get("huge"));
    // Re-saving an id replaces its size instead of adding to it
    store.save("huge", [user("y")]);
    store.save("d", [user("12345678")]);
    assert.equal(store.size(), 2);
  });
});
