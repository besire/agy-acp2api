import crypto from "node:crypto";
import { jsonrepair } from "jsonrepair";
import { AssistantMessage, FinishReason, ToolCall, TurnEvent } from "../core/chat.js";

const OPEN_TAG_PREFIX = "<tool_call";
const CLOSE_TAG = "</tool_call>";

export interface ParsedToolPayload {
  name: string;
  arguments: string;
}

export type ParserEvent = Extract<TurnEvent, { type: "text" | "tool_call" }>;

export class ToolCallStreamParser {
  private mode: "TEXT" | "BUFFERING_TOOL" = "TEXT";
  private buffer = "";
  private hasSeenToolCall = false;
  private seenToolSignatures = new Set<string>();

  private accumulatedContent = "";
  private accumulatedToolCalls: ToolCall[] = [];

  /** `emit` receives visible text and completed tool calls as soon as they are known. */
  constructor(private readonly emit: (event: ParserEvent) => void = () => {}) {}

  /**
   * Feeds a new `agent_message_chunk` text delta into the sliding-window state machine.
   */
  public feed(chunkText: string): void {
    if (!chunkText) return;
    this.buffer += chunkText;

    while (this.buffer.length > 0) {
      if (this.mode === "TEXT") {
        const openIdx = this.buffer.indexOf(OPEN_TAG_PREFIX);

        if (openIdx !== -1) {
          // Emit normal text strictly before the FIRST `<tool_call`;
          // once a tool call has started in this turn, discard any inter-tool or post-tool chatter.
          if (openIdx > 0) {
            if (!this.hasSeenToolCall) {
              this.emitText(this.buffer.slice(0, openIdx));
            }
            this.buffer = this.buffer.slice(openIdx);
          }

          // Wait until we see the closing `>` of `<tool_call...>`
          const tagEndIdx = this.buffer.indexOf(">", OPEN_TAG_PREFIX.length);
          if (tagEndIdx === -1) {
            // Still waiting for `>` in the next chunk
            break;
          }

          // Advance past `<tool_call...>` and switch to BUFFERING_TOOL mode
          this.buffer = this.buffer.slice(tagEndIdx + 1);
          this.mode = "BUFFERING_TOOL";
          continue;
        }

        // Check if the tail of `this.buffer` matches a partial prefix of `<tool_call` (e.g. `<`, `<t`, `<tool`)
        const holdbackLen = this.getPartialPrefixLength(this.buffer, OPEN_TAG_PREFIX);
        const safeEmitLen = this.buffer.length - holdbackLen;

        if (safeEmitLen > 0) {
          if (!this.hasSeenToolCall) {
            this.emitText(this.buffer.slice(0, safeEmitLen));
          }
          this.buffer = this.buffer.slice(safeEmitLen);
        }
        break;
      } else {
        // mode === "BUFFERING_TOOL"
        const closeIdx = this.buffer.indexOf(CLOSE_TAG);
        if (closeIdx === -1) {
          // Wait for more chunks until `</tool_call>` arrives
          break;
        }

        const rawInner = this.buffer.slice(0, closeIdx).trim();
        this.buffer = this.buffer.slice(closeIdx + CLOSE_TAG.length);
        this.mode = "TEXT";

        const parsed = this.parseToolJson(rawInner);
        if (parsed) {
          // Only a successfully parsed call switches off later chatter; an unparseable block
          // must not swallow the rest of the reply
          this.hasSeenToolCall = true;
          this.emitParsedToolCall(parsed);
        } else if (!this.hasSeenToolCall) {
          // If completely unparseable and no valid tool call was seen, fall back to emitting raw text
          this.emitText(`<tool_call>${rawInner}</tool_call>`);
        }
      }
    }
  }

  /**
   * Allows external native tool call interception to inject a tool call directly.
   */
  public injectDirectToolCall(name: string, args: unknown): void {
    const argsStr =
      typeof args === "string" ? args : JSON.stringify(args ?? {});
    this.emitParsedToolCall({ name, arguments: argsStr });
  }

