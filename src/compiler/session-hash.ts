import crypto from "node:crypto";
import { OpenAIMessage, OpenAIToolDefinition } from "../types/openai.js";

export interface SessionAffinityEntry {
  hash: string;
  workerId: string;
  sessionId: string;
  modelId: string;
  messageCount: number;
  updatedAt: number;
}

export interface PrefixMatchResult {
  entry: SessionAffinityEntry;
  deltaMessages: OpenAIMessage[];
  matchedPrefixLength: number;
}

export function extractTextContent(content: OpenAIMessage["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("\n");
  }
  return String(content);
}

function sortJsonDeep(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map(sortJsonDeep);
  }
  if (val !== null && typeof val === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(val as Record<string, unknown>).sort()) {
      sorted[key] = sortJsonDeep((val as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return val;
}

export function canonicalizeJsonString(raw: string | undefined): string {
  if (!raw) return "{}";
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(sortJsonDeep(parsed));
  } catch {
    return raw.trim();
  }
}

export function canonicalizeMessage(msg: OpenAIMessage): Record<string, unknown> {
  const role = msg.role === "developer" ? "system" : msg.role;
  const text = extractTextContent(msg.content).trim();

  if (role === "assistant") {
    const toolCalls = (msg.tool_calls || []).map((tc) => ({
      name: tc.function?.name || "",
      arguments: canonicalizeJsonString(tc.function?.arguments),
    }));
    return {
      role: "assistant",
      content: text,
      toolCalls,
    };
  }

  if (role === "tool") {
    return {
      role: "tool",
      content: text,
    };
  }

  return {
    role,
    content: text,
  };
}

export function computeConversationHash(
  baseModelId: string,
  tools: OpenAIToolDefinition[] | undefined,
  messages: OpenAIMessage[]
): string {
  const canonicalTools = (tools || []).map((t) => ({
    name: t.function.name,
    parameters: sortJsonDeep(t.function.parameters || {}),
  }));

  const canonicalMessages = messages.map(canonicalizeMessage);

  const payload = JSON.stringify({
    model: baseModelId,
    tools: canonicalTools,
    messages: canonicalMessages,
  });

  return crypto.createHash("sha256").update(payload).digest("hex");
}

export class SessionAffinityRegistry {
  private entries = new Map<string, SessionAffinityEntry>();
  private ttlMs: number;

  constructor(ttlMs: number = 600_000) {
    this.ttlMs = ttlMs;
  }

  public setTtlMs(ttlMs: number): void {
    this.ttlMs = ttlMs;
    this.pruneExpired();
  }

  public clear(): void {
    this.entries.clear();
  }

  /**
   * Scans backwards for the longest prefix ending in an assistant message
   * that matches an existing session on a currently IDLE worker.
   */
  public findBestMatchingPrefix(
    baseModelId: string,
    tools: OpenAIToolDefinition[] | undefined,
    messages: OpenAIMessage[],
    isWorkerAvailable: (workerId: string, sessionId: string) => boolean
  ): PrefixMatchResult | null {
    this.pruneExpired();

    for (let k = messages.length - 1; k >= 2; k--) {
      if (messages[k - 1].role !== "assistant") {
        continue;
      }

      const prefix = messages.slice(0, k);
      const candidateHash = computeConversationHash(baseModelId, tools, prefix);
      const entry = this.entries.get(candidateHash);

      if (entry && isWorkerAvailable(entry.workerId, entry.sessionId)) {
        entry.updatedAt = Date.now();
        return {
          entry,
          deltaMessages: messages.slice(k),
          matchedPrefixLength: k,
        };
      }
    }

    return null;
  }

  public registerTurnState(
    baseModelId: string,
    tools: OpenAIToolDefinition[] | undefined,
    fullMessagesWithReply: OpenAIMessage[],
    workerId: string,
    sessionId: string
  ): string {
    const hash = computeConversationHash(
      baseModelId,
      tools,
      fullMessagesWithReply
    );
    this.entries.set(hash, {
      hash,
      workerId,
      sessionId,
      modelId: baseModelId,
      messageCount: fullMessagesWithReply.length,
      updatedAt: Date.now(),
    });
    return hash;
  }

  public removeSession(sessionId: string): void {
    for (const [hash, entry] of this.entries.entries()) {
      if (entry.sessionId === sessionId) {
        this.entries.delete(hash);
      }
    }
  }

  public removeWorkerSessions(workerId: string): void {
    for (const [hash, entry] of this.entries.entries()) {
      if (entry.workerId === workerId) {
        this.entries.delete(hash);
      }
    }
  }

  public pruneExpired(): void {
    const now = Date.now();
    for (const [hash, entry] of this.entries.entries()) {
      if (now - entry.updatedAt > this.ttlMs) {
        this.entries.delete(hash);
      }
    }
  }

  public size(): number {
    this.pruneExpired();
    return this.entries.size;
  }
}
