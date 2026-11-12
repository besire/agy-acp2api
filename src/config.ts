import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ThinkingLevel = "low" | "medium" | "high";
export type UiLayout = "side" | "top";

export interface GatewayConfig {
  host: string;
  port: number;
  apiKey: string;
  agyBin: string;
  defaultModel: string;
  defaultThinkingLevel: ThinkingLevel;
  minWorkers: number;
  maxWorkers: number;
  maxSessionsPerWorker: number;
  workerIdleTtlMs: number;
  sessionTtlMs: number;
  requestTimeoutMs: number;
  uiLayout: UiLayout;
}

export const DEFAULT_API_KEY = "sk-agy2api-local-key";

/**
 * Filesystem locations resolved once at startup. Not editable from the dashboard.
 * - `AGY2API_HOME`: where `settings.json` and `data/telemetry.db` live (default: cwd)
 * - `AGY_GEMINI_HOME`: base dir holding `antigravity-cli/` auth and worker sandboxes (default: ~/.gemini)
 * - `AGY2API_ALLOWED_HOSTS`: extra `Host` header names accepted while bound to loopback
 */
const appHome = path.resolve(process.env.AGY2API_HOME || process.cwd());

export const runtimePaths = {
  appHome,
  settingsFile: path.join(appHome, "settings.json"),
  dataDir: path.join(appHome, "data"),
  geminiBaseDir: path.resolve(
    process.env.AGY_GEMINI_HOME || path.join(os.homedir(), ".gemini")
  ),
};

export const extraAllowedHosts: string[] = (process.env.AGY2API_ALLOWED_HOSTS || "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

const SETTINGS_FILE_PATH = runtimePaths.settingsFile;

const defaultConfig: GatewayConfig = {
  host: process.env.AGY2API_HOST || "127.0.0.1",
  port: parseInt(process.env.AGY2API_PORT || "8787", 10),
  apiKey: process.env.AGY2API_KEY || DEFAULT_API_KEY,
  agyBin: process.env.AGY_BIN || "agy",
  defaultModel: process.env.AGY_DEFAULT_MODEL || "gemini-3.8-flash",
  defaultThinkingLevel:
    (process.env.AGY_DEFAULT_THINKING_LEVEL as ThinkingLevel) || "medium",
  minWorkers: parseInt(process.env.AGY_MIN_WORKERS || "1", 10),
  maxWorkers: parseInt(process.env.AGY_MAX_WORKERS || "2", 10),
  maxSessionsPerWorker: parseInt(
    process.env.AGY_MAX_SESSIONS_PER_WORKER || "16",
    10
  ),
  workerIdleTtlMs: parseInt(
    process.env.AGY_WORKER_IDLE_TTL_MS || "180000",
    10
  ),
  sessionTtlMs: parseInt(process.env.AGY_SESSION_TTL_MS || "600000", 10),
  requestTimeoutMs: parseInt(
    process.env.AGY_REQUEST_TIMEOUT_MS || "300000",
    10
  ),
  uiLayout: (process.env.AGY_UI_LAYOUT as UiLayout) || "side",
};

function loadPersistedSettings(): Partial<GatewayConfig> {
  try {
    if (fs.existsSync(SETTINGS_FILE_PATH)) {
      const raw = fs.readFileSync(SETTINGS_FILE_PATH, "utf-8");
      return JSON.parse(raw);
    }
  } catch {
    // Ignore corrupted settings file and use defaults
  }
  return {};
}

export const config: GatewayConfig = {
  ...defaultConfig,
  ...loadPersistedSettings(),
};

type ConfigChangeListener = (newConfig: GatewayConfig) => void;
const listeners: ConfigChangeListener[] = [];

export function onConfigChange(listener: ConfigChangeListener): void {
  listeners.push(listener);
}

export function updateGatewayConfig(
  patch: Partial<GatewayConfig>
): GatewayConfig {
  if (typeof patch.apiKey === "string" && patch.apiKey.trim()) {
    config.apiKey = patch.apiKey.trim();
  }
  if (typeof patch.defaultModel === "string" && patch.defaultModel.trim()) {
    config.defaultModel = patch.defaultModel.trim();
  }
  if (
    patch.defaultThinkingLevel &&
    ["low", "medium", "high"].includes(patch.defaultThinkingLevel)
  ) {
    config.defaultThinkingLevel = patch.defaultThinkingLevel;
  }
  if (typeof patch.minWorkers === "number" && patch.minWorkers >= 0) {
    config.minWorkers = Math.max(0, Math.min(20, Math.floor(patch.minWorkers)));
  }
  if (typeof patch.maxWorkers === "number" && patch.maxWorkers >= 1) {
    config.maxWorkers = Math.max(
      Math.max(1, config.minWorkers),
      Math.min(32, Math.floor(patch.maxWorkers))
    );
  }
  if (
    typeof patch.maxSessionsPerWorker === "number" &&
    patch.maxSessionsPerWorker >= 1
  ) {
    config.maxSessionsPerWorker = Math.min(
      256,
      Math.floor(patch.maxSessionsPerWorker)
    );
  }
  if (
    typeof patch.workerIdleTtlMs === "number" &&
    patch.workerIdleTtlMs >= 5000
  ) {
    config.workerIdleTtlMs = Math.floor(patch.workerIdleTtlMs);
  }
  if (typeof patch.sessionTtlMs === "number" && patch.sessionTtlMs >= 5000) {
    config.sessionTtlMs = Math.floor(patch.sessionTtlMs);
  }
  if (
    typeof patch.requestTimeoutMs === "number" &&
    patch.requestTimeoutMs >= 5000
  ) {
    config.requestTimeoutMs = Math.floor(patch.requestTimeoutMs);
  }
  if (patch.uiLayout && ["side", "top"].includes(patch.uiLayout)) {
    config.uiLayout = patch.uiLayout;
  }

  // Persist to settings.json
  try {
    const toSave = {
      apiKey: config.apiKey,
      defaultModel: config.defaultModel,
      defaultThinkingLevel: config.defaultThinkingLevel,
      minWorkers: config.minWorkers,
      maxWorkers: config.maxWorkers,
      maxSessionsPerWorker: config.maxSessionsPerWorker,
      workerIdleTtlMs: config.workerIdleTtlMs,
      sessionTtlMs: config.sessionTtlMs,
      requestTimeoutMs: config.requestTimeoutMs,
      uiLayout: config.uiLayout,
    };
    fs.writeFileSync(
      SETTINGS_FILE_PATH,
      JSON.stringify(toSave, null, 2),
      "utf-8"
    );
  } catch {
    // Non-fatal if disk is read-only
  }

  for (const fn of listeners) {
    try {
      fn(config);
    } catch {}
  }

  return { ...config };
}

/**
 * Config as exposed over HTTP: never echoes the API key back.
 */
export function publicConfig(): Omit<GatewayConfig, "apiKey"> & {
  apiKeyIsDefault: boolean;
} {
  const { apiKey, ...rest } = config;
  return { ...rest, apiKeyIsDefault: apiKey === DEFAULT_API_KEY };
}
