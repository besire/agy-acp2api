import { ChatMessage } from "../../core/chat.js";

interface StoredConversation {
  messages: ChatMessage[];
  expiresAt: number;
}

/**
 * In-memory history behind `previous_response_id`: the conversation up to and including each
 * stored response, without its `instructions` (those are never carried over). Bounded by age
 * and count; least recently used entries go first. Messages are shared, not copied, between
 * entries of the same conversation.
 */
export class ResponseStore {
  private entries = new Map<string, StoredConversation>();

  constructor(
    private readonly ttlMs = 60 * 60_000,
    private readonly maxEntries = 500
  ) {}

  get(responseId: string): ChatMessage[] | undefined {
    const entry = this.entries.get(responseId);
    if (!entry) return undefined;
    this.entries.delete(responseId);
    if (entry.expiresAt <= Date.now()) return undefined;
    this.entries.set(responseId, entry);
    return entry.messages;
  }

  save(responseId: string, messages: ChatMessage[]): void {
    this.entries.delete(responseId);
    this.entries.set(responseId, { messages, expiresAt: Date.now() + this.ttlMs });
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && entry.expiresAt > now) break;
      this.entries.delete(id);
    }
  }

  size(): number {
    return this.entries.size;
  }
}
