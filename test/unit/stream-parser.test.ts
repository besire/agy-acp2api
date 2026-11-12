import "../helpers/isolate-env.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ToolCallStreamParser } from "../../src/parser/stream-parser.js";
import { OpenAIToolCallDelta } from "../../src/types/openai.js";

function run(chunks: string[]) {
  const parser = new ToolCallStreamParser();
  const text: string[] = [];
  const tools: OpenAIToolCallDelta[] = [];
  for (const c of chunks) {
    parser.feed(c, (t) => text.push(t), (tc) => tools.push(tc));
  }
  const finish = parser.flush((t) => text.push(t), (tc) => tools.push(tc));
  return { parser, text: text.join(""), tools, finish };
}

describe("ToolCallStreamParser", () => {
  test("extracts a tool call split across chunks and repairs trailing commas", () => {
    const { text, tools, finish } = run([
      "Hello! I will check <div> and then call a tool: <",
      "tool_",
      "call>",
      '```json\n{"name": "calculate_sum", "arguments": {"a": 10, "b": 25,}}\n```',
      "</tool_",
      "call> Done!",
    ]);
    assert.equal(text, "Hello! I will check <div> and then call a tool: ");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].function?.name, "calculate_sum");
    assert.deepEqual(JSON.parse(tools[0].function?.arguments || ""), { a: 10, b: 25 });
    assert.equal(finish, "tool_calls");
  });

  test("releases a held-back partial tag once it turns out to be plain text", () => {
    const { text, tools, finish } = run(["see you <to", "morrow"]);
    assert.equal(text, "see you <tomorrow");
    assert.equal(tools.length, 0);
    assert.equal(finish, "stop");
  });

  test("emits parallel calls with increasing indices and drops chatter after them", () => {
    const { text, tools } = run([
      'a<tool_call>{"name":"x","arguments":{"n":1}}</tool_call>',
      " between ",
      '<tool_call>{"name":"y","arguments":{}}</tool_call> trailing',
    ]);
    assert.equal(text, "a");
    assert.deepEqual(
      tools.map((t) => [t.index, t.function?.name]),
      [
        [0, "x"],
        [1, "y"],
      ]
    );
  });

  test("deduplicates identical calls within one turn", () => {
    const call = '<tool_call>{"name":"x","arguments":{"n":1}}</tool_call>';
    const { tools } = run([call, call]);
    assert.equal(tools.length, 1);
  });

  test("accepts `function`/`parameters` shapes and stringified arguments", () => {
    const { tools } = run([
      '<tool_call>{"function":{"name":"f","arguments":"{\\"k\\":2}"}}</tool_call>',
      '<tool_call>{"name":"g","parameters":{"k":3}}</tool_call>',
    ]);
    assert.equal(tools[0].function?.name, "f");
    assert.equal(tools[0].function?.arguments, '{"k":2}');
    assert.equal(tools[1].function?.name, "g");
    assert.equal(tools[1].function?.arguments, '{"k":3}');
  });

  test("falls back to raw text when the first block is not a tool call, keeping later text", () => {
    const { text, tools, finish } = run([
      "<tool_call>not json at all</tool_call>",
      " and the rest of the answer",
    ]);
    assert.equal(text, "<tool_call>not json at all</tool_call> and the rest of the answer");
    assert.equal(tools.length, 0);
    assert.equal(finish, "stop");
  });

  test("still drops an unparseable block that follows a valid call", () => {
    const { text, tools } = run([
      'ok<tool_call>{"name":"x","arguments":{}}</tool_call>',
      "<tool_call>garbage</tool_call> more",
    ]);
    assert.equal(text, "ok");
    assert.equal(tools.length, 1);
  });

  test("salvages a tool call the model never closed", () => {
    const { tools, finish } = run(['<tool_call>{"name":"x","arguments":{"q":"z"}}']);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].function?.arguments, '{"q":"z"}');
    assert.equal(finish, "tool_calls");
  });

  test("injectDirectToolCall goes through the same accumulation and dedupe", () => {
    const parser = new ToolCallStreamParser();
    const seen: OpenAIToolCallDelta[] = [];
    parser.injectDirectToolCall("native", { a: 1 }, (d) => seen.push(d));
    parser.injectDirectToolCall("native", { a: 1 }, (d) => seen.push(d));
    assert.equal(seen.length, 1);
    const msg = parser.toAssistantMessage();
    assert.equal(msg.content, null);
    assert.equal(msg.tool_calls?.[0].function.arguments, '{"a":1}');
  });
});
