import "../helpers/isolate-env.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildSystemPromptAppend,
  compileDeltaPrompt as compileDeltaNeutral,
  compileFullPrompt as compileFullNeutral,
} from "../../src/compiler/prompt-compiler.js";
import { ToolChoice, ToolDefinition } from "../../src/core/chat.js";
import { decodeMessages } from "../../src/protocols/openai/chat-completions.js";
import { AcpContentBlock } from "../../src/types/acp.js";
import { OpenAIMessage } from "../../src/types/openai.js";

/** A text-only prompt must be exactly one text block; returns its text. */
function onlyText(prompt: AcpContentBlock[]): string {
  assert.equal(prompt.length, 1);
  assert.equal(prompt[0].type, "text");
  return (prompt[0] as { text: string }).text;
}

const tools: ToolDefinition[] = [
  { name: "search", description: "web search", parameters: { type: "object" } },
];

const compileFullPrompt = (messages: OpenAIMessage[], t?: ToolDefinition[], choice?: ToolChoice) => {
  const { systemPromptAppend, prompt } = compileFullNeutral(decodeMessages(messages), t, choice);
  return { systemPromptAppend, promptText: onlyText(prompt) };
};
const compileDeltaPrompt = (messages: OpenAIMessage[]) =>
  onlyText(compileDeltaNeutral(decodeMessages(messages)));

describe("prompt compiler", () => {
  test("single user message is sent verbatim; system text goes to the append", () => {
    const out = compileFullPrompt([
      { role: "system", content: "Be terse." },
      { role: "user", content: "hi" },
    ]);
    assert.equal(out.promptText, "hi");
    assert.match(out.systemPromptAppend, /^Never call built-in tools/);
    assert.match(out.systemPromptAppend, /Be terse\.$/);
    assert.doesNotMatch(out.systemPromptAppend, /<available_tools>/);
  });

  test("tool protocol is included unless tool_choice is none", () => {
    const withTools = buildSystemPromptAppend([], tools, "auto");
    assert.match(withTools, /<tool_call>/);
    assert.match(withTools, /<available_tools>\n\[\{"name":"search","description":"web search"/);

    assert.doesNotMatch(buildSystemPromptAppend([], tools, "none"), /<available_tools>/);
    assert.match(buildSystemPromptAppend([], tools, "required"), /MUST emit at least one <tool_call>/);
    assert.match(
      buildSystemPromptAppend([], tools, { name: "search" }),
      /You MUST call "search"/
    );
  });

  test("multi-turn history becomes a labelled transcript ending with the raw user turn", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "q1" },
      {
        role: "assistant",
        content: "let me look",
        tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }],
      },
      { role: "tool", tool_call_id: "c1", name: "search", content: "result" },
      { role: "user", content: "q2" },
    ];
    const { promptText } = compileFullPrompt(messages, tools);
    assert.equal(
      promptText,
      [
        "[USER]\nq1",
        '[ASSISTANT]\nlet me look\n<tool_call>\n{"name":"search","arguments":{"q":"x"}}\n</tool_call>',
        '[TOOL]\n<tool_response id="c1" name="search">\nresult\n</tool_response>',
        "q2",
      ].join("\n\n")
    );
  });

  test("delta prompt serializes only the new messages without role labels", () => {
    const delta = compileDeltaPrompt([
      { role: "tool", tool_call_id: "c1", content: "r1" },
      { role: "user", content: "and then?" },
    ]);
    assert.equal(delta, '<tool_response id="c1">\nr1\n</tool_response>\n\nand then?');
  });

  const describeThis: OpenAIMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "text", text: "this" },
      ],
    },
  ];

  test("without image support, an image becomes a placeholder in place", () => {
    assert.equal(compileFullPrompt(describeThis).promptText, "describe\n[image omitted]\nthis");
  });

  test("with image support, images are inline blocks between the surrounding text", () => {
    const { prompt } = compileFullNeutral(decodeMessages(describeThis), [], undefined, { images: true });
    assert.deepEqual(prompt, [
      { type: "text", text: "describe\n" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "text", text: "\nthis" },
    ]);
  });

  test("transcripts and tool results carry images; the assistant's own turns stay text", () => {
    const png = { type: "image" as const, mimeType: "image/png", data: "AAAA" };
    const fetched = { ...png, url: "https://example.com/a.png" };
    const prompt = compileDeltaNeutral(
      [
        { role: "assistant", content: [{ type: "text", text: "ok" }, png], toolCalls: [] },
        { role: "tool", toolCallId: "c1", content: [fetched] },
        { role: "user", content: [png, { type: "text", text: "  and this? " }] },
        // Not resolved to inline data: cannot be sent as a block
        { role: "user", content: [{ type: "image", url: "https://example.com/b.png" }] },
      ],
      { images: true }
    );
    assert.deepEqual(prompt, [
      { type: "text", text: 'ok\n\n<tool_response id="c1">\n' },
      { ...png, uri: "https://example.com/a.png" },
      { type: "text", text: "\n</tool_response>\n\n" },
      png,
      { type: "text", text: "\n  and this?\n\n[image omitted]" },
    ]);
  });
});
