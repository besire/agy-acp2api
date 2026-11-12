import { ChatMessage, textOf, ToolChoice, ToolDefinition } from "../core/chat.js";

export interface CompiledContext {
  systemPromptAppend: string;
  promptText: string;
}

/**
 * Builds the minimal system prompt append instructions injected into `session/new` via `_meta.antigravity.systemPrompt.append`.
 * Paired with the worker's `excludeDefaultComponents: true` custom agent, only a single-line guard is needed
 * to suppress the residual `manage_task` control-plane tool, plus compact `<tool_call>` formatting when external tools are present.
 */
export function buildSystemPromptAppend(
  messages: ChatMessage[],
  tools: ToolDefinition[] = [],
  toolChoice?: ToolChoice
): string {
  const systemMessages = messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content).trim())
    .filter(Boolean);

  const blocks: string[] = [
    "Never call built-in tools (such as manage_task).",
  ];

  if (tools.length > 0 && toolChoice !== "none") {
    const toolDefsJson = JSON.stringify(
      tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.parameters || { type: "object", properties: {} },
      }))
    );

    let toolProtocol =
      'To call external tools from <available_tools>, emit raw XML (valid JSON inside, no code fences):\n<tool_call>\n{"name":"tool_name","arguments":{}}\n</tool_call>\nFor parallel calls, emit multiple <tool_call> blocks back-to-back. After <tool_call>, stop immediately and wait for <tool_response> without commentary or repetition.';

    if (toolChoice === "required") {
      toolProtocol +=
        "\ntool_choice is 'required': you MUST emit at least one <tool_call> block in this turn.";
    } else if (typeof toolChoice === "object") {
      toolProtocol += `\nYou MUST call "${toolChoice.name}" using a <tool_call> block in this turn.`;
    }

    blocks.push(toolProtocol);
    blocks.push(`<available_tools>\n${toolDefsJson}\n</available_tools>`);
  }

  if (systemMessages.length > 0) {
    blocks.push(systemMessages.join("\n\n"));
  }

  return blocks.join("\n\n");
}

/**
 * Serializes a single non-system message into a clear transcript block.
 */
function serializeSingleMessage(msg: ChatMessage): string {
  const text = textOf(msg.content).trim();

  if (msg.role === "assistant") {
    const parts: string[] = [];
    if (text) {
      // Strip any historical post-tool_call self-correction hallucinations from polluted transcripts
      const cleanedText =
        msg.toolCalls.length > 0
          ? text
              .replace(/^\s*(?:_\]|\]<\/tool_call>|<\/tool_call>|\]{2,}>\s*\u03f5?).*$/gms, "")
              .trim()
          : text;
      if (cleanedText) parts.push(cleanedText);
    }
    for (const tc of msg.toolCalls) {
      let parsedArgs: unknown = {};
      try {
        parsedArgs = JSON.parse(tc.arguments || "{}");
      } catch {
        parsedArgs = tc.arguments;
      }
      parts.push(
        `<tool_call>\n${JSON.stringify({
          name: tc.name,
          arguments: parsedArgs,
        })}\n</tool_call>`
      );
    }
    return parts.join("\n");
  }

  if (msg.role === "tool") {
    const idAttr = msg.toolCallId ? ` id="${msg.toolCallId}"` : "";
    const nameAttr = msg.name ? ` name="${msg.name}"` : "";
    return `<tool_response${idAttr}${nameAttr}>\n${text}\n</tool_response>`;
  }

  return text;
}

/**
 * Compiles full conversation history when creating a brand new ACP session (Cache Miss).
 */
export function compileFullPrompt(
  messages: ChatMessage[],
  tools: ToolDefinition[] = [],
  toolChoice?: ToolChoice
): CompiledContext {
  const systemPromptAppend = buildSystemPromptAppend(messages, tools, toolChoice);
  const nonSystem = messages.filter((m) => m.role !== "system");

  // Single user message fast-path
  if (nonSystem.length === 1 && nonSystem[0].role === "user") {
    return {
      systemPromptAppend,
      promptText: textOf(nonSystem[0].content),
    };
  }

  // Multi-turn transcript serialization
  const transcriptLines: string[] = [];
  for (let i = 0; i < nonSystem.length; i++) {
    const m = nonSystem[i];
    const body = serializeSingleMessage(m);
    if (i === nonSystem.length - 1 && m.role === "user") {
      transcriptLines.push(body);
    } else {
      transcriptLines.push(`[${m.role.toUpperCase()}]\n${body}`);
    }
  }

  return {
    systemPromptAppend,
    promptText: transcriptLines.join("\n\n"),
  };
}

/**
 * Compiles ONLY the delta messages (e.g. `<tool_response>` or latest user message)
 * when a Session Prefix Hash hits an existing warm ACP session!
 */
export function compileDeltaPrompt(deltaMessages: ChatMessage[]): string {
  return deltaMessages.map((m) => serializeSingleMessage(m)).join("\n\n");
}
