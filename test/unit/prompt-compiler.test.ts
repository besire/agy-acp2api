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
import { OpenAIMessage } from "../../src/types/openai.js";

const tools: ToolDefinition[] = [
  { name: "search", description: "web search", parameters: { type: "object" } },
];

const compileFullPrompt = (messages: OpenAIMessage[], t?: ToolDefinition[], choice?: ToolChoice) =>
  compileFullNeutral(decodeMessages(messages), t, choice);
const compileDeltaPrompt = (messages: OpenAIMessage[]) => compileDeltaNeutral(decodeMessages(messages));

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

  test("keeps only text parts of multi-part content (images are not supported yet)", () => {
    const { promptText } = compileFullPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "text", text: "this" },
        ],
      },
    ]);
    assert.equal(promptText, "describe\nthis");
  });
});
