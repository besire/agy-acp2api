import { ChatMessage } from "../../core/chat.js";

interface StoredConversation {
  messages: ChatMessage[];
  expiresAt: number;
  bytes: number;
}

/** Rough size of a history: text, inline image data and tool arguments dominate. */
export function approxHistoryBytes(messages: ChatMessage[]): number {
  let n = 0;
  for (const msg of messages) {
    for (const part of msg.content) {
      n += part.type === "text" ? part.text.length : (part.data?.length ?? 0) + (part.url?.length ?? 0);
    }
    if (msg.role === "assistant") {
      for (const call of msg.toolCalls) n += call.name.length + call.arguments.length;
    }
  }
  return n;
}

/**
 * In-memory history behind `previous_response_id`: the conversation up to and including each
 * stored response, without its `instructions` (those are never carried over). Bounded by age,
 * count and approximate size; least recently used entries go first, but the newest entry is
 * always kept. Messages are shared, not copied, between entries of a `previous_response_id`
 * chain; clients that resend their whole input get a copy per response, hence the size budget.
 */
export class ResponseStore {
  private entries = new Map<string, StoredConversation>();
  private totalBytes = 0;

  constructor(
    private readonly ttlMs = 60 * 60_000,
    private readonly maxEntries = 500,
    private readonly maxBytes = 128 * 1024 * 1024
  ) {}

  get(responseId: string): ChatMessage[] | undefined {
    const entry = this.entries.get(responseId);
    if (!entry) return undefined;
    this.entries.delete(responseId);
    if (entry.expiresAt <= Date.now()) {
      this.totalBytes -= entry.bytes;
      return undefined;
    }
    this.entries.set(responseId, entry);
    return entry.messages;
  }

  save(responseId: string, messages: ChatMessage[]): void {
    this.remove(responseId);
    const bytes = approxHistoryBytes(messages);
    this.entries.set(responseId, { messages, expiresAt: Date.now() + this.ttlMs, bytes });
    this.totalBytes += bytes;

    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (this.entries.size === 1) break;
      const over = this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes;
      if (!over && entry.expiresAt > now) break;
      this.remove(id);
    }
  }

  size(): number {
    return this.entries.size;
  }

  private remove(responseId: string): void {
    const entry = this.entries.get(responseId);
    if (!entry) return;
    this.entries.delete(responseId);
    this.totalBytes -= entry.bytes;
  }
}
