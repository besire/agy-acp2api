import crypto from "node:crypto";
import { jsonrepair } from "jsonrepair";
import { OpenAIMessage, OpenAIToolCall, OpenAIToolCallDelta } from "../types/openai.js";

const OPEN_TAG_PREFIX = "<tool_call";
const CLOSE_TAG = "</tool_call>";

export interface ParsedToolPayload {
  name: string;
  arguments: string;
}

export class ToolCallStreamParser {
  private mode: "TEXT" | "BUFFERING_TOOL" = "TEXT";
  private buffer = "";
  private toolCallIndex = 0;
  private hasSeenToolCall = false;
  private seenToolSignatures = new Set<string>();

  private accumulatedContent = "";
  private accumulatedToolCalls: OpenAIToolCall[] = [];

  /**
   * Feeds a new `agent_message_chunk` text delta into the sliding-window state machine.
   */
  public feed(
    chunkText: string,
    onContentDelta: (textDelta: string) => void,
    onToolCallDelta: (toolDelta: OpenAIToolCallDelta) => void
  ): void {
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
              const normalText = this.buffer.slice(0, openIdx);
              this.accumulatedContent += normalText;
              onContentDelta(normalText);
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
            const safeText = this.buffer.slice(0, safeEmitLen);
            this.accumulatedContent += safeText;
            onContentDelta(safeText);
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
          this.emitParsedToolCall(parsed, onToolCallDelta);
        } else if (!this.hasSeenToolCall) {
          // If completely unparseable and no valid tool call was seen, fall back to emitting raw text
          const fallback = `<tool_call>${rawInner}</tool_call>`;
          this.accumulatedContent += fallback;
          onContentDelta(fallback);
        }
      }
    }
  }

  /**
   * Allows external native tool call interception to inject a tool call directly.
   */
  public injectDirectToolCall(
    name: string,
    args: unknown,
    onToolCallDelta: (toolDelta: OpenAIToolCallDelta) => void
  ): void {
    const argsStr =
      typeof args === "string" ? args : JSON.stringify(args ?? {});
    this.emitParsedToolCall({ name, arguments: argsStr }, onToolCallDelta);
  }

  /**
   * Called when ACP `session/prompt` finishes.
   * Flushes any held-back characters or unclosed tool call buffer and returns the OpenAI `finish_reason`.
   */
  public flush(
    onContentDelta: (textDelta: string) => void,
    onToolCallDelta: (toolDelta: OpenAIToolCallDelta) => void
  ): "tool_calls" | "stop" {
    if (this.buffer.length > 0) {
      if (this.mode === "TEXT") {
        if (!this.hasSeenToolCall) {
          this.accumulatedContent += this.buffer;
          onContentDelta(this.buffer);
        }
        this.buffer = "";
      } else if (this.mode === "BUFFERING_TOOL") {
        // Attempt salvage if model stopped before closing `</tool_call>`
        const salvaged = this.parseToolJson(this.buffer.trim());
        if (salvaged) {
          this.emitParsedToolCall(salvaged, onToolCallDelta);
        } else if (this.accumulatedToolCalls.length === 0) {
          const fallback = `<tool_call>${this.buffer}`;
          this.accumulatedContent += fallback;
          onContentDelta(fallback);
        }
        this.buffer = "";
        this.mode = "TEXT";
      }
    }

    return this.accumulatedToolCalls.length > 0 ? "tool_calls" : "stop";
  }

  /**
   * Reconstructs the complete OpenAI assistant message for non-streaming responses
   * and for registering the post-turn Session Prefix Hash.
   */
  public toAssistantMessage(): OpenAIMessage {
    const msg: OpenAIMessage = {
      role: "assistant",
      content: this.accumulatedContent || (this.accumulatedToolCalls.length > 0 ? null : ""),
    };
    if (this.accumulatedToolCalls.length > 0) {
      msg.tool_calls = this.accumulatedToolCalls;
    }
    return msg;
  }

  public hasToolCalls(): boolean {
    return this.accumulatedToolCalls.length > 0;
  }

  private emitParsedToolCall(
    parsed: ParsedToolPayload,
    onToolCallDelta: (toolDelta: OpenAIToolCallDelta) => void
  ): void {
    const signature = `${parsed.name}::${parsed.arguments}`;
    if (this.seenToolSignatures.has(signature)) {
      // Deduplicate identical tool calls within the same turn (prevents self-correction retry loops)
      return;
    }
    this.seenToolSignatures.add(signature);

    const index = this.toolCallIndex++;
    const id = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

    const toolCall: OpenAIToolCall = {
      id,
      type: "function",
      function: {
        name: parsed.name,
        arguments: parsed.arguments,
      },
    };
    this.accumulatedToolCalls.push(toolCall);

    onToolCallDelta({
      index,
      id,
      type: "function",
      function: {
        name: parsed.name,
        arguments: parsed.arguments,
      },
    });
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
