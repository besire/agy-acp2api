import fs from "node:fs";
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
  workerIdleTtlMs: number;
  sessionTtlMs: number;
  requestTimeoutMs: number;
  uiLayout: UiLayout;
}

const SETTINGS_FILE_PATH = path.resolve(process.cwd(), "settings.json");

const defaultConfig: GatewayConfig = {
  host: process.env.AGY2API_HOST || "127.0.0.1",
  port: parseInt(process.env.AGY2API_PORT || "8787", 10),
  apiKey: process.env.AGY2API_KEY || "sk-agy2api-local-key",
  agyBin: process.env.AGY_BIN || "agy",
  defaultModel: process.env.AGY_DEFAULT_MODEL || "gemini-3.8-flash",
  defaultThinkingLevel:
    (process.env.AGY_DEFAULT_THINKING_LEVEL as ThinkingLevel) || "medium",
  minWorkers: parseInt(process.env.AGY_MIN_WORKERS || "1", 10),
  maxWorkers: parseInt(process.env.AGY_MAX_WORKERS || "6", 10),
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
