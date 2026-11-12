import "../helpers/isolate-env.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildUnifiedModelCatalog,
  resolveModelAndThinking,
  stripModelThinkingSuffix,
} from "../../src/compiler/model-resolver.js";

const raw = [
  ...["gemini-4-carbon", "gemini-4-argon", "gemini-3.8-flash"].flatMap((base) =>
    ["low", "medium", "high"].map((lv) => ({
      modelId: `${base}-${lv}`,
      name: `${base} (${lv[0].toUpperCase()}${lv.slice(1)})`,
    }))
  ),
  { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];

const resolve = (body: Record<string, unknown>) =>
  resolveModelAndThinking({ messages: [], ...body } as any, raw);

describe("model resolver", () => {
  test("groups effort variants into base models", () => {
    const catalog = buildUnifiedModelCatalog(raw);
    assert.equal(catalog.length, 4);
    const carbon = catalog.find((c) => c.id === "gemini-4-carbon")!;
    assert.deepEqual(carbon.thinkingLevels, ["low", "medium", "high"]);
    assert.equal(carbon.name, "gemini-4-carbon");
    const oss = catalog.find((c) => c.id === "gpt-oss-120b")!;
    assert.deepEqual(oss.thinkingLevels, ["medium"]);
  });

  for (const [model, level] of [
    ["gemini-4-carbon(low)", "low"],
    ["gemini-4-carbon (high)", "high"],
    ["gemini-4-carbon:medium", "medium"],
    ["gemini-4-carbon@high", "high"],
    ["gemini-4-carbon-low", "low"],
  ] as const) {
    test(`parses suffix syntax ${model}`, () => {
      const r = resolve({ model });
      assert.equal(r.baseModelId, "gemini-4-carbon");
      assert.equal(r.thinkingLevel, level);
      assert.equal(r.acpModelId, `gemini-4-carbon-${level}`);
    });
  }

  test("body reasoning parameters win over the model suffix", () => {
    assert.equal(resolve({ model: "gemini-4-argon(low)", reasoning_effort: "high" }).acpModelId, "gemini-4-argon-high");
    assert.equal(
      resolve({ model: "gemini-4-argon", thinking: { type: "enabled", budget_tokens: 32000 } }).thinkingLevel,
      "high"
    );
    assert.equal(resolve({ model: "gemini-4-argon", reasoning: { max_tokens: 1000 } }).thinkingLevel, "low");
  });

  test("falls back to the only available level for single-variant models", () => {
    const r = resolve({ model: "gpt-oss-120b", reasoning_effort: "high" });
    assert.equal(r.acpModelId, "gpt-oss-120b-medium");
    assert.equal(r.thinkingLevel, "medium");
  });

  test("passes unknown models through with the requested level", () => {
    const r = resolve({ model: "future-model:high" });
    assert.equal(r.baseModelId, "future-model");
    assert.equal(r.acpModelId, "future-model-high");
  });

  test("strips thinking suffixes from model names returned to clients", () => {
    assert.equal(stripModelThinkingSuffix("gemini-4-carbon-high"), "gemini-4-carbon");
    assert.equal(stripModelThinkingSuffix("gemini-4-carbon (high)"), "gemini-4-carbon");
    assert.equal(stripModelThinkingSuffix("gemini-3.8-flash:low"), "gemini-3.8-flash");
    assert.equal(stripModelThinkingSuffix("claude-sonnet-5-5-high"), "claude-sonnet-5-5");
  });
});
