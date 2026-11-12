import crypto from "node:crypto";
import { ThinkingLevel } from "../../config.js";
import {
  normalizeThinkingLevel,
  thinkingLevelFromBudget,
} from "../../compiler/model-resolver.js";
import {
  AssistantMessage,
  ChatMessage,
  ChatRequest,
  ContentPart,
  GatewayError,
  ImagePart,
  textOf,
  TokenUsage,
  ToolCall,
  ToolChoice,
  ToolDefinition,
  TurnEvent,
  TurnResult,
} from "../../core/chat.js";
import {
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionRequest,
  OpenAIMessage,
  OpenAIToolCall,
  OpenAIUsageDetails,
} from "../../types/openai.js";
import {
  ChatProtocol,
  ChatStreamEncoder,
  ResponseContext,
  SseFrame,
} from "../protocol.js";

type JsonObject = Record<string, any>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): GatewayError {
  return new GatewayError(message, 400, "invalid_request_error");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ============================================================================
// Request decoding
// ============================================================================

/**
 * Effort from body parameters, in priority order: `reasoning_effort`, then the `thinking` object
 * (Claude-style adapters), then `reasoning`.
 */
export function reasoningEffortFromBody(
  body: Pick<OpenAIChatCompletionRequest, "reasoning_effort" | "thinking" | "reasoning">
): ThinkingLevel | null {
  if (body.reasoning_effort) {
    return normalizeThinkingLevel(body.reasoning_effort);
  }
  if (body.thinking) {
    if (body.thinking.effort || body.thinking.level) {
      return normalizeThinkingLevel(body.thinking.effort || body.thinking.level);
    }
    return typeof body.thinking.budget_tokens === "number"
      ? thinkingLevelFromBudget(body.thinking.budget_tokens)
      : null;
  }
  if (body.reasoning) {
    if (body.reasoning.effort || body.reasoning.level) {
      return normalizeThinkingLevel(body.reasoning.effort || body.reasoning.level);
    }
    return typeof body.reasoning.max_tokens === "number"
      ? thinkingLevelFromBudget(body.reasoning.max_tokens)
      : null;
  }
  return null;
}

/** `data:` URLs become inline base64 images; anything else stays a URL reference. */
export function decodeImageUrl(url: string): ImagePart {
  const dataUrl = url.match(/^data:([^;,]*)[^,]*;base64,/i);
  if (dataUrl) {
    return {
      type: "image",
      mimeType: dataUrl[1] || undefined,
      data: url.slice(dataUrl[0].length),
    };
  }
  return { type: "image", url };
}

function decodeContent(content: unknown): ContentPart[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: String(content) }];
  }

  const parts: ContentPart[] = [];
  for (const part of content) {
    if (!isObject(part)) continue;
    if (part.type === "text") {
      parts.push({ type: "text", text: typeof part.text === "string" ? part.text : "" });
    } else if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (typeof url === "string" && url) parts.push(decodeImageUrl(url));
    }
  }
  return parts;
}

export function encodeArguments(args: unknown): string {
  return typeof args === "string" ? args : JSON.stringify(args ?? {});
}

function decodeToolCalls(msg: JsonObject): ToolCall[] {
  const calls: ToolCall[] = [];
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (!isObject(tc)) continue;
      const fn = isObject(tc.function) ? tc.function : {};
      calls.push({
        id: optionalString(tc.id) ?? "",
        name: optionalString(fn.name) ?? "",
        arguments: encodeArguments(fn.arguments),
      });
    }
  }
  // Legacy single `function_call`
  if (isObject(msg.function_call)) {
    calls.push({
      id: "",
      name: optionalString(msg.function_call.name) ?? "",
      arguments: encodeArguments(msg.function_call.arguments),
    });
  }
  return calls;
}

function decodeMessage(raw: unknown, index: number): ChatMessage {
  if (!isObject(raw)) {
    throw invalid(`messages[${index}] must be an object`);
  }
  const content = decodeContent(raw.content);
  switch (raw.role) {
    case "system":
    case "developer":
      return { role: "system", content };
    case "user":
      return { role: "user", content };
    case "assistant":
      return { role: "assistant", content, toolCalls: decodeToolCalls(raw) };
    case "tool":
    case "function":
      return {
        role: "tool",
        content,
        toolCallId: optionalString(raw.tool_call_id),
        name: optionalString(raw.name),
      };
    default:
      throw invalid(
        `messages[${index}].role must be one of system, developer, user, assistant, tool`
      );
  }
}

function decodeTools(raw: unknown): ToolDefinition[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid("`tools` must be an array");

  const tools: ToolDefinition[] = [];
  raw.forEach((tool, i) => {
    // Hosted tools (web search etc.) have no meaning for ACP models
    if (isObject(tool) && typeof tool.type === "string" && tool.type !== "function") return;
    const fn = isObject(tool) && isObject(tool.function) ? tool.function : null;
    if (!fn || typeof fn.name !== "string" || !fn.name) {
      throw invalid(`tools[${i}].function.name is required`);
    }
    tools.push({
      name: fn.name,
      description: optionalString(fn.description),
      parameters: isObject(fn.parameters) ? fn.parameters : undefined,
    });
  });
  return tools;
}

