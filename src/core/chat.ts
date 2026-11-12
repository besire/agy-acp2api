import { ThinkingLevel } from "../config.js";

/**
 * Protocol-neutral conversation model. Every API surface (OpenAI Chat today; Anthropic Messages,
 * OpenAI Responses or Gemini later) decodes into these types, and the compiler, session hash and
 * worker pool only ever see them.
 */

export interface TextPart {
  type: "text";
  text: string;
}

/** An image either inlined (`data` is base64) or referenced by `url`. */
export interface ImagePart {
  type: "image";
  mimeType?: string;
  data?: string;
  url?: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments object. */
  arguments: string;
}

export interface SystemMessage {
  role: "system";
  content: ContentPart[];
}

export interface UserMessage {
  role: "user";
  content: ContentPart[];
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentPart[];
  toolCalls: ToolCall[];
}

export interface ToolResultMessage {
  role: "tool";
  content: ContentPart[];
  toolCallId?: string;
  name?: string;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

export interface ChatRequest {
  /** Model name as the client sent it; may carry an effort suffix such as `-high` or `(low)`. */
  model: string;
  /** Effort requested through body parameters; wins over a model-name suffix. */
  effort: ThinkingLevel | null;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  toolChoice?: ToolChoice;
  stream: boolean;
}

/** Events emitted while a turn is running, in the order the client should see them. */
export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool_call"; index: number; call: ToolCall }
  /** The upstream model actually answering, once it is known. */
  | { type: "model"; model: string };

export type FinishReason = "stop" | "tool_calls";

/** Token counts as reported by ACP; `inputTokens` excludes cached reads and writes. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  thoughtTokens: number;
  totalTokens: number;
}

export interface TurnResult {
  message: AssistantMessage;
  /** All thought text of the turn, concatenated. */
  reasoning: string;
  finishReason: FinishReason;
  usage: TokenUsage;
  actualModel: string;
  ttftMs: number;
  durationMs: number;
}

export type GatewayErrorType = "invalid_request_error" | "server_error" | "service_unavailable";

/** A failure with a definite HTTP status; protocols render it in their own error shape. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 500 | 503,
    readonly type: GatewayErrorType
  ) {
    super(message);
  }
}

export function textOf(content: ContentPart[]): string {
  return content
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
