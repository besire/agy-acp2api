import {
  ChatMessage,
  ContentPart,
  textOf,
  ToolChoice,
  ToolDefinition,
} from "../core/chat.js";
import { AcpContentBlock } from "../types/acp.js";

export interface CompileOptions {
  /** The agent accepts image blocks; otherwise images become a text placeholder. */
  images?: boolean;
}

export interface CompiledContext {
  systemPromptAppend: string;
  prompt: AcpContentBlock[];
}

export const IMAGE_PLACEHOLDER = "[image omitted]";

type Segment = string | Extract<AcpContentBlock, { type: "image" }>;

/** Accumulates prompt segments, merging adjacent text so a text-only prompt is one block. */
class PromptBuilder {
  private readonly blocks: AcpContentBlock[] = [];

  push(...segments: Segment[]): this {
    for (const segment of segments) {
      if (typeof segment !== "string") {
        this.blocks.push(segment);
        continue;
      }
      if (!segment) continue;
      const last = this.blocks[this.blocks.length - 1];
      if (last?.type === "text") last.text += segment;
      else this.blocks.push({ type: "text", text: segment });
    }
    return this;
  }

  build(): AcpContentBlock[] {
    return this.blocks.length > 0 ? this.blocks : [{ type: "text", text: "" }];
  }
}

/**
 * Content as prompt segments: parts joined by newlines like `textOf`, images inline as blocks
 * (only inlined images; anything else is a placeholder). With `trim`, the text ends are trimmed
 * as `textOf(...).trim()` would.
 */
function contentSegments(content: ContentPart[], opts: CompileOptions, trim: boolean): Segment[] {
  const segments: Segment[] = [];
  content.forEach((part, i) => {
    if (i > 0) segments.push("\n");
    if (part.type === "text") {
      segments.push(part.text);
    } else if (opts.images && part.data && part.mimeType) {
      segments.push({
        type: "image",
        mimeType: part.mimeType,
        data: part.data,
        ...(part.url ? { uri: part.url } : {}),
      });
    } else {
      segments.push(IMAGE_PLACEHOLDER);
    }
  });
  const joined = joinText(segments);
  if (!trim) return joined;

  const last = joined.length - 1;
  return joined.map((s, i) => {
    if (typeof s !== "string") return s;
    let text = s;
    if (i === 0) text = text.trimStart();
    if (i === last) text = text.trimEnd();
    return text;
  });
}

function joinText(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    const prev = out[out.length - 1];
    if (typeof s === "string" && typeof prev === "string") out[out.length - 1] = prev + s;
    else out.push(s);
  }
  return out;
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
 * Serializes a single non-system message into transcript segments.
 */
function serializeSingleMessage(msg: ChatMessage, opts: CompileOptions): Segment[] {
  if (msg.role === "assistant") {
    // The model's own earlier turns are replayed as text only
    const text = textOf(msg.content).trim();
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
    return [parts.join("\n")];
  }

  const body = contentSegments(msg.content, opts, true);
  if (msg.role === "tool") {
    const idAttr = msg.toolCallId ? ` id="${msg.toolCallId}"` : "";
    const nameAttr = msg.name ? ` name="${msg.name}"` : "";
    return [`<tool_response${idAttr}${nameAttr}>\n`, ...body, "\n</tool_response>"];
  }

  return body;
}

/**
 * Compiles full conversation history when creating a brand new ACP session (Cache Miss).
 */
export function compileFullPrompt(
  messages: ChatMessage[],
  tools: ToolDefinition[] = [],
  toolChoice?: ToolChoice,
  opts: CompileOptions = {}
): CompiledContext {
  const systemPromptAppend = buildSystemPromptAppend(messages, tools, toolChoice);
  const nonSystem = messages.filter((m) => m.role !== "system");
  const prompt = new PromptBuilder();

  // Single user message fast-path
  if (nonSystem.length === 1 && nonSystem[0].role === "user") {
    return {
      systemPromptAppend,
      prompt: prompt.push(...contentSegments(nonSystem[0].content, opts, false)).build(),
    };
  }

  // Multi-turn transcript serialization
  nonSystem.forEach((m, i) => {
    if (i > 0) prompt.push("\n\n");
    if (!(i === nonSystem.length - 1 && m.role === "user")) {
      prompt.push(`[${m.role.toUpperCase()}]\n`);
    }
    prompt.push(...serializeSingleMessage(m, opts));
  });

  return { systemPromptAppend, prompt: prompt.build() };
}

/**
 * Compiles ONLY the delta messages (e.g. `<tool_response>` or latest user message)
 * when a Session Prefix Hash hits an existing warm ACP session!
 */
export function compileDeltaPrompt(
  deltaMessages: ChatMessage[],
  opts: CompileOptions = {}
): AcpContentBlock[] {
  const prompt = new PromptBuilder();
  deltaMessages.forEach((m, i) => {
    if (i > 0) prompt.push("\n\n");
    prompt.push(...serializeSingleMessage(m, opts));
  });
  return prompt.build();
}
