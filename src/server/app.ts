import crypto from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { config, updateGatewayConfig } from "../config.js";
import {
  buildUnifiedModelCatalog,
  resolveModelAndThinking,
} from "../compiler/model-resolver.js";
import {
  compileDeltaPrompt,
  compileFullPrompt,
} from "../compiler/prompt-compiler.js";
import { ToolCallStreamParser } from "../parser/stream-parser.js";
import { WorkerPool } from "../pool/worker-pool.js";
import { telemetryStore } from "../telemetry/metrics-store.js";
import {
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionRequest,
  OpenAIToolCallDelta,
  OpenAIUsageDetails,
} from "../types/openai.js";
import { renderDashboardHtml } from "./dashboard-ui.js";
import { BRAND_ICON_SVG } from "./brand-icon.js";

export function createGatewayApp(pool: WorkerPool): Hono {
  const app = new Hono();

  // ============================================================================
  // 1. Web Dashboard UI & Admin REST APIs
  // ============================================================================
  app.get("/", (c) => c.html(renderDashboardHtml()));
  app.get("/dashboard", (c) => c.html(renderDashboardHtml()));

  const serveIcon = () =>
    new Response(BRAND_ICON_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=86400",
      },
    });
  app.get("/favicon.svg", serveIcon);
  app.get("/favicon.ico", serveIcon);

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      pool: pool.getStats(),
      telemetry: telemetryStore.getSnapshot().summary,
    });
  });

  app.get("/api/admin/overview", (c) => {
    const rawModels = pool.getAvailableModels();
    const unifiedModels = buildUnifiedModelCatalog(rawModels);
    return c.json({
      pool: pool.getStats(),
      workers: pool.getDetailedWorkers(),
      config,
      unifiedModels,
      telemetry: telemetryStore.getSnapshot(),
    });
  });

  const handleUpdateConfig = async (c: any) => {
    let patch: any = {};
    const rawBody = c.req.query("_body");
    if (rawBody) {
      try {
        patch = JSON.parse(rawBody);
      } catch {}
    } else {
      try {
        patch = await c.req.json();
      } catch {}
    }
    const updated = updateGatewayConfig(patch);
    return c.json({ status: "ok", config: updated });
  };
  app.post("/api/admin/config", handleUpdateConfig);
  app.get("/api/admin/config", handleUpdateConfig);

  const handleSpawnWorker = async (c: any) => {
    try {
      const w = await pool.spawnManualWorker();
      return c.json({ status: "ok", workerId: w.id });
    } catch (err: any) {
      return c.json({ status: "error", message: err?.message || String(err) }, 400);
    }
  };
  app.post("/api/admin/workers/spawn", handleSpawnWorker);
  app.get("/api/admin/workers/spawn", handleSpawnWorker);

  app.delete("/api/admin/workers/:id", (c) => {
    const id = c.req.param("id");
    const ok = pool.terminateWorker(id);
    return c.json({ status: ok ? "ok" : "not_found" });
  });

  const handleDeleteWorker = async (c: any) => {
    let id = c.req.query("id") || "";
    if (!id) {
      try {
        const body = await c.req.json();
        id = body?.id || "";
      } catch {}
    }
    const ok = id ? pool.terminateWorker(id) : false;
    return c.json({ status: ok ? "ok" : "not_found" });
  };
  app.delete("/api/admin/workers", handleDeleteWorker);
  app.get("/api/admin/workers", handleDeleteWorker);

  const handleClearSessionCache = (c: any) => {
    pool.sessionRegistry.clear();
    return c.json({ status: "ok" });
  };
  app.post("/api/admin/sessions/clear-cache", handleClearSessionCache);
  app.get("/api/admin/sessions/clear-cache", handleClearSessionCache);

  app.delete("/api/admin/sessions/:workerId/:sessionId", async (c) => {
    const workerId = c.req.param("workerId");
    const sessionId = c.req.param("sessionId");
    const ok = await pool.closeWorkerSession(workerId, sessionId);
    return c.json({ status: ok ? "ok" : "not_found" });
  });

  const handleDeleteSession = async (c: any) => {
    let workerId = c.req.query("workerId") || "";
    let sessionId = c.req.query("sessionId") || "";
    if (!workerId || !sessionId) {
      try {
        const body = await c.req.json();
        workerId = workerId || body?.workerId || "";
        sessionId = sessionId || body?.sessionId || "";
      } catch {}
    }
    const ok =
      workerId && sessionId
        ? await pool.closeWorkerSession(workerId, sessionId)
        : false;
    return c.json({ status: ok ? "ok" : "not_found" });
  };
  app.delete("/api/admin/sessions", handleDeleteSession);
  app.get("/api/admin/sessions", handleDeleteSession);

  // ============================================================================
  // 2. OpenAI v1 Bearer Auth Middleware
  // ============================================================================
  app.use("/v1/*", async (c, next) => {
    if (config.apiKey) {
      const authHeader = c.req.header("Authorization") || "";
      const token = authHeader.replace(/^Bearer\s+/i, "").trim();
      if (token !== config.apiKey) {
        return c.json(
          {
            error: {
              message:
                "Invalid or missing API key in Authorization Bearer header.",
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
          },
          401
        );
      }
    }
    await next();
  });

  // ============================================================================
  // 3. GET /v1/models (Unified Base Models with Multi-Level Thinking Metadata)
  // ============================================================================
  app.get("/v1/models", (c) => {
    const rawModels = pool.getAvailableModels();
    const unified = buildUnifiedModelCatalog(rawModels);
    const created = Math.floor(Date.now() / 1000);

    const data: Array<Record<string, unknown>> = unified.map((m) => ({
      id: m.id,
      object: "model",
      created,
      owned_by: "antigravity-acp",
      description: m.name,
      thinking_levels: m.thinkingLevels,
      default_thinking_level: m.defaultThinkingLevel,
      reasoning_efforts: m.thinkingLevels,
      capabilities: {
        reasoning: true,
        thinking_levels: m.thinkingLevels,
        default_thinking_level: m.defaultThinkingLevel,
        variants: m.variants,
      },
    }));

    return c.json({
      object: "list",
      data,
    });
  });

  // ============================================================================
  // 4. POST /v1/chat/completions
  // ============================================================================
  app.post("/v1/chat/completions", async (c) => {
    let body: OpenAIChatCompletionRequest;
    try {
      body = await c.req.json<OpenAIChatCompletionRequest>();
    } catch {
      return c.json(
        {
          error: {
            message: "Invalid JSON request body",
            type: "invalid_request_error",
          },
        },
        400
      );
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json(
        {
          error: {
            message: "`messages` must be a non-empty array",
            type: "invalid_request_error",
          },
        },
        400
      );
    }

    // Resolve unified model name + thinking effort (`reasoning_effort` / `thinking` / suffix)
    const resolvedTarget = resolveModelAndThinking(
      body,
      pool.getAvailableModels()
    );
    const {
      requestedModel,
      baseModelId,
      thinkingLevel,
      acpModelId,
    } = resolvedTarget;

    const isStream = Boolean(body.stream);
    const completionId = `chatcmpl-${crypto
      .randomUUID()
      .replace(/-/g, "")
      .slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);

    // Acquire Worker using `baseModelId` for Session Prefix Hash affinity
    let lease = await pool.acquireForRequest(
      baseModelId,
      body.tools,
      body.messages
    );
    let sessionId = lease.sessionId;
    let promptText = "";

    try {
      if (lease.isReusedSession && sessionId) {
        promptText = compileDeltaPrompt(lease.deltaMessages);
      } else {
        const compiled = compileFullPrompt(
          body.messages,
          body.tools,
          body.tool_choice
        );
        try {
          sessionId = await lease.worker.createSession(
            compiled.systemPromptAppend,
            acpModelId
          );
        } catch (firstErr: any) {
          // If the worker had cached an unauthenticated state before login, recycle it and retry once
          pool.terminateWorker(lease.worker.id);
          lease = await pool.acquireForRequest(
            baseModelId,
            body.tools,
            body.messages
          );
          sessionId = await lease.worker.createSession(
            compiled.systemPromptAppend,
            acpModelId
          );
        }
        telemetryStore.registerNewSession(
          sessionId,
          lease.worker.id,
          baseModelId,
          acpModelId,
          thinkingLevel
        );
        promptText = compiled.promptText;
      }
    } catch (err: any) {
      pool.terminateWorker(lease.worker.id);
      return c.json(
        {
          error: {
            message: `Failed to initialize ACP session: ${
              err?.message || String(err)
            }`,
            type: "server_error",
          },
        },
        500
      );
    }

    c.header("X-Agy2Api-Session-Cache", lease.isReusedSession ? "HIT" : "MISS");
    c.header("X-Agy2Api-Session-Id", sessionId);
    c.header("X-Agy2Api-Worker-Id", lease.worker.id);
    c.header("X-Agy2Api-Resolved-Model", baseModelId);
    c.header("X-Agy2Api-Thinking-Level", thinkingLevel);

    const parser = new ToolCallStreamParser();
    const externalToolNames = new Set(
      (body.tools || []).map((t) => t.function.name)
    );

    const buildOpenAIUsage = (
      acpUsage?: {
        inputTokens: number;
        outputTokens: number;
        cachedReadTokens?: number;
        cachedWriteTokens?: number;
        thoughtTokens?: number;
        totalTokens: number;
      }
    ): OpenAIUsageDetails => {
      const uncachedInput = acpUsage?.inputTokens ?? 0;
      const outputTokens = acpUsage?.outputTokens ?? 0;
      const cachedRead = acpUsage?.cachedReadTokens ?? 0;
      const cachedWrite = acpUsage?.cachedWriteTokens ?? 0;
      const thoughtTokens = acpUsage?.thoughtTokens ?? 0;
      const totalPromptTokens = uncachedInput + cachedRead + cachedWrite;
      // ACP `outputTokens` already includes `thoughtTokens` (matching OpenAI `completion_tokens`)
      const totalTokens = totalPromptTokens + outputTokens;

      return {
        prompt_tokens: totalPromptTokens,
        completion_tokens: outputTokens,
        total_tokens: totalTokens,
        prompt_tokens_details: {
          cached_tokens: cachedRead,
          cache_write_tokens: cachedWrite,
        },
        completion_tokens_details: {
          reasoning_tokens: thoughtTokens,
        },
      };
    };

    // ------------------------------------------------------------------------
    // Streaming SSE Mode
    // ------------------------------------------------------------------------
    if (isStream) {
      return streamSSE(c, async (stream) => {
        const abortController = new AbortController();
        stream.onAbort(() => {
          abortController.abort();
        });

        let currentRespondingModel = baseModelId;

        const makeChunk = (
          delta: OpenAIChatCompletionChunk["choices"][0]["delta"],
          finishReason: "stop" | "tool_calls" | "length" | null = null,
          usage?: OpenAIUsageDetails
        ): OpenAIChatCompletionChunk => ({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: currentRespondingModel,
          choices: [
            {
              index: 0,
              delta,
              finish_reason: finishReason,
            },
          ],
          ...(usage ? { usage } : {}),
        });

        const sendChunk = (chunk: OpenAIChatCompletionChunk) => {
          stream.writeSSE({ data: JSON.stringify(chunk) });
        };

        sendChunk(makeChunk({ role: "assistant" }));

        try {
          const promptRes = await lease.worker.runPrompt(
            sessionId!,
            promptText,
            acpModelId,
            {
              onActualModelDetected: (detectedVer) => {
                currentRespondingModel = detectedVer;
              },
              onThoughtChunk: (thoughtText) => {
                sendChunk(makeChunk({ reasoning_content: thoughtText }));
              },
              onMessageChunk: (msgText) => {
                parser.feed(
                  msgText,
                  (contentDelta) => {
                    sendChunk(makeChunk({ content: contentDelta }));
                  },
                  (toolCallDelta: OpenAIToolCallDelta) => {
                    sendChunk(makeChunk({ tool_calls: [toolCallDelta] }));
                  }
                );
              },
              onNativeToolCall: (nativeToolName, rawInput) => {
                if (externalToolNames.has(nativeToolName)) {
                  parser.injectDirectToolCall(
                    nativeToolName,
                    rawInput,
                    (toolCallDelta) => {
                      sendChunk(makeChunk({ tool_calls: [toolCallDelta] }));
                    }
                  );
                }
              },
            },
            abortController.signal
          );

          currentRespondingModel = promptRes.actualModelVersion || currentRespondingModel;

          const finishReason = parser.flush(
            (contentDelta) => {
              sendChunk(makeChunk({ content: contentDelta }));
            },
            (toolCallDelta) => {
              sendChunk(makeChunk({ tool_calls: [toolCallDelta] }));
            }
          );

          const usageDetails = buildOpenAIUsage(promptRes.usage);
          sendChunk(makeChunk({}, finishReason, usageDetails));
          await stream.writeSSE({ data: "[DONE]" });

          const assistantMsg = parser.toAssistantMessage();
          pool.sessionRegistry.registerTurnState(
            baseModelId,
            body.tools,
            [...body.messages, assistantMsg],
            lease.worker.id,
            sessionId!
          );

          telemetryStore.recordCompletedRequest({
            requestId: completionId,
            timestamp: Date.now(),
            sessionId: sessionId!,
            workerId: lease.worker.id,
            sessionCache: lease.isReusedSession ? "HIT" : "MISS",
            requestedModel,
            resolvedBaseModel: baseModelId,
            thinkingLevel,
            acpModelId,
            actualModelVersion: promptRes.actualModelVersion,
            ttftMs: promptRes.ttftMs,
            durationMs: promptRes.durationMs,
            stream: true,
            finishReason,
            toolCallsCount: assistantMsg.tool_calls?.length ?? 0,
            inputTokens: promptRes.usage?.inputTokens ?? 0,
            cachedReadTokens: promptRes.usage?.cachedReadTokens ?? 0,
            cachedWriteTokens: promptRes.usage?.cachedWriteTokens ?? 0,
            outputTokens: promptRes.usage?.outputTokens ?? 0,
            thoughtTokens: promptRes.usage?.thoughtTokens ?? 0,
            totalTokens: promptRes.usage?.totalTokens ?? 0,
            status: "success",
          });
        } catch (err: any) {
          telemetryStore.recordCompletedRequest({
            requestId: completionId,
            timestamp: Date.now(),
            sessionId: sessionId!,
            workerId: lease.worker.id,
            sessionCache: lease.isReusedSession ? "HIT" : "MISS",
            requestedModel,
            resolvedBaseModel: baseModelId,
            thinkingLevel,
            acpModelId,
            actualModelVersion: baseModelId,
            ttftMs: 0,
            durationMs: 0,
            stream: true,
            finishReason: "error",
            toolCallsCount: 0,
            inputTokens: 0,
            cachedReadTokens: 0,
            cachedWriteTokens: 0,
            outputTokens: 0,
            thoughtTokens: 0,
            totalTokens: 0,
            status: "error",
            errorMessage: err?.message || String(err),
          });
          sendChunk(
            makeChunk(
              { content: `\n[Gateway Error: ${err?.message || String(err)}]` },
              "stop"
            )
          );
          await stream.writeSSE({ data: "[DONE]" });
        } finally {
          pool.releaseWorker(lease.worker);
        }
      });
    }

    // ------------------------------------------------------------------------
    // Non-Streaming JSON Mode
    // ------------------------------------------------------------------------
    let reasoningBuffer = "";
    try {
      const promptRes = await lease.worker.runPrompt(
        sessionId,
        promptText,
        acpModelId,
        {
          onThoughtChunk: (thoughtText) => {
            reasoningBuffer += thoughtText;
          },
          onMessageChunk: (msgText) => {
            parser.feed(
              msgText,
              () => {},
              () => {}
            );
          },
          onNativeToolCall: (nativeToolName, rawInput) => {
            if (externalToolNames.has(nativeToolName)) {
              parser.injectDirectToolCall(nativeToolName, rawInput, () => {});
            }
          },
        },
        c.req.raw.signal
      );

      const finishReason = parser.flush(
        () => {},
        () => {}
      );
      const assistantMsg = parser.toAssistantMessage();
      const usageDetails = buildOpenAIUsage(promptRes.usage);

      pool.sessionRegistry.registerTurnState(
        baseModelId,
        body.tools,
        [...body.messages, assistantMsg],
        lease.worker.id,
        sessionId
      );

      telemetryStore.recordCompletedRequest({
        requestId: completionId,
        timestamp: Date.now(),
        sessionId,
        workerId: lease.worker.id,
        sessionCache: lease.isReusedSession ? "HIT" : "MISS",
        requestedModel,
        resolvedBaseModel: baseModelId,
        thinkingLevel,
        acpModelId,
        actualModelVersion: promptRes.actualModelVersion,
        ttftMs: promptRes.ttftMs,
        durationMs: promptRes.durationMs,
        stream: false,
        finishReason,
        toolCallsCount: assistantMsg.tool_calls?.length ?? 0,
        inputTokens: promptRes.usage?.inputTokens ?? 0,
        cachedReadTokens: promptRes.usage?.cachedReadTokens ?? 0,
        cachedWriteTokens: promptRes.usage?.cachedWriteTokens ?? 0,
        outputTokens: promptRes.usage?.outputTokens ?? 0,
        thoughtTokens: promptRes.usage?.thoughtTokens ?? 0,
        totalTokens: promptRes.usage?.totalTokens ?? 0,
        status: "success",
      });

      const actualModel = promptRes.actualModelVersion || baseModelId;
      c.header("X-Agy2Api-Actual-Model", actualModel);
      c.header("X-Agy2Api-TTFT-Ms", String(promptRes.ttftMs));

      return c.json({
        id: completionId,
        object: "chat.completion",
        created,
        model: actualModel,
        choices: [
          {
            index: 0,
            message: {
              ...assistantMsg,
              ...(reasoningBuffer
                ? { reasoning_content: reasoningBuffer }
                : {}),
            },
            finish_reason: finishReason,
          },
        ],
        usage: usageDetails,
      });
    } catch (err: any) {
      telemetryStore.recordCompletedRequest({
        requestId: completionId,
        timestamp: Date.now(),
        sessionId,
        workerId: lease.worker.id,
        sessionCache: lease.isReusedSession ? "HIT" : "MISS",
        requestedModel,
        resolvedBaseModel: baseModelId,
        thinkingLevel,
        acpModelId,
        actualModelVersion: baseModelId,
        ttftMs: 0,
        durationMs: 0,
        stream: false,
        finishReason: "error",
        toolCallsCount: 0,
        inputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        outputTokens: 0,
        thoughtTokens: 0,
        totalTokens: 0,
        status: "error",
        errorMessage: err?.message || String(err),
      });
      return c.json(
        {
          error: {
            message: err?.message || String(err),
            type: "server_error",
          },
        },
        500
      );
    } finally {
      pool.releaseWorker(lease.worker);
    }
  });

  return app;
}
