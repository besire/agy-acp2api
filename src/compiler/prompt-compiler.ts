import { OpenAIMessage, OpenAIToolDefinition } from "../types/openai.js";
import { extractTextContent } from "./session-hash.js";

export interface CompiledContext {
  systemPromptAppend: string;
  promptText: string;
}

/**
 * Builds the system prompt append instructions injected into `session/new` via `_meta.antigravity.systemPrompt.append`.
 * Explicitly disables all native ACP tools and enforces XML `<tool_call>` formatting when external tools are present.
 */
export function buildSystemPromptAppend(
  messages: OpenAIMessage[],
  tools?: OpenAIToolDefinition[],
  toolChoice?: unknown
): string {
  const systemMessages = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => extractTextContent(m.content).trim())
    .filter(Boolean);

  const blocks: string[] = [];

  blocks.push(`<system_override>
CRITICAL RUNTIME RULES:
1. You are operating as a pure stateless/session-bridged inference engine behind an OpenAI API Gateway.
2. ALL native/built-in Antigravity CLI tools (such as read_file, write_file, edit_file, run_command, grep, glob, browser, etc.) are STRICTLY PROHIBITED and sandboxed in an empty read-only directory. NEVER invoke any native/built-in tool under any circumstance.
3. Answer directly in plain text unless external tools are provided in <available_tools> below.`);

  if (tools && tools.length > 0 && toolChoice !== "none") {
    const toolDefsJson = JSON.stringify(
      tools.map((t) => ({
        name: t.function.name,
        description: t.function.description || "",
        parameters: t.function.parameters || { type: "object", properties: {} },
      })),
      null,
      2
    );

    let choiceInstruction =
      "4. When you need to call one or more external tools from <available_tools>, you MUST emit raw XML <tool_call> block(s) in your text response using THIS EXACT FORMAT (valid JSON inside <tool_call></tool_call>, NO markdown code fences inside the tag):\n<tool_call>\n{\"name\": \"exact_tool_name\", \"arguments\": {\"key\": \"value\"}}\n</tool_call>\n5. If calling multiple distinct tools in parallel, output multiple <tool_call>...</tool_call> blocks back-to-back.\n6. After outputting <tool_call>...</tool_call>, end your response and wait for <tool_response>. NEVER output meta-commentary about stopping or waiting, NEVER critique or apologize for your own formatting or trailing characters, and NEVER repeat the same <tool_call> block more than once in a turn.";

    if (toolChoice === "required") {
      choiceInstruction +=
        "\n7. IMPORTANT: tool_choice is set to 'required'. You MUST output at least one <tool_call>...</tool_call> block in this turn.";
    } else if (
      typeof toolChoice === "object" &&
      toolChoice !== null &&
      "function" in toolChoice &&
      typeof (toolChoice as { function?: { name?: string } }).function?.name === "string"
    ) {
      const forcedName = (toolChoice as { function: { name: string } }).function.name;
      choiceInstruction += `\n7. IMPORTANT: You MUST call the tool named "${forcedName}" using a <tool_call>...</tool_call> block in this turn.`;
    }

    blocks.push(choiceInstruction);
    blocks.push(`</system_override>\n\n<available_tools>\n${toolDefsJson}\n</available_tools>`);
  } else {
    blocks.push(`</system_override>`);
  }

  if (systemMessages.length > 0) {
    blocks.push(`<developer_instructions>\n${systemMessages.join("\n\n")}\n</developer_instructions>`);
  }

  return blocks.join("\n\n");
}

/**
 * Serializes a single non-system OpenAI message into a clear transcript block.
 */
function serializeSingleMessage(msg: OpenAIMessage): string {
  const text = extractTextContent(msg.content).trim();

  if (msg.role === "user") {
    return text;
  }

  if (msg.role === "assistant") {
    const parts: string[] = [];
    if (text) {
      // Strip any historical post-tool_call self-correction hallucinations from polluted transcripts
      const cleanedText =
        msg.tool_calls && msg.tool_calls.length > 0
          ? text
              .replace(/^\s*(?:_\]|\]<\/tool_call>|<\/tool_call>|\]{2,}>\s*\u03f5?).*$/gms, "")
              .trim()
          : text;
      if (cleanedText) parts.push(cleanedText);
    }
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let parsedArgs: unknown = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || "{}");
        } catch {
          parsedArgs = tc.function.arguments;
        }
        parts.push(
          `<tool_call>\n${JSON.stringify({
            name: tc.function.name,
            arguments: parsedArgs,
          })}\n</tool_call>`
        );
      }
    }
    return parts.join("\n");
  }

  if (msg.role === "tool") {
    const idAttr = msg.tool_call_id ? ` id="${msg.tool_call_id}"` : "";
    const nameAttr = msg.name ? ` name="${msg.name}"` : "";
    return `<tool_response${idAttr}${nameAttr}>\n${text}\n</tool_response>`;
  }

  return text;
}

/**
 * Compiles full conversation history when creating a brand new ACP session (Cache Miss).
 */
export function compileFullPrompt(
  messages: OpenAIMessage[],
  tools?: OpenAIToolDefinition[],
  toolChoice?: unknown
): CompiledContext {
  const systemPromptAppend = buildSystemPromptAppend(messages, tools, toolChoice);
  const nonSystem = messages.filter((m) => m.role !== "system" && m.role !== "developer");

  // Single user message fast-path
  if (nonSystem.length === 1 && nonSystem[0].role === "user") {
    return {
      systemPromptAppend,
      promptText: extractTextContent(nonSystem[0].content),
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
export function compileDeltaPrompt(deltaMessages: OpenAIMessage[]): string {
  return deltaMessages.map((m) => serializeSingleMessage(m)).join("\n\n");
}
