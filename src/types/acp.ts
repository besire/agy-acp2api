export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** What the agent declares in its `initialize` response. */
export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
    [key: string]: unknown;
  };
  agentInfo?: {
    name?: string;
    title?: string;
    version?: string;
  };
  authMethods?: Array<{ id: string; name?: string; description?: string }>;
}

export interface AcpModelInfo {
  modelId: string;
  name: string;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: string;
  options?: Array<{
    value: string;
    name: string;
    description?: string;
  }>;
}

export interface AcpSessionNewResult {
  sessionId: string;
  models?: {
    availableModels: AcpModelInfo[];
    currentModelId: string;
  };
  modes?: {
    currentModeId: string;
    availableModes: Array<{
      id: string;
      name: string;
      description?: string;
    }>;
  };
  configOptions?: AcpConfigOption[];
}

export interface AcpPromptResult {
  stopReason: "end_turn" | "max_tokens" | "cancelled" | "refusal" | string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
    totalTokens: number;
  };
}

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: {
    sessionUpdate:
      | "agent_message_chunk"
      | "agent_thought_chunk"
      | "user_message_chunk"
      | "tool_call"
      | "tool_call_update"
      | "current_mode_update"
      | "config_option_update"
      | "available_commands_update"
      | "session_info_update"
      | string;
    content?: {
      type: string;
      text?: string;
    };
    configOptions?: AcpConfigOption[];
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: unknown;
  };
}
