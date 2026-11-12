/**
 * Black-box harness: runs the gateway as a separate process against the fake `agy`,
 * and observes it only through HTTP and the fake's ACP message log.
 *
 * Set AGY2API_TEST_SERVER_CMD (whitespace-separated argv) to run the same suite against
 * another implementation; it must honour the env vars documented in the README.
 */
import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
export const FAKE_AGY = path.join(REPO_ROOT, "test", "fixtures", "fake-agy.mjs");
export const TEST_API_KEY = "sk-test-blackbox-key";

export interface AcpLogEntry {
  t: number;
  pid: number;
  event?: string;
  dir?: "in";
  msg?: { id?: number | string; method?: string; params?: any };
}

export interface GatewayOptions {
  env?: Record<string, string>;
  /** Fake agy control file contents at boot (e.g. `{ mode: "fail-start" }`). */
  fakeControl?: Record<string, unknown>;
  /** Wait until at least one worker is up (default true). */
  waitForWorkers?: boolean;
}

export interface Gateway {
  baseUrl: string;
  port: number;
  home: string;
  output(): string;
  acpLog(): AcpLogEntry[];
  acpRequests(method: string): NonNullable<AcpLogEntry["msg"]>[];
  setFakeControl(control: Record<string, unknown>): void;
  fetch(pathname: string, init?: RequestInit & { auth?: boolean }): Promise<Response>;
  chat(body: Record<string, unknown>): Promise<Response>;
  stop(): Promise<void>;
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function serverCommand(): string[] {
  const custom = process.env.AGY2API_TEST_SERVER_CMD?.trim();
  if (custom) return custom.split(/\s+/);
  return [process.execPath, "--no-warnings", "--import", "tsx", "src/index.ts", "--no-open"];
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  { timeoutMs = 10_000, intervalMs = 50, what = "condition" } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v) return v as T;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${what}${lastErr ? `: ${String(lastErr)}` : ""}`);
}

function baseEnv(home: string, port: number, logPath: string, controlPath: string) {
  return {
    ...process.env,
    AGY_BIN: FAKE_AGY,
    AGY2API_HOME: home,
    AGY_GEMINI_HOME: path.join(home, "gemini"),
    AGY2API_HOST: "127.0.0.1",
    AGY2API_PORT: String(port),
    AGY2API_KEY: TEST_API_KEY,
    AGY_MIN_WORKERS: "1",
    AGY_MAX_WORKERS: "2",
    AGY_POOL_SWEEP_INTERVAL_MS: "100",
    AGY_RESPAWN_BASE_DELAY_MS: "100",
    AGY_RESPAWN_MAX_DELAY_MS: "1000",
    FAKE_AGY_LOG: logPath,
    FAKE_AGY_CONTROL: controlPath,
  };
}

function prepareHome(control?: Record<string, unknown>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy2api-test-"));
  const logPath = path.join(home, "acp.log.jsonl");
  const controlPath = path.join(home, "fake-control.json");
  fs.writeFileSync(controlPath, JSON.stringify(control ?? {}));
  return { home, logPath, controlPath };
}

function spawnServer(env: NodeJS.ProcessEnv): { child: ChildProcess; output: () => string } {
  const [cmd, ...args] = serverCommand();
  const child = spawn(cmd, args, { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  return { child, output: () => out };
}

export async function startGateway(opts: GatewayOptions = {}): Promise<Gateway> {
  const { home, logPath, controlPath } = prepareHome(opts.fakeControl);
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { child, output } = spawnServer({
    ...baseEnv(home, port, logPath, controlPath),
    ...opts.env,
  });

  let exited = false;
  const exitPromise = new Promise<void>((resolve) =>
    child.once("exit", () => {
      exited = true;
      resolve();
    })
  );

  const gw: Gateway = {
    baseUrl,
    port,
    home,
    output,
    acpLog() {
      if (!fs.existsSync(logPath)) return [];
      return fs
        .readFileSync(logPath, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as AcpLogEntry);
    },
    acpRequests(method) {
      return gw
        .acpLog()
        .filter((e) => e.dir === "in" && e.msg?.method === method)
        .map((e) => e.msg!);
    },
    setFakeControl(control) {
      fs.writeFileSync(controlPath, JSON.stringify(control));
    },
    fetch(pathname, init = {}) {
      const { auth = true, headers, ...rest } = init;
      const h = new Headers(headers);
      if (auth && !h.has("Authorization") && !h.has("X-Agy2Api-Key")) {
        h.set("Authorization", `Bearer ${TEST_API_KEY}`);
      }
      return fetch(baseUrl + pathname, { ...rest, headers: h });
    },
    chat(body) {
      return gw.fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async stop() {
      if (!exited) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
        await exitPromise;
        clearTimeout(timer);
      }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };

  try {
    await waitFor(
      async () => {
        if (exited) throw new Error(`gateway exited early:\n${output()}`);
        const res = await fetch(`${baseUrl}/health`);
        if (!res.ok) return false;
        // Only liveness matters here; tolerate older `/health` shapes (`pool.totalWorkers`)
        const health = (await res.json()) as {
          workers?: number;
          pool?: { totalWorkers?: number };
        };
        const workers = health.workers ?? health.pool?.totalWorkers ?? 0;
        return opts.waitForWorkers === false || workers > 0;
      },
      { timeoutMs: 15_000, what: "gateway readiness" }
    );
    if (opts.waitForWorkers !== false) {
      // `workers` counts STARTING ones too; wait until one is actually serving
      await waitFor(
        async () => {
          const res = await gw.fetch("/api/admin/overview");
          const body = (await res.json()) as { pool: { idleWorkers: number } };
          return body.pool.idleWorkers > 0;
        },
        { timeoutMs: 10_000, what: "an idle worker" }
      );
    }
  } catch (err) {
    await gw.stop();
    throw new Error(`${String(err)}\n--- gateway output ---\n${output()}`);
  }
  return gw;
}

/**
 * Runs the gateway expecting it to refuse to start; resolves with exit code and output.
 */
export async function runGatewayExpectingExit(
  env: Record<string, string>
): Promise<{ code: number | null; output: string }> {
  const { home, logPath, controlPath } = prepareHome();
  const port = await getFreePort();
  const { child, output } = spawnServer({
    ...baseEnv(home, port, logPath, controlPath),
    ...env,
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const code = await new Promise<number | null>((resolve) =>
    child.once("exit", (c) => resolve(c))
  );
  clearTimeout(timer);
  fs.rmSync(home, { recursive: true, force: true });
  return { code, output: output() };
}

/**
 * Raw HTTP request with an arbitrary Host header (fetch does not allow overriding it).
 */
export function requestWithHost(
  port: number,
  pathname: string,
  hostHeader: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, headers: { Host: hostHeader } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

export interface ParsedStream {
  content: string;
  reasoning: string;
  toolCalls: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  finishReason: string | null;
  usage: any;
  sawDone: boolean;
}

export async function readSse(res: Response): Promise<ParsedStream> {
  const text = await res.text();
  const out: ParsedStream = {
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: null,
    usage: null,
    sawDone: false,
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") {
      out.sawDone = true;
      continue;
    }
    const chunk = JSON.parse(data);
    if (chunk.usage) out.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.delta?.content) out.content += choice.delta.content;
    if (choice.delta?.reasoning_content) out.reasoning += choice.delta.reasoning_content;
    if (choice.delta?.tool_calls) out.toolCalls.push(...choice.delta.tool_calls);
    if (choice.finish_reason) out.finishReason = choice.finish_reason;
  }
  return out;
}
