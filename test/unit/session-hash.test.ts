import "../helpers/isolate-env.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  computeConversationHash,
  prefixHashes,
  SessionAffinityRegistry,
} from "../../src/compiler/session-hash.js";
import { ToolDefinition } from "../../src/core/chat.js";
import { decodeMessages } from "../../src/protocols/openai/chat-completions.js";
import { OpenAIMessage } from "../../src/types/openai.js";

const tools: ToolDefinition[] = [
  { name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } },
];

const msgs = (list: OpenAIMessage[]) => decodeMessages(list);

const history = msgs([
  { role: "system", content: "sys" },
  { role: "user", content: "find it" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"a","n":1}' } },
    ],
  },
]);

const always = () => true;

describe("SessionAffinityRegistry", () => {
  test("matches the stored prefix and returns only the new messages", () => {
    const reg = new SessionAffinityRegistry();
    reg.registerTurnState("m", tools, history, "w1", "s1");
    const toolResult = msgs([{ role: "tool", tool_call_id: "call_1", content: "found" }])[0];

    const match = reg.findBestMatchingPrefix("m", tools, [...history, toolResult], always);
    assert.ok(match);
    assert.equal(match.entry.sessionId, "s1");
    assert.equal(match.matchedPrefixLength, history.length);
    assert.deepEqual(match.deltaMessages, [toolResult]);
  });

  test("is insensitive to tool-call ids, JSON key order and surrounding whitespace", () => {
    const reg = new SessionAffinityRegistry();
    reg.registerTurnState("m", tools, history, "w1", "s1");
    const resent = msgs([
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
    ]);
    assert.ok(reg.findBestMatchingPrefix("m", tools, resent, always));
  });

  test("does not match across different models, tools or edited history", () => {
    const reg = new SessionAffinityRegistry();
    reg.registerTurnState("m", tools, history, "w1", "s1");
    const next = [...history, ...msgs([{ role: "user", content: "more" }])];

    assert.equal(reg.findBestMatchingPrefix("other-model", tools, next, always), null);
    assert.equal(reg.findBestMatchingPrefix("m", [], next, always), null);
    const edited = next.map((m, i) =>
      i === 1 ? { ...m, content: [{ type: "text" as const, text: "find something else" }] } : m
    );
    assert.equal(reg.findBestMatchingPrefix("m", tools, edited, always), null);
  });

  test("images take part in the hash", () => {
    const withImage = (data: string) =>
      msgs([
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } },
          ],
        },
        { role: "assistant", content: "a cat" },
        { role: "user", content: "sure?" },
      ]);
    const reg = new SessionAffinityRegistry();
    reg.registerTurnState("m", [], withImage("AAAA").slice(0, 2), "w1", "s1");
    assert.ok(reg.findBestMatchingPrefix("m", [], withImage("AAAA"), always));
    assert.equal(reg.findBestMatchingPrefix("m", [], withImage("BBBB"), always), null);
  });

  test("the hash chain agrees with hashing each prefix on its own", () => {
    const chain = prefixHashes("m", tools, history);
    assert.equal(chain.length, history.length + 1);
    chain.forEach((hash, k) => {
      assert.equal(hash, computeConversationHash("m", tools, history.slice(0, k)));
    });
    assert.equal(new Set(chain).size, chain.length);
  });

  test("skips sessions whose worker is unavailable", () => {
    const reg = new SessionAffinityRegistry();
    reg.registerTurnState("m", tools, history, "w1", "s1");
    const next = [...history, ...msgs([{ role: "user", content: "more" }])];
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

  test("a session only matches at its latest head", () => {
    const reg = new SessionAffinityRegistry();
    const turn1 = history.slice(0, 3);
    reg.registerTurnState("m", tools, turn1, "w1", "s1");
    const turn2 = [...turn1, ...msgs([{ role: "user", content: "u2" }, { role: "assistant", content: "a2" }])];
    reg.registerTurnState("m", tools, turn2, "w1", "s1");
    assert.equal(reg.size(), 1);

    // Continuing from the old head would replay u2 into a session that already has it
    const fromOldHead = [...turn1, ...msgs([{ role: "user", content: "u2 again" }])];
    assert.equal(reg.findBestMatchingPrefix("m", tools, fromOldHead, always), null);
    const fromNewHead = [...turn2, ...msgs([{ role: "user", content: "u3" }])];
    assert.equal(reg.findBestMatchingPrefix("m", tools, fromNewHead, always)?.entry.sessionId, "s1");
  });

  test("a claimed session cannot be matched again until restored", () => {
    const reg = new SessionAffinityRegistry();
    reg.registerTurnState("m", tools, history, "w1", "s1");
    const next = [...history, ...msgs([{ role: "user", content: "more" }])];
    const match = reg.findBestMatchingPrefix("m", tools, next, always)!;

    reg.claim(match.entry);
    assert.equal(reg.findBestMatchingPrefix("m", tools, next, always), null);
    reg.restore(match.entry);
    assert.equal(reg.findBestMatchingPrefix("m", tools, next, always)?.entry.sessionId, "s1");
  });
});