  /**
   * Called when ACP `session/prompt` finishes.
   * Flushes any held-back characters or unclosed tool call buffer and returns the finish reason.
   */
  public flush(): FinishReason {
    if (this.buffer.length > 0) {
      if (this.mode === "TEXT") {
        if (!this.hasSeenToolCall) {
          this.emitText(this.buffer);
        }
        this.buffer = "";
      } else if (this.mode === "BUFFERING_TOOL") {
        // Attempt salvage if model stopped before closing `</tool_call>`
        const salvaged = this.parseToolJson(this.buffer.trim());
        if (salvaged) {
          this.emitParsedToolCall(salvaged);
        } else if (this.accumulatedToolCalls.length === 0) {
          this.emitText(`<tool_call>${this.buffer}`);
        }
        this.buffer = "";
        this.mode = "TEXT";
      }
    }

    return this.accumulatedToolCalls.length > 0 ? "tool_calls" : "stop";
  }

  /**
   * The complete reply, for non-streaming responses and for registering the post-turn
   * Session Prefix Hash.
   */
  public toAssistantMessage(): AssistantMessage {
    return {
      role: "assistant",
      content: this.accumulatedContent
        ? [{ type: "text", text: this.accumulatedContent }]
        : [],
      toolCalls: [...this.accumulatedToolCalls],
    };
  }

  public hasToolCalls(): boolean {
    return this.accumulatedToolCalls.length > 0;
  }

  private emitText(text: string): void {
    this.accumulatedContent += text;
    this.emit({ type: "text", text });
  }

  private emitParsedToolCall(parsed: ParsedToolPayload): void {
    const signature = `${parsed.name}::${parsed.arguments}`;
    if (this.seenToolSignatures.has(signature)) {
      // Deduplicate identical tool calls within the same turn (prevents self-correction retry loops)
      return;
    }
    this.seenToolSignatures.add(signature);

    const call: ToolCall = {
      id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      name: parsed.name,
      arguments: parsed.arguments,
    };
    const index = this.accumulatedToolCalls.length;
    this.accumulatedToolCalls.push(call);
    this.emit({ type: "tool_call", index, call });
  }

  private parseToolJson(raw: string): ParsedToolPayload | null {
    if (!raw) return null;

    // Strip optional markdown code fences (```json ... ```)
    let cleaned = raw
      .replace(/^```(?:json|xml)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let obj: unknown;
    try {
      obj = JSON.parse(cleaned);
    } catch {
      try {
        const repaired = jsonrepair(cleaned);
        obj = JSON.parse(repaired);
      } catch {
        return null;
      }
    }

    if (!obj || typeof obj !== "object") return null;
    const record = obj as Record<string, unknown>;

    const name =
      typeof record.name === "string"
        ? record.name
        : typeof (record.function as Record<string, unknown> | undefined)?.name === "string"
          ? ((record.function as Record<string, unknown>).name as string)
          : null;

    if (!name) return null;

    const rawArgs =
      record.arguments !== undefined
        ? record.arguments
        : record.parameters !== undefined
          ? record.parameters
          : (record.function as Record<string, unknown> | undefined)?.arguments ?? {};

    let argsString = "{}";
    if (typeof rawArgs === "string") {
      try {
        // Normalize or repair stringified JSON arguments
        argsString = JSON.stringify(JSON.parse(jsonrepair(rawArgs)));
      } catch {
        argsString = rawArgs;
      }
    } else {
      argsString = JSON.stringify(rawArgs ?? {});
    }

    return {
      name,
      arguments: argsString,
    };
  }

  private getPartialPrefixLength(text: string, prefix: string): number {
    const maxLen = Math.min(text.length, prefix.length - 1);
    for (let len = maxLen; len > 0; len--) {
      if (text.endsWith(prefix.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }
}
