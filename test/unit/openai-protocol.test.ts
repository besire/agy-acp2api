import "../helpers/isolate-env.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GatewayError, TurnResult } from "../../src/core/chat.js";
import {
  decodeChatCompletionRequest,
  openAIChatCompletions,
} from "../../src/protocols/openai/chat-completions.js";

const result: TurnResult = {
  message: {
    role: "assistant",
    content: [],
    toolCalls: [{ id: "call_1", name: "f", arguments: "{}" }],
  },
  reasoning: "hmm",
  finishReason: "tool_calls",
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

describe("OpenAI chat completions codec", () => {
  test("decodes roles, multi-part content and tools into the neutral model", () => {
    const req = decodeChatCompletionRequest({
      model: "gemini-4-carbon",
      reasoning_effort: "max",
      stream: 1,
      messages: [
        { role: "developer", content: "rules" },
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
            { type: "image_url", image_url: { url: "https://example.com/cat.jpg" } },
            { type: "input_audio", input_audio: {} },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: { a: 1 } } }],
        },
        { role: "tool", tool_call_id: "c1", name: "f", content: "done" },
      ],
      tools: [
        { type: "function", function: { name: "f", parameters: { type: "object" } } },
        { type: "web_search_preview" },
      ],
      tool_choice: { type: "function", function: { name: "f" } },
    });

    assert.equal(req.model, "gemini-4-carbon");
    assert.equal(req.effort, "high");
    assert.equal(req.stream, true);
    assert.deepEqual(req.messages, [
      { role: "system", content: [{ type: "text", text: "rules" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/png", data: "QUJD" },
          { type: "image", url: "https://example.com/cat.jpg" },
        ],
      },
      { role: "assistant", content: [], toolCalls: [{ id: "c1", name: "f", arguments: '{"a":1}' }] },
      { role: "tool", content: [{ type: "text", text: "done" }], toolCallId: "c1", name: "f" },
    ]);
    assert.deepEqual(req.tools, [{ name: "f", description: undefined, parameters: { type: "object" } }]);
    assert.deepEqual(req.toolChoice, { name: "f" });
  });

  test("maps the legacy function_call / function role onto tool calls and results", () => {
    const req = decodeChatCompletionRequest({
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "", function_call: { name: "g", arguments: '{"x":1}' } },
        { role: "function", name: "g", content: "42" },
      ],
    });
    assert.deepEqual(req.messages[1], {
      role: "assistant",
      content: [],
      toolCalls: [{ id: "", name: "g", arguments: '{"x":1}' }],
    });
    assert.deepEqual(req.messages[2], {
      role: "tool",
      content: [{ type: "text", text: "42" }],
      toolCallId: undefined,
      name: "g",
    });
  });

  test("rejects unusable bodies with a 400 invalid_request_error", () => {
    const user = { role: "user", content: "a" };
    for (const body of [
      null,
      [],
      { messages: [] },
      { messages: [{ role: "wizard", content: "a" }] },
      { messages: [user, 7] },
      { messages: [user], tools: { type: "function" } },
      { messages: [user], tools: [{ type: "function", function: {} }] },
    ]) {
      assert.throws(
        () => decodeChatCompletionRequest(body),
        (err) =>
          err instanceof GatewayError && err.status === 400 && err.type === "invalid_request_error",
        JSON.stringify(body)
      );
    }
  });

  test("stream encoder emits role, deltas, the detected model, usage and [DONE]", () => {
    const enc = openAIChatCompletions.createStreamEncoder({ id: "chatcmpl-x", created: 1, model: "base", state: undefined });
    const frames = [
      ...enc.start(),
      ...enc.event({ type: "thought", text: "hmm" }),
      ...enc.event({ type: "model", model: "actual-model" }),
      ...enc.event({ type: "text", text: "hi" }),
      ...enc.event({ type: "tool_call", index: 0, call: { id: "call_1", name: "f", arguments: "{}" } }),
      ...enc.finish(result),
    ];
    assert.equal(frames.at(-1)?.data, "[DONE]");
    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f.data));
    assert.deepEqual(
      chunks.map((c) => c.model),
      ["base", "base", "actual-model", "actual-model", "actual-model"]
    );
    assert.ok(chunks.every((c) => c.id === "chatcmpl-x" && c.object === "chat.completion.chunk"));
    assert.deepEqual(
      chunks.map((c) => c.choices[0].delta),
      [
        { role: "assistant" },
        { reasoning_content: "hmm" },
        { content: "hi" },
        { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
        {},
      ]
    );
    const last = chunks.at(-1);
    assert.equal(last.choices[0].finish_reason, "tool_calls");
    assert.deepEqual(last.usage, {
      prompt_tokens: 13,
      completion_tokens: 7,
      total_tokens: 20,
      prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 2 },
    });
  });

  test("stream encoder reports a mid-stream failure as a final stop chunk", () => {
    const enc = openAIChatCompletions.createStreamEncoder({ id: "chatcmpl-x", created: 1, model: "base", state: undefined });
    const [chunk, done] = enc.fail("boom");
    assert.equal(done.data, "[DONE]");
    const parsed = JSON.parse(chunk.data);
    assert.equal(parsed.choices[0].delta.content, "\n[Gateway Error: boom]");
    assert.equal(parsed.choices[0].finish_reason, "stop");
  });

  test("non-streaming response uses null content beside tool calls and the actual model", () => {
    const body = openAIChatCompletions.encodeResponse(
      { id: "chatcmpl-x", created: 1, model: "base", state: undefined },
      result
    ) as any;
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "actual-model");
    assert.deepEqual(body.choices[0].message, {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
      reasoning_content: "hmm",
    });

    const plain = openAIChatCompletions.encodeResponse(
      { id: "chatcmpl-y", created: 1, model: "base", state: undefined },
      {
        ...result,
        message: { role: "assistant", content: [], toolCalls: [] },
        reasoning: "",
        finishReason: "stop",
      }
    ) as any;
    assert.deepEqual(plain.choices[0].message, { role: "assistant", content: "" });
  });
});
