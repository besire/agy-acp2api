import crypto from "node:crypto";
import { ChatMessage, ContentPart, textOf, ToolDefinition } from "../core/chat.js";

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
  deltaMessages: ChatMessage[];
  matchedPrefixLength: number;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
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

/** Images are identified by a digest of their bytes (or URL) so the hash stays small. */
function imageDigests(content: ContentPart[]): string[] {
  return content.flatMap((part) =>
    part.type === "image" ? [sha256(part.data ?? part.url ?? "")] : []
  );
}

/**
 * Reduces a message to what matters for session reuse: tool-call ids, JSON key order and
 * surrounding whitespace are ignored.
 */
export function canonicalizeMessage(msg: ChatMessage): Record<string, unknown> {
  const canonical: Record<string, unknown> = {
    role: msg.role,
    content: textOf(msg.content).trim(),
  };
  if (msg.role === "assistant") {
    canonical.toolCalls = msg.toolCalls.map((tc) => ({
      name: tc.name,
      arguments: canonicalizeJsonString(tc.arguments),
    }));
  }
  const images = imageDigests(msg.content);
  if (images.length > 0) {
    canonical.images = images;
  }
  return canonical;
}

/**
 * Hash chain over the conversation: element `k` identifies the first `k` messages under the given
 * model and tool set. Each step only hashes one message, so all prefixes cost O(n) together.
 */
export function prefixHashes(
  baseModelId: string,
  tools: ToolDefinition[],
  messages: ChatMessage[]
): string[] {
  const canonicalTools = tools.map((t) => ({
    name: t.name,
    parameters: sortJsonDeep(t.parameters || {}),
  }));
  let hash = sha256(JSON.stringify({ model: baseModelId, tools: canonicalTools }));
  const hashes = [hash];
  for (const msg of messages) {
    hash = sha256(hash + JSON.stringify(canonicalizeMessage(msg)));
    hashes.push(hash);
  }
  return hashes;
}

export function computeConversationHash(
  baseModelId: string,
  tools: ToolDefinition[],
  messages: ChatMessage[]
): string {
  const hashes = prefixHashes(baseModelId, tools, messages);
  return hashes[hashes.length - 1];
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
   * Scans backwards for the longest prefix ending in an assistant message that is the current
   * head of a session accepted by `isWorkerAvailable`.
   */
  public findBestMatchingPrefix(
    baseModelId: string,
    tools: ToolDefinition[],
    messages: ChatMessage[],
    isWorkerAvailable: (workerId: string, sessionId: string) => boolean
  ): PrefixMatchResult | null {
    this.pruneExpired();
    if (this.entries.size === 0) return null;

    const hashes = prefixHashes(baseModelId, tools, messages);
    for (let k = messages.length - 1; k >= 2; k--) {
      if (messages[k - 1].role !== "assistant") {
        continue;
      }

      const entry = this.entries.get(hashes[k]);
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

  /**
   * Takes a matched session off the registry before a prompt is sent to it: its history is about
   * to grow, so no other request may extend the old head (that would replay this turn to it).
   */
  public claim(entry: SessionAffinityEntry): void {
    this.removeSession(entry.sessionId);
  }

  /** Undoes `claim` when the prompt was never sent. */
  public restore(entry: SessionAffinityEntry): void {
    this.entries.set(entry.hash, { ...entry, updatedAt: Date.now() });
  }

  /** Records the session's new head; older heads of the same session no longer match. */
  public registerTurnState(
    baseModelId: string,
    tools: ToolDefinition[],
    fullMessagesWithReply: ChatMessage[],
    workerId: string,
    sessionId: string
  ): string {
    const hash = computeConversationHash(
      baseModelId,
      tools,
      fullMessagesWithReply
    );
    this.removeSession(sessionId);
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
