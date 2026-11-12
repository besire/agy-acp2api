import { exec } from "node:child_process";
import { serve } from "@hono/node-server";
import { config, DEFAULT_API_KEY, isLoopbackHost } from "./config.js";
import { WorkerPool } from "./pool/worker-pool.js";
import { createGatewayApp } from "./server/app.js";
import { telemetryStore } from "./telemetry/metrics-store.js";

function parseCliArgs() {
  const args = process.argv.slice(2);
  let openBrowser = process.env.AGY2API_OPEN_BROWSER === "1";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--open" || arg === "-o") {
      openBrowser = true;
    } else if (arg === "--no-open") {
      openBrowser = false;
    } else if ((arg === "--port" || arg === "-p") && args[i + 1]) {
      const p = parseInt(args[++i], 10);
      if (!Number.isNaN(p) && p > 0 && p < 65536) config.port = p;
    } else if ((arg === "--host" || arg === "-H") && args[i + 1]) {
      config.host = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
agy-acp2api - ACP-to-OpenAI v1 API Gateway for Antigravity CLI

Usage:
  agy-acp2api [options]

Options:
  -p, --port <port>   Listen port (default: ${config.port}, env: AGY2API_PORT)
  -H, --host <host>   Listen host (default: ${config.host}, env: AGY2API_HOST)
  -o, --open          Automatically open Web Dashboard in default browser
      --no-open       Do not open browser automatically
  -h, --help          Show this help message
`);
      process.exit(0);
    }
  }
  return { openBrowser };
}

function openUrlInBrowser(url: string) {
  const platform = process.platform;
  const cmd =
    platform === "win32"
      ? `start "" "${url}"`
      : platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {
    // Ignore errors on headless systems
  });
}

async function main() {
  const { openBrowser } = parseCliArgs();

  if (!isLoopbackHost(config.host) && config.apiKey === DEFAULT_API_KEY) {
    console.error(
      `[agy-acp2api] Refusing to listen on ${config.host} with the default API key. ` +
        "Set AGY2API_KEY (or apiKey in settings.json) to a private value first."
    );
    process.exit(1);
  }

  console.log(
    `[agy-acp2api] Initializing ACP Warm Worker Pool (min=${config.minWorkers}, max=${config.maxWorkers})...`
  );
  const pool = new WorkerPool();
  const init = await pool.initialize();
  if (init.failed > 0) {
    console.warn(
      `[agy-acp2api] ${init.failed} worker(s) failed to start; retrying in the background with backoff. ` +
        "Check that `agy` is installed and logged in."
    );
  }
  console.log(`[agy-acp2api] Warm Worker Pool ready:`, pool.getStats());

  const app = createGatewayApp(pool);

  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.host,
      port: config.port,
    },
    (info) => {
      const displayHost =
        info.address === "0.0.0.0" || info.address === "::"
          ? "127.0.0.1"
          : info.address;
      const dashboardUrl = `http://${displayHost}:${info.port}/`;
      console.log(`[agy-acp2api] Web Dashboard UI:    ${dashboardUrl}`);
      console.log(`[agy-acp2api] OpenAI v1 Endpoint:  ${dashboardUrl}v1`);
      console.log(
        `[agy-acp2api] Default Model:       ${config.defaultModel} (effort: ${config.defaultThinkingLevel})`
      );
      if (openBrowser) {
        openUrlInBrowser(dashboardUrl);
      }
    }
  );

  const gracefulShutdown = () => {
    console.log(
      "\n[agy-acp2api] Shutting down gateway and cleaning up worker sandboxes..."
    );
    pool.shutdown();
    telemetryStore.close();
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);
}

main().catch((err) => {
  console.error("[agy-acp2api] Fatal startup error:", err);
  process.exit(1);
});
