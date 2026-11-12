/**
 * Live end-to-end test against a real, logged-in `agy` (uses your account and quota).
 * Run with `npm run test:live`; not part of `npm test`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { config } from "../../src/config.js";
import {
  buildUnifiedModelCatalog,
  resolveModelAndThinking,
  stripModelThinkingSuffix,
} from "../../src/compiler/model-resolver.js";
import {
   TelemetryStore,
  telemetryStore,
} from "../../src/telemetry/metrics-store.js";
import { ToolCallStreamParser } from "../../src/parser/stream-parser.js";
import { WorkerPool } from "../../src/pool/worker-pool.js";
import { createGatewayApp } from "../../src/server/app.js";
import {
  OpenAIChatCompletionChunk,
  OpenAIMessage,
  OpenAIToolCallDelta,
  OpenAIToolDefinition,
  OpenAIUsageDetails,
} from "../../src/types/openai.js";

function testSlidingWindowParserUnit() {
  console.log(
    "1. [Unit Test] Testing ToolCallStreamParser sliding window & partial prefix holdback..."
  );
  const parser = new ToolCallStreamParser();
  const emittedText: string[] = [];
  const emittedTools: OpenAIToolCallDelta[] = [];

  const chunks = [
    "Hello! I will check <div> and then call a tool: <",
    "tool_",
    "call>",
    '```json\n{"name": "calculate_sum", "arguments": {"a": 10, "b": 25,}}\n```',
    "</tool_",
    "call> Done!",
  ];

  for (const c of chunks) {
    parser.feed(
      c,
      (txt) => emittedText.push(txt),
      (tc) => emittedTools.push(tc)
    );
  }
  const finishReason = parser.flush(
    (txt) => emittedText.push(txt),
    (tc) => emittedTools.push(tc)
  );

  assert.equal(
    emittedText.join(""),
    "Hello! I will check <div> and then call a tool: "
  );
  assert.equal(emittedTools.length, 1);
  assert.equal(emittedTools[0].function?.name, "calculate_sum");
  assert.deepEqual(
    JSON.parse(emittedTools[0].function?.arguments || "{}"),
    { a: 10, b: 25 }
  );
  assert.equal(finishReason, "tool_calls");
  console.log("   -> Passed! Sliding window parser verified.");
}

function testUnifiedModelAndEffortResolverUnit() {
  console.log(
    "2. [Unit Test] Testing Unified Model Catalog & Thinking Effort Resolver..."
  );
  const sampleRaw = [
    { modelId: "gemini-4-carbon-low", name: "Gemini 4 Carbon (Low)" },
    { modelId: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)" },
    { modelId: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
    { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
    { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
    { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
    { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
    { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
  ];

  const catalog = buildUnifiedModelCatalog(sampleRaw);
  assert.equal(catalog.length, 4);
  const carbon = catalog.find((c) => c.id === "gemini-4-carbon")!;
  assert.deepEqual(carbon.thinkingLevels, ["low", "medium", "high"]);
  const argon = catalog.find((c) => c.id === "gemini-4-argon")!;
  assert.deepEqual(argon.thinkingLevels, ["low", "medium", "high"]);

  // Test 1: Base model + reasoning_effort (Carbon & Argon)
  const rc1 = resolveModelAndThinking(
    { model: "gemini-4-carbon", reasoning_effort: "high", messages: [] },
    sampleRaw
  );
  assert.equal(rc1.baseModelId, "gemini-4-carbon");
  assert.equal(rc1.thinkingLevel, "high");
  assert.equal(rc1.acpModelId, "gemini-4-carbon-high");

  const rc2 = resolveModelAndThinking(
    { model: "gemini-4-carbon(low)", messages: [] },
    sampleRaw
  );
  assert.equal(rc2.baseModelId, "gemini-4-carbon");
  assert.equal(rc2.thinkingLevel, "low");
  assert.equal(rc2.acpModelId, "gemini-4-carbon-low");

  const rc3 = resolveModelAndThinking(
    { model: "gemini-4-carbon:medium", messages: [] },
    sampleRaw
  );
  assert.equal(rc3.baseModelId, "gemini-4-carbon");
  assert.equal(rc3.thinkingLevel, "medium");
  assert.equal(rc3.acpModelId, "gemini-4-carbon-medium");

  const r1 = resolveModelAndThinking(
    { model: "gemini-4-argon", reasoning_effort: "high", messages: [] },
    sampleRaw
  );
  assert.equal(r1.baseModelId, "gemini-4-argon");
  assert.equal(r1.thinkingLevel, "high");
  assert.equal(r1.acpModelId, "gemini-4-argon-high");

  // Test 2: Model with bracket syntax `gemini-3.8-flash(low)`
  const r2 = resolveModelAndThinking(
    { model: "gemini-3.8-flash(low)", messages: [] },
    sampleRaw
  );
  assert.equal(r2.baseModelId, "gemini-3.8-flash");
  assert.equal(r2.thinkingLevel, "low");
  assert.equal(r2.acpModelId, "gemini-3.8-flash-low");

  // Test 3: Model with thinking.budget_tokens
  const r3 = resolveModelAndThinking(
    {
      model: "gemini-4-argon",
      thinking: { type: "enabled", budget_tokens: 32000 },
      messages: [],
    },
    sampleRaw
  );
  assert.equal(r3.thinkingLevel, "high");
  assert.equal(r3.acpModelId, "gemini-4-argon-high");

  // Test 4: Suffix stripping for API client responses
  assert.equal(stripModelThinkingSuffix("gemini-4-carbon-high"), "gemini-4-carbon");
  assert.equal(stripModelThinkingSuffix("gemini-4-carbon (high)"), "gemini-4-carbon");
  assert.equal(stripModelThinkingSuffix("gemini-3.8-flash-low"), "gemini-3.8-flash");
  assert.equal(stripModelThinkingSuffix("gemini-3.8-flash (low)"), "gemini-3.8-flash");
  assert.equal(stripModelThinkingSuffix("claude-sonnet-5-5-high"), "claude-sonnet-5-5");

  // Test 5: SQLite WAL Persistence & Cache Hit Rate formula (never exceeds 100% when cachedReadTokens > uncached inputTokens)
  const tmpDbPath = path.join(os.tmpdir(), `agy2api-test-${Date.now()}.db`);
  const testStore = new TelemetryStore(tmpDbPath);
  const rec = testStore.recordCompletedRequest({
    requestId: "req-test-1",
    timestamp: Date.now(),
    sessionId: "sess-test-1",
    workerId: "w-1",
    sessionCache: "HIT",
    requestedModel: "gemini-3.8-flash",
    resolvedBaseModel: "gemini-3.8-flash",
    thinkingLevel: "medium",
    acpModelId: "gemini-3.8-flash-medium",
    actualModelVersion: "gemini-3.8-flash",
    ttftMs: 500,
    durationMs: 1000,
    stream: true,
    finishReason: "stop",
    toolCallsCount: 0,
    inputTokens: 1000, // 1,000 uncached input tokens
    cachedReadTokens: 9000, // 9,000 cached read tokens -> 9000 / (1000 + 9000) = 90.0%
    cachedWriteTokens: 0,
    outputTokens: 100,
    thoughtTokens: 50,
    totalTokens: 10150,
    status: "success",
  });
  assert.equal(rec.cacheHitRate, 90);
  testStore.close();

  // Reopen the SQLite database from disk to verify persistence across restarts
  const reopenedStore = new TelemetryStore(tmpDbPath);
  const snap = reopenedStore.getSnapshot();
  assert.equal(snap.summary.totalRequests, 1);
  assert.equal(snap.summary.cloudCacheHitRate, 90);
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0].sessionId, "sess-test-1");
  assert.equal(snap.sessions[0].status, "CLOSED"); // Leftover ACTIVE session marked CLOSED on restart
  reopenedStore.close();
  fs.rmSync(tmpDbPath, { force: true });

  console.log(
    "   -> Passed! SQLite WAL persistence, unified base models, suffix stripping & bounded cache hit rate (90.0%) verified."
  );
}

async function consumeSseStream(res: Response): Promise<{
  content: string;
  toolCalls: OpenAIToolCallDelta[];
  finishReason: string | null;
  lastModel: string | null;
  usage: OpenAIUsageDetails | null;
}> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls: OpenAIToolCallDelta[] = [];
  let finishReason: string | null = null;
  let lastModel: string | null = null;
  let usage: OpenAIUsageDetails | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === "[DONE]") continue;

      const chunk = JSON.parse(dataStr) as OpenAIChatCompletionChunk;
      if (chunk.model) lastModel = chunk.model;
      if (chunk.usage) usage = chunk.usage;

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.delta?.content) {
        content += choice.delta.content;
      }
      if (choice.delta?.tool_calls) {
        toolCalls.push(...choice.delta.tool_calls);
      }
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }
  }

  return { content, toolCalls, finishReason, lastModel, usage };
}

async function runIntegrationTest() {
  testSlidingWindowParserUnit();
  testUnifiedModelAndEffortResolverUnit();

  console.log("\n3. [E2E Test] Booting WorkerPool and Hono Gateway Server...");
  const pool = new WorkerPool();
  await pool.initialize();
  const app = createGatewayApp(pool);

  const port = 18789;
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Check GET /v1/models returns unified models with thinking_levels
    const modelsRes = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    assert.equal(modelsRes.status, 200);
    const modelsJson = (await modelsRes.json()) as {
      data: Array<{ id: string; thinking_levels: string[] }>;
    };
    console.log(
      "   -> /v1/models Unified IDs:",
      modelsJson.data.map((d) => `${d.id} [${d.thinking_levels.join(",")}]`)
    );
    assert.ok(modelsJson.data.some((d) => d.id === "gemini-4-carbon"));
    assert.ok(modelsJson.data.some((d) => d.id === "gemini-3.8-flash"));

    const tools: OpenAIToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "get_secret_weather_code",
          description:
            "Returns the secret weather code and temperature for a given city.",
          parameters: {
            type: "object",
            properties: {
              city: {
                type: "string",
                description: "City name in English, e.g. Shanghai",
              },
            },
            required: ["city"],
          },
        },
      },
    ];

    const messages: OpenAIMessage[] = [
      {
        role: "system",
        content:
          "You are a helpful assistant. Always use the provided tools when asked about secret weather codes.",
      },
      {
        role: "user",
        content: "What is the secret weather code for Shanghai?",
      },
    ];

    console.log(
      "\n4. [E2E Turn 1] Requesting unified model 'gemini-3.8-flash' with reasoning_effort='low'..."
    );
    const res1 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        reasoning_effort: "low",
        messages,
        tools,
        tool_choice: "required",
        stream: true,
      }),
    });

    assert.equal(res1.status, 200);
    const cacheHeader1 = res1.headers.get("X-Agy2Api-Session-Cache");
    const sessionId1 = res1.headers.get("X-Agy2Api-Session-Id");
    const resolvedModel1 = res1.headers.get("X-Agy2Api-Resolved-Model");
    console.log(
      `   -> Turn 1 Headers: Cache=${cacheHeader1}, SessionId=${sessionId1}, Resolved=${resolvedModel1}`
    );
    assert.equal(cacheHeader1, "MISS");
    assert.equal(resolvedModel1, "gemini-3.8-flash");

    const turn1 = await consumeSseStream(res1);
    console.log("   -> Turn 1 Actual Responding Model:", turn1.lastModel);
    console.log("   -> Turn 1 Usage Details:", JSON.stringify(turn1.usage));
    assert.equal(turn1.lastModel, "gemini-3.8-flash");
    assert.equal(turn1.finishReason, "tool_calls");
    assert.ok(turn1.toolCalls.length >= 1);
    // Verify excludeDefaultComponents: true kept base prompt compact (< 1000 tokens instead of ~7000+)
    assert.ok(
      turn1.usage && turn1.usage.prompt_tokens < 1000,
      `Expected lean prompt_tokens < 1000, got ${turn1.usage?.prompt_tokens}`
    );
    assert.equal(
      turn1.usage!.prompt_tokens + turn1.usage!.completion_tokens,
      turn1.usage!.total_tokens
    );

    const tc = turn1.toolCalls[0];
    messages.push({
      role: "assistant",
      content: turn1.content || null,
      tool_calls: [
        {
          id: tc.id!,
          type: "function",
          function: {
            name: tc.function!.name!,
            arguments: tc.function!.arguments!,
          },
        },
      ],
    });

    messages.push({
      role: "tool",
      tool_call_id: tc.id!,
      name: "get_secret_weather_code",
      content: JSON.stringify({
        secret_code: "OMEGA-SH-7749",
        temperature: "24C",
      }),
    });

    console.log(
      "\n5. [E2E Turn 2] Sending tool result with 'gemini-3.8-flash(medium)' to verify Session Hash HIT across effort switch..."
    );
    const res2 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: "gemini-3.8-flash(medium)",
        messages,
        tools,
        stream: true,
      }),
    });

    assert.equal(res2.status, 200);
    const cacheHeader2 = res2.headers.get("X-Agy2Api-Session-Cache");
    const sessionId2 = res2.headers.get("X-Agy2Api-Session-Id");
    const resolvedModel2 = res2.headers.get("X-Agy2Api-Resolved-Model");
    console.log(
      `   -> Turn 2 Headers: Cache=${cacheHeader2}, SessionId=${sessionId2}, Resolved=${resolvedModel2}`
    );
    assert.equal(cacheHeader2, "HIT");
    assert.equal(sessionId2, sessionId1);
    assert.equal(resolvedModel2, "gemini-3.8-flash");

    const turn2 = await consumeSseStream(res2);
    console.log("   -> Turn 2 Actual Responding Model:", turn2.lastModel);
    console.log("   -> Turn 2 Streamed Content:", JSON.stringify(turn2.content));
    console.log("   -> Turn 2 Usage Details:", JSON.stringify(turn2.usage));
    assert.equal(turn2.lastModel, "gemini-3.8-flash");
    assert.equal(turn2.finishReason, "stop");
    assert.ok(turn2.content.includes("OMEGA-SH-7749"));
    assert.ok(turn2.usage?.prompt_tokens_details !== undefined);

    console.log("\n6. [E2E Gemini 4 Carbon & Native Tool Guard Verification]...");
    const carbonRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: "gemini-4-carbon(low)",
        messages: [
          {
            role: "user",
            content:
              "Check my background tasks if you have native tools; otherwise call get_secret_weather_code for Beijing.",
          },
        ],
        tools,
        stream: false,
      }),
    });
    assert.equal(carbonRes.status, 200);
    assert.equal(carbonRes.headers.get("X-Agy2Api-Resolved-Model"), "gemini-4-carbon");
    assert.equal(carbonRes.headers.get("X-Agy2Api-Thinking-Level"), "low");
    const carbonJson = (await carbonRes.json()) as any;
    console.log("   -> Carbon Actual Model:", carbonJson.model);
    console.log("   -> Carbon Tool Calls:", JSON.stringify(carbonJson.choices[0].message.tool_calls));
    console.log("   -> Carbon Usage:", JSON.stringify(carbonJson.usage));
    assert.equal(carbonJson.model, "gemini-4-carbon");
    assert.equal(carbonJson.choices[0].finish_reason, "tool_calls");
    assert.equal(carbonJson.choices[0].message.tool_calls[0].function.name, "get_secret_weather_code");
    assert.ok(carbonJson.usage.prompt_tokens < 1000);
    assert.equal(
      carbonJson.usage.prompt_tokens + carbonJson.usage.completion_tokens,
      carbonJson.usage.total_tokens
    );

    console.log("\n7. [E2E Dashboard & Telemetry Verification] Checking /api/admin/overview...");
    const dashRes = await fetch(`${baseUrl}/`);
    assert.equal(dashRes.status, 200);
    const dashHtml = await dashRes.text();
    assert.ok(dashHtml.includes("agy2api"));
    assert.ok(dashHtml.includes("顶部 CPA 适配"));

    const overviewRes = await fetch(`${baseUrl}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    const overview = (await overviewRes.json()) as any;
    assert.ok(["side", "top"].includes(overview.config.uiLayout));
    console.log(
      "   -> Telemetry Summary:",
      JSON.stringify(overview.telemetry.summary)
    );
    console.log(
      "   -> Active Session Record:",
      JSON.stringify(overview.telemetry.sessions[0])
    );

    assert.ok(overview.telemetry.summary.totalRequests >= 3);
    assert.ok(overview.telemetry.summary.sessionCacheHits >= 1);
    assert.ok(overview.telemetry.summary.avgTtftMs > 0);
    const activeSess = overview.telemetry.sessions.find((s: any) => s.sessionId === sessionId1);
    assert.ok(activeSess);
    assert.equal(activeSess.turns, 2);
    assert.equal(activeSess.hashHits, 1);
    assert.ok(
      overview.telemetry.recentRequests[0].actualModelVersion.includes("gemini-4-carbon")
    );
    assert.ok(
      overview.telemetry.recentRequests[1].actualModelVersion.includes("gemini-3.8-flash")
    );

    console.log("\nALL UNIT & E2E TESTS PASSED SUCCESSFULLY!");
  } finally {
    pool.shutdown();
    telemetryStore.close();
    server.close();
  }
}

runIntegrationTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
