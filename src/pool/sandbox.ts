import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const GATEWAY_AGENT_NAME = "gateway";

export interface WorkerSandboxEnv {
  workerId: string;
  relAppDataDir: string;
  absGeminiDir: string;
  absAppDataDir: string;
  agentName: string;
  jailCwd: string;
}

const EXCLUDED_WORKER_FILES = new Set([
  "conversation_summaries.db",
  "conversation_summaries.db-wal",
  "conversation_summaries.db-shm",
  "cli.log",
  "history.jsonl",
]);

const EXCLUDED_WORKER_DIRS = new Set([
  "annotations",
  "bin",
  "brain",
  "builtin",
  "cache",
  "conversations",
  "crashes",
  "implicit",
  "log",
  "presence",
  "updater",
]);

/**
 * Synchronizes all auth, token, and configuration files from `~/.gemini/antigravity-cli`
 * into the worker's isolated `~/.gemini/agy2api-worker-{id}` directory.
 * On headless Linux (SSH / no desktop keyring), `agy` stores OAuth tokens using
 * file-based token storage (`cliFileTokenStorage`) inside `antigravity-cli`.
 */
export function syncWorkerSandboxAuth(absAppDataDir: string): void {
  const geminiBaseDir = path.join(os.homedir(), ".gemini");
  const primaryCliDir = path.join(geminiBaseDir, "antigravity-cli");
  if (!fs.existsSync(primaryCliDir)) return;

  try {
    const entries = fs.readdirSync(primaryCliDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(primaryCliDir, entry.name);
      const destPath = path.join(absAppDataDir, entry.name);
      if (entry.isFile()) {
        if (EXCLUDED_WORKER_FILES.has(entry.name)) continue;
        try {
          fs.copyFileSync(srcPath, destPath);
        } catch {
          // Ignore if file is transiently locked
        }
      } else if (entry.isDirectory()) {
        if (EXCLUDED_WORKER_DIRS.has(entry.name)) continue;
        try {
          fs.cpSync(srcPath, destPath, { recursive: true, force: true });
        } catch {
          // Ignore transient copy errors
        }
      }
    }
  } catch {
    // Ignore directory read errors
  }
}

/**
 * Writes the minimal custom agent (`excludeDefaultComponents: true`) and a `PreToolUse`
 * hard-deny hook into `<absGeminiDir>/config/` so built-in prompts, ambient user rules/skills/MCPs,
 * and residual native tools (`manage_task`) cannot pollute context or execute.
 */
function writeWorkerGatewayCustomizations(absGeminiDir: string): void {
  const agentsDir = path.join(absGeminiDir, "config", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });

  const agentMarkdown = [
    "---",
    `name: ${GATEWAY_AGENT_NAME}`,
    "description: Pure stateless OpenAI API gateway inference engine",
    "mainAgent: true",
    "subagent: false",
    "excludeDefaultComponents: true",
    "inheritMcp: false",
    "tools: []",
    "skills: []",
    "rules: []",
    "agents: []",
    "plugins: []",
    "---",
    "",
  ].join("\n");

  fs.writeFileSync(
    path.join(agentsDir, `${GATEWAY_AGENT_NAME}.md`),
    agentMarkdown,
    "utf-8"
  );

  const denyCmd =
    process.platform === "win32"
      ? 'echo {"decision":"deny","reason":"Built-in tools are disabled."}'
      : 'printf \'%s\\n\' \'{"decision":"deny","reason":"Built-in tools are disabled."}\'';

  const hooksConfig = {
    "block-native-tools": {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: denyCmd,
              timeout: 5,
            },
          ],
        },
      ],
    },
  };

  fs.writeFileSync(
    path.join(absGeminiDir, "config", "hooks.json"),
    JSON.stringify(hooksConfig, null, 2),
    "utf-8"
  );
}

/**
 * Creates an isolated runtime environment for an `agy acp` worker process:
 * 1. `~/.gemini/agy2api-worker-{id}` passed as `--gemini-dir`, containing:
 *    - `antigravity-cli/` with cloned OAuth credentials & isolated SQLite DB / logs
 *    - `config/agents/gateway.md` (`excludeDefaultComponents: true`) & `config/hooks.json`
 * 2. An empty read-only temporary directory (`jailCwd`) used as `cwd` for `session/new`.
 */
export function createWorkerSandbox(workerId: string): WorkerSandboxEnv {
  const geminiBaseDir = path.join(os.homedir(), ".gemini");

  const relAppDataDir = `agy2api-worker-${workerId}`;
  const absGeminiDir = path.join(geminiBaseDir, relAppDataDir);
  const absAppDataDir = path.join(absGeminiDir, "antigravity-cli");
  fs.mkdirSync(absAppDataDir, { recursive: true });

  syncWorkerSandboxAuth(absAppDataDir);
  writeWorkerGatewayCustomizations(absGeminiDir);

  // Create empty read-only jail directory for `session/new` cwd
  const jailCwd = fs.mkdtempSync(path.join(os.tmpdir(), `agy2api-jail-${workerId}-`));
  try {
    fs.chmodSync(jailCwd, 0o555);
  } catch {
    // Ignore chmod differences on Windows ACLs
  }

  return {
    workerId,
    relAppDataDir,
    absGeminiDir,
    absAppDataDir,
    agentName: GATEWAY_AGENT_NAME,
    jailCwd,
  };
}

/**
 * Cleans up the worker's temporary gemini directory and empty jail directory.
 */
export function cleanupWorkerSandbox(sandbox: WorkerSandboxEnv): void {
  try {
    fs.chmodSync(sandbox.jailCwd, 0o777);
  } catch {}
  try {
    fs.rmSync(sandbox.jailCwd, { recursive: true, force: true });
  } catch {}
  try {
    fs.rmSync(sandbox.absGeminiDir, { recursive: true, force: true });
  } catch {}
}

/**
 * Sweeps any leftover `agy2api-worker-*` directories from previous ungraceful exits.
 */
export function sweepStaleSandboxes(): void {
  try {
    const geminiBaseDir = path.join(os.homedir(), ".gemini");
    if (fs.existsSync(geminiBaseDir)) {
      for (const entry of fs.readdirSync(geminiBaseDir)) {
        if (entry.startsWith("agy2api-worker-")) {
          fs.rmSync(path.join(geminiBaseDir, entry), { recursive: true, force: true });
        }
      }
    }
  } catch {}
}
