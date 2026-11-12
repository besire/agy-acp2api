#!/usr/bin/env node
/**
 * Fake `agy acp`: speaks just enough ACP JSON-RPC over stdio for black-box gateway tests.
 *
 * Env:
 *   FAKE_AGY_LOG      JSONL file; every received message and lifecycle event is appended
 *   FAKE_AGY_CONTROL  JSON file read at boot, e.g. {"mode":"fail-start"}
 *
 * Prompt directives (the last one in the prompt text wins):
 *   [[tool:NAME:{json args}]]  stream a <tool_call> block split across chunks
 *   [[hang]]                   never finish until session/cancel
 *   [[slow:MS]]                stream dots for MS milliseconds (cancellable)
 *   [[crash]]                  write to stderr and exit(3)
 *   (none)                     echo the prompt text back
 */
import fs from "node:fs";
import readline from "node:readline";

const logPath = process.env.FAKE_AGY_LOG;
const controlPath = process.env.FAKE_AGY_CONTROL;

function log(entry) {
  if (!logPath) return;
  fs.appendFileSync(
    logPath,
    JSON.stringify({ t: Date.now(), pid: process.pid, ...entry }) + "\n"
  );
}

function readControl() {
  try {
    return JSON.parse(fs.readFileSync(controlPath, "utf-8"));
  } catch {
    return {};
  }
}

log({ event: "boot", argv: process.argv.slice(2) });

if (readControl().mode === "fail-start") {
  process.stderr.write("fake-agy: not logged in (run `agy login`)\n");
  process.exit(2);
}

const MODELS = ["gemini-3.8-flash", "gemini-4-carbon"].flatMap((base) =>
  ["low", "medium", "high"].map((lv) => ({
    modelId: `${base}-${lv}`,
    name: `${base} (${lv[0].toUpperCase()}${lv.slice(1)})`,
  }))
);

const sessions = new Map();
let seq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

function update(sessionId, upd) {
  send({ method: "session/update", params: { sessionId, update: upd } });
}

function lastDirective(text) {
  const all = [...text.matchAll(/\[\[([a-z_]+)(?::([^\]]*))?\]\]/g)];
  const last = all[all.length - 1];
  return last ? { kind: last[1], arg: last[2] ?? "" } : { kind: "echo", arg: "" };
}

async function runPrompt(id, params) {
  const sessionId = params.sessionId;
  const s = sessions.get(sessionId);
  if (!s) {
    send({ id, error: { code: -32602, message: `unknown session ${sessionId}` } });
    return;
  }
  s.cancelled = false;

  const text = (params.prompt || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const { kind, arg } = lastDirective(text);
  const usage = {
    inputTokens: Math.ceil(text.length / 4),
    outputTokens: 7,
    thoughtTokens: 2,
    cachedReadTokens: 3,
    cachedWriteTokens: 0,
    totalTokens: Math.ceil(text.length / 4) + 10,
  };
  const finish = (stopReason) => send({ id, result: { stopReason, usage } });
  const emit = async (chunks) => {
    for (const c of chunks) {
      if (s.cancelled) return false;
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: c },
      });
      await sleep(5);
    }
    return true;
  };

  update(sessionId, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "thinking..." },
  });

  if (kind === "crash") {
    process.stderr.write("fake-agy: simulated crash\n");
    process.exit(3);
  }

  if (kind === "hang") {
    s.onCancel = () => finish("cancelled");
    return;
  }

  if (kind === "slow") {
    const end = Date.now() + (Number(arg) || 1000);
    while (Date.now() < end) {
      if (s.cancelled) return finish("cancelled");
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "." },
      });
      await sleep(50);
    }
    return finish("end_turn");
  }

  let chunks;
  if (kind === "tool") {
    const sep = arg.indexOf(":");
    const name = sep === -1 ? arg : arg.slice(0, sep);
    const args = sep === -1 ? "{}" : arg.slice(sep + 1);
    const block = `<tool_call>\n{"name":${JSON.stringify(name)},"arguments":${args}}\n</tool_call>`;
    // Split inside the opening tag and mid-JSON to exercise the parser's holdback
    const mid = Math.floor(block.length / 2);
    chunks = ["Calling a tool. ", block.slice(0, 5), block.slice(5, mid), block.slice(mid)];
  } else {
    const body = text.replace(/\s+/g, " ").trim().slice(0, 500);
    const reply = `echo: ${body}`;
    const mid = Math.floor(reply.length / 2);
    chunks = [reply.slice(0, mid), reply.slice(mid)];
  }

  finish((await emit(chunks)) ? "end_turn" : "cancelled");
}

function handle(msg) {
  log({ dir: "in", msg });
  const { id, method, params = {} } = msg;
  if (typeof method !== "string") return; // responses to our own requests

  switch (method) {
    case "initialize":
      send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
        },
      });
      return;
    case "session/new": {
      const sessionId = `fake-${process.pid}-${++seq}`;
      sessions.set(sessionId, { model: "gemini-3.8-flash-medium", cancelled: false });
      send({
        id,
        result: {
          sessionId,
          models: { availableModels: MODELS, currentModelId: "gemini-3.8-flash-medium" },
          configOptions: [
            { id: "model", name: "Model", type: "select", currentValue: "gemini-3.8-flash-medium" },
          ],
        },
      });
      return;
    }
    case "session/set_model": {
      const s = sessions.get(params.sessionId);
      if (s) s.model = params.modelId;
      send({ id, result: {} });
      return;
    }
    case "session/prompt":
      runPrompt(id, params);
      return;
    case "session/cancel": {
      const s = sessions.get(params.sessionId);
      if (s) {
        s.cancelled = true;
        const onCancel = s.onCancel;
        s.onCancel = null;
        onCancel?.();
      }
      return;
    }
    case "session/close":
      sessions.delete(params.sessionId);
      send({ id, result: {} });
      return;
    default:
      if (id !== undefined) {
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handle(JSON.parse(trimmed));
  } catch (err) {
    log({ event: "bad-input", line: trimmed, error: String(err) });
  }
});
rl.on("close", () => process.exit(0));
