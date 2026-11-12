import "../helpers/isolate-env.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SessionAffinityRegistry } from "../../src/compiler/session-hash.js";
import { OpenAIMessage, OpenAIToolDefinition } from "../../src/types/openai.js";

const tools: OpenAIToolDefinition[] = [
  {
    type: "function",
    function: { name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } },
  },
];

const history: OpenAIMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "find it" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"a","n":1}' } },
    ],
  },
];

const always = () => true;

describe("SessionAffinityRegistry", () => {
  test("matches the stored prefix and returns only the new messages", () => {
    const reg = new SessionAffinityRegistry();
    reg.registerTurnState("m", tools, history, "w1", "s1");
    const toolResult: OpenAIMessage = { role: "tool", tool_call_id: "call_1", content: "found" };

    const match = reg.findBestMatchingPrefix("m", tools, [...history, toolResult], always);
    assert.ok(match);
    assert.equal(match.entry.sessionId, "s1");
    assert.equal(match.matchedPrefixLength, history.length);
    assert.deepEqual(match.deltaMessages, [toolResult]);
  });

  test("is insensitive to tool-call ids, JSON key order and surrounding whitespace", () => {
    const reg = new SessionAffinityRegistry();
    reg.registerTurnState("m", tools, history, "w1", "s1");
    const resent: OpenAIMessage[] = [
      { role: "developer", content: "  sys " },
      { role: "user", content: "find it\n" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_other", type: "function", function: { name: "lookup", arguments: '{ "n": 1, "q": "a" }' } },
        ],
      },
      { role: "user", content: "next" },
    ];
    assert.ok(reg.findBestMatchingPrefix("m", tools, resent, always));
  });

  test("does not match across different models, tools or edited history", () => {
    const reg = new SessionAffinityRegistry();
    reg.registerTurnState("m", tools, history, "w1", "s1");
    const next = [...history, { role: "user", content: "more" } as OpenAIMessage];

    assert.equal(reg.findBestMatchingPrefix("other-model", tools, next, always), null);
    assert.equal(reg.findBestMatchingPrefix("m", [], next, always), null);
    const edited = next.map((m, i) => (i === 1 ? { ...m, content: "find something else" } : m));
    assert.equal(reg.findBestMatchingPrefix("m", tools, edited, always), null);
  });

  test("skips sessions whose worker is unavailable", () => {
    const reg = new SessionAffinityRegistry();
    reg.registerTurnState("m", tools, history, "w1", "s1");
    const next = [...history, { role: "user", content: "more" } as OpenAIMessage];
    assert.equal(reg.findBestMatchingPrefix("m", tools, next, () => false), null);
  });

  test("forgets entries after the TTL and on explicit removal", async () => {
    const reg = new SessionAffinityRegistry(5);
    reg.registerTurnState("m", tools, history, "w1", "s1");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(reg.size(), 0);

    const reg2 = new SessionAffinityRegistry();
    reg2.registerTurnState("m", tools, history, "w1", "s1");
    reg2.registerTurnState("m", tools, history.slice(0, 2), "w2", "s2");
    reg2.removeSession("s1");
    assert.equal(reg2.size(), 1);
    reg2.removeWorkerSessions("w2");
    assert.equal(reg2.size(), 0);
  });
});
