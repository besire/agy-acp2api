import { ChatMessage } from "../../core/chat.js";

interface StoredConversation {
  messages: ChatMessage[];
  expiresAt: number;
}

/** Rough size of a message: text, inline image data and tool arguments dominate. */
function approxMessageBytes(msg: ChatMessage): number {
  let n = 0;
  for (const part of msg.content) {
    n += part.type === "text" ? part.text.length : (part.data?.length ?? 0) + (part.url?.length ?? 0);
  }
  if (msg.role === "assistant") {
    for (const call of msg.toolCalls) n += call.name.length + call.arguments.length;
  }
  return n;
}

/**
 * In-memory history behind `previous_response_id`: the conversation up to and including each
 * stored response, without its `instructions` (those are never carried over). Bounded by age,
 * count and approximate size; least recently used entries go first, but the newest entry is
 * always kept.
 *
 * Entries of a `previous_response_id` chain share their message objects, so each distinct
 * message is counted once; clients that resend their whole input get fresh copies per response,
 * which is what the size budget is for.
 */
export class ResponseStore {
  private entries = new Map<string, StoredConversation>();
  private messageRefs = new Map<ChatMessage, { bytes: number; count: number }>();
  private totalBytes = 0;

  constructor(
    private readonly ttlMs = 60 * 60_000,
    private readonly maxEntries = 500,
    private readonly maxBytes = 128 * 1024 * 1024
  ) {}

  get(responseId: string): ChatMessage[] | undefined {
    const entry = this.entries.get(responseId);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.remove(responseId);
      return undefined;
    }
    this.entries.delete(responseId);
    this.entries.set(responseId, entry);
    return entry.messages;
  }

  save(responseId: string, messages: ChatMessage[]): void {
    this.remove(responseId);
    this.entries.set(responseId, { messages, expiresAt: Date.now() + this.ttlMs });
    this.charge(messages);

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

  /** Approximate memory held by stored histories, shared messages counted once. */
  bytes(): number {
    return this.totalBytes;
  }

  private remove(responseId: string): void {
    const entry = this.entries.get(responseId);
    if (!entry) return;
    this.entries.delete(responseId);
    for (const msg of entry.messages) {
      const ref = this.messageRefs.get(msg);
      if (ref && --ref.count === 0) {
        this.messageRefs.delete(msg);
        this.totalBytes -= ref.bytes;
      }
    }
  }

  private charge(messages: ChatMessage[]): void {
    for (const msg of messages) {
      const ref = this.messageRefs.get(msg);
      if (ref) {
        ref.count++;
      } else {
        const bytes = approxMessageBytes(msg);
        this.messageRefs.set(msg, { bytes, count: 1 });
        this.totalBytes += bytes;
      }
    }
  }
}
