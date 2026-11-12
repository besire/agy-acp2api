import crypto from "node:crypto";
import { Context, Hono, Next } from "hono";
import {
  config,
  DEFAULT_API_KEY,
  extraAllowedHosts,
  isLoopbackHost,
  publicConfig,
  updateGatewayConfig,
} from "../config.js";
import { buildUnifiedModelCatalog } from "../compiler/model-resolver.js";
import { ChatService } from "../core/chat-service.js";
import { WorkerPool } from "../pool/worker-pool.js";
import { openAIChatCompletions } from "../protocols/openai/chat-completions.js";
import { telemetryStore } from "../telemetry/metrics-store.js";
import { renderDashboardHtml } from "./dashboard-ui.js";
import { BRAND_ICON_SVG } from "./brand-icon.js";
import { chatEndpoint } from "./chat-endpoint.js";

/** Header the dashboard (and the CPA plugin) use to authenticate admin calls. */
export const ADMIN_KEY_HEADER = "X-Agy2Api-Key";

function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value).digest();
}

/**
 * Accepts the gateway API key from `X-Agy2Api-Key` or `Authorization: Bearer`.
 * Header-only on purpose: a cross-site page cannot attach either without a CORS preflight,
 * which this server never approves, so admin routes are not CSRF-able.
 */
function hasValidApiKey(c: Context): boolean {
  const fromHeader = c.req.header(ADMIN_KEY_HEADER)?.trim();
  const fromBearer = (c.req.header("Authorization") || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const expected = digest(config.apiKey);
  return [fromHeader, fromBearer].some(
    (candidate) => !!candidate && crypto.timingSafeEqual(digest(candidate), expected)
  );
}

function hostnameFromHostHeader(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

export function createGatewayApp(pool: WorkerPool): Hono {
  const app = new Hono();

  // ============================================================================
  // 0. DNS-rebinding guard: while bound to loopback, only accept loopback Host headers
  // ============================================================================
  app.use("*", async (c, next) => {
    if (isLoopbackHost(config.host)) {
      const hostname = hostnameFromHostHeader(c.req.header("Host") || "");
      if (!isLoopbackHost(hostname) && !extraAllowedHosts.includes(hostname)) {
        return c.json(
          {
            error: {
              message: `Host '${hostname}' is not allowed. Add it to AGY2API_ALLOWED_HOSTS if this is intended.`,
              type: "forbidden",
            },
          },
          403
        );
      }
    }
    await next();
  });

  // ============================================================================
  // 1. Web Dashboard UI (static, no secrets) & liveness probe
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
    const stats = pool.getStats();
    return c.json({
      status: stats.totalWorkers > 0 ? "ok" : "degraded",
      workers: stats.totalWorkers,
    });
  });

  // ============================================================================
  // 2. Admin REST APIs (require the gateway API key; state changes only via POST/DELETE)
  // ============================================================================
  const requireApiKey = async (c: Context, next: Next) => {
    if (!hasValidApiKey(c)) {
      return c.json(
        {
          status: "error",
          message: `Missing or invalid API key (send it as '${ADMIN_KEY_HEADER}' or 'Authorization: Bearer').`,
          error: {
            message: "Invalid or missing API key.",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        },
        401
      );
    }
    await next();
  };
  app.use("/api/admin/*", requireApiKey);

  app.get("/api/admin/overview", (c) => {
    const rawModels = pool.getAvailableModels();
    const unifiedModels = buildUnifiedModelCatalog(rawModels);
    return c.json({
      pool: pool.getStats(),
      workers: pool.getDetailedWorkers(),
      config: publicConfig(),
      agent: pool.getAgentInfo(),
      unifiedModels,
      telemetry: telemetryStore.getSnapshot(),
    });
  });

  app.post("/api/admin/config", async (c) => {
    let patch: any = {};
    try {
      patch = await c.req.json();
    } catch {
      return c.json({ status: "error", message: "Invalid JSON body" }, 400);
    }
    if (
      typeof patch?.apiKey === "string" &&
      patch.apiKey.trim() === DEFAULT_API_KEY &&
      !isLoopbackHost(config.host)
    ) {
      return c.json(
        {
          status: "error",
          message: "The default API key is not allowed while listening on a non-loopback address.",
        },
        400
      );
    }
    updateGatewayConfig(patch);
    return c.json({ status: "ok", config: publicConfig() });
  });

  app.post("/api/admin/workers/spawn", async (c) => {
    try {
      const w = await pool.spawnManualWorker();
      return c.json({ status: "ok", workerId: w.id });
    } catch (err: any) {
      return c.json({ status: "error", message: err?.message || String(err) }, 400);
    }
  });

  app.delete("/api/admin/workers/:id", (c) => {
    const ok = pool.terminateWorker(c.req.param("id"));
    return c.json({ status: ok ? "ok" : "not_found" }, ok ? 200 : 404);
  });

  app.delete("/api/admin/workers", (c) => {
    const id = c.req.query("id") || "";
    const ok = id ? pool.terminateWorker(id) : false;
    return c.json({ status: ok ? "ok" : "not_found" }, ok ? 200 : 404);
  });

  app.post("/api/admin/sessions/clear-cache", (c) => {
    pool.sessionRegistry.clear();
    return c.json({ status: "ok" });
  });

  const closeSession = async (c: Context, workerId: string, sessionId: string) => {
    const ok =
      workerId && sessionId
        ? await pool.closeWorkerSession(workerId, sessionId)
        : false;
    return c.json({ status: ok ? "ok" : "not_found" }, ok ? 200 : 404);
  };
  app.delete("/api/admin/sessions/:workerId/:sessionId", (c) =>
    closeSession(c, c.req.param("workerId"), c.req.param("sessionId"))
  );
  app.delete("/api/admin/sessions", (c) =>
    closeSession(c, c.req.query("workerId") || "", c.req.query("sessionId") || "")
  );

  // ============================================================================
  // 3. OpenAI v1 Bearer Auth Middleware
  // ============================================================================
  app.use("/v1/*", async (c, next) => {
    if (!hasValidApiKey(c)) {
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
    await next();
  });

  // ============================================================================
  // 4. GET /v1/models (Unified Base Models with Multi-Level Thinking Metadata)
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
  // 5. POST /v1/chat/completions
  // ============================================================================
  const chatService = new ChatService(pool);
  app.post("/v1/chat/completions", chatEndpoint(openAIChatCompletions, chatService));

  return app;
}
