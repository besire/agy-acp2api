export type OpenAIRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAIMessageContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface OpenAIMessage {
  role: OpenAIRole;
  content: string | OpenAIMessageContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAIToolDefinition[];
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } };
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  /**
   * Standard OpenAI reasoning effort parameter (`low` | `medium` | `high` | `minimal` | `max` | `xhigh`)
   */
  reasoning_effort?: string;
  /**
   * Alternative reasoning/thinking object passed by clients like Cherry Studio, RooCode, Claude/Gemini adapters
   */
  thinking?: {
    type?: "enabled" | "disabled" | string;
    budget_tokens?: number;
    effort?: string;
    level?: string;
  };
  reasoning?: {
    effort?: string;
    level?: string;
    max_tokens?: number;
  };
  temperature?: number;
  max_tokens?: number;
  stop?: string | string[] | null;
}

export interface OpenAIUsageDetails {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens: number;
  };
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: OpenAIToolCallDelta[];
    };
    finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | null;
  }>;
  usage?: OpenAIUsageDetails;
}