function decodeToolChoice(raw: unknown): ToolChoice | undefined {
  if (raw === "auto" || raw === "none" || raw === "required") return raw;
  if (isObject(raw) && isObject(raw.function) && typeof raw.function.name === "string") {
    return { name: raw.function.name };
  }
  return undefined;
}

/** `stop`: a string or up to 4 strings; empty strings are ignored. */
function decodeStop(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list) || list.length > 4 || !list.every((s) => typeof s === "string")) {
    throw new GatewayError(
      "`stop` must be a string or an array of up to 4 strings",
      400,
      "invalid_request_error",
      undefined,
      "stop"
    );
  }
  const stop = list.filter((s) => s.length > 0);
  return stop.length > 0 ? stop : undefined;
}

/** Converts OpenAI chat messages into the neutral model; throws a 400 on malformed entries. */
export function decodeMessages(messages: unknown[]): ChatMessage[] {
  return messages.map(decodeMessage);
}

export function decodeChatCompletionRequest(body: unknown): ChatRequest {
  if (!isObject(body)) {
    throw invalid("Request body must be a JSON object");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalid("`messages` must be a non-empty array");
  }
  return {
    model: optionalString(body.model) ?? "",
    effort: reasoningEffortFromBody(body),
    messages: decodeMessages(body.messages),
    tools: decodeTools(body.tools),
    toolChoice: decodeToolChoice(body.tool_choice),
    stop: decodeStop(body.stop),
    stream: Boolean(body.stream),
  };
}

// ============================================================================
// Response encoding
// ============================================================================

export function toOpenAIUsage(usage: TokenUsage): OpenAIUsageDetails {
  const promptTokens =
    usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: usage.outputTokens,
    // ACP `outputTokens` already includes `thoughtTokens` (matching OpenAI `completion_tokens`)
    total_tokens: promptTokens + usage.outputTokens,
    prompt_tokens_details: {
      cached_tokens: usage.cachedReadTokens,
      cache_write_tokens: usage.cachedWriteTokens,
    },
    completion_tokens_details: {
      reasoning_tokens: usage.thoughtTokens,
    },
  };
}

function toOpenAIToolCall(call: ToolCall): OpenAIToolCall {
  return {
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  };
}

export function toOpenAIAssistantMessage(msg: AssistantMessage): OpenAIMessage {
  const text = textOf(msg.content);
  const out: OpenAIMessage = {
    role: "assistant",
    content: text || (msg.toolCalls.length > 0 ? null : ""),
  };
  if (msg.toolCalls.length > 0) {
    out.tool_calls = msg.toolCalls.map(toOpenAIToolCall);
  }
  return out;
}

class OpenAIChatStreamEncoder implements ChatStreamEncoder {
  private model: string;

  constructor(private readonly ctx: ResponseContext) {
    this.model = ctx.model;
  }

  start(): SseFrame[] {
    return [this.chunk({ role: "assistant" })];
  }

  event(event: TurnEvent): SseFrame[] {
    switch (event.type) {
      case "model":
        this.model = event.model;
        return [];
      case "thought":
        return [this.chunk({ reasoning_content: event.text })];
      case "text":
        return [this.chunk({ content: event.text })];
      case "tool_call":
        return [
          this.chunk({
            tool_calls: [{ index: event.index, ...toOpenAIToolCall(event.call) }],
          }),
        ];
    }
  }

  finish(result: TurnResult): SseFrame[] {
    return [
      this.chunk({}, result.finishReason, toOpenAIUsage(result.usage)),
      { data: "[DONE]" },
    ];
  }

  fail(message: string): SseFrame[] {
    return [
      this.chunk({ content: `\n[Gateway Error: ${message}]` }, "stop"),
      { data: "[DONE]" },
    ];
  }

  private chunk(
    delta: OpenAIChatCompletionChunk["choices"][0]["delta"],
    finishReason: OpenAIChatCompletionChunk["choices"][0]["finish_reason"] = null,
    usage?: OpenAIUsageDetails
  ): SseFrame {
    const chunk: OpenAIChatCompletionChunk = {
      id: this.ctx.id,
      object: "chat.completion.chunk",
      created: this.ctx.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    };
    return { data: JSON.stringify(chunk) };
  }
}

export const openAIChatCompletions: ChatProtocol = {
  decodeRequest(body) {
    return { chat: decodeChatCompletionRequest(body), state: undefined };
  },

  newResponseId() {
    return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  },

  encodeResponse(ctx, result) {
    return {
      id: ctx.id,
      object: "chat.completion",
      created: ctx.created,
      model: result.actualModel,
      choices: [
        {
          index: 0,
          message: {
            ...toOpenAIAssistantMessage(result.message),
            ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
          },
          finish_reason: result.finishReason,
        },
      ],
      usage: toOpenAIUsage(result.usage),
    };
  },

  createStreamEncoder(ctx) {
    return new OpenAIChatStreamEncoder(ctx);
  },

  encodeError(err) {
    return { error: { message: err.message, type: err.type, ...(err.code ? { code: err.code } : {}) } };
  },
};
