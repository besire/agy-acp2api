import crypto from "node:crypto";
import { normalizeThinkingLevel } from "../../compiler/model-resolver.js";
import {
  AssistantMessage,
  ChatMessage,
  ContentPart,
  GatewayError,
  textOf,
  TokenUsage,
  ToolCall,
  ToolChoice,
  ToolDefinition,
  TurnEvent,
  TurnResult,
} from "../../core/chat.js";
import {
  ChatProtocol,
  ChatStreamEncoder,
  DecodedRequest,
  ResponseContext,
  SseFrame,
} from "../protocol.js";
import { decodeImageUrl, encodeArguments } from "./chat-completions.js";
import { ResponseStore } from "./response-store.js";

/**
 * OpenAI Responses API (`POST /v1/responses`): input items in, typed output items and the
 * `response.*` event stream out. Supports both stateless clients that resend the whole history
 * (`store: false`) and `previous_response_id` continuation from an in-memory store.
 */

type JsonObject = Record<string, any>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string, param?: string, code?: string): GatewayError {
  return new GatewayError(message, 400, "invalid_request_error", code, param);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString("hex")}`;
}

/** Request fields the response object echoes back, as the OpenAI API does. */
export interface ResponsesEcho {
  instructions: string | null;
  max_output_tokens: number | null;
  metadata: JsonObject;
  parallel_tool_calls: boolean;
  previous_response_id: string | null;
  reasoning: { effort: string | null; summary: string | null };
  store: boolean;
  temperature: number;
  text: JsonObject;
  tool_choice: unknown;
  tools: unknown[];
  top_p: number;
  truncation: string;
  user: string | null;
}

export interface ResponsesState {
  echo: ResponsesEcho;
  /** Leading messages that came from `instructions`; they are not part of stored history. */
  instructionMessages: number;
}

// ============================================================================
// Request decoding
// ============================================================================

function decodeInputContent(content: unknown): ContentPart[] {
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
    switch (part.type) {
      case "input_text":
      case "output_text":
      case "text":
        parts.push({ type: "text", text: optionalString(part.text) ?? "" });
        break;
      case "input_image": {
        const url = isObject(part.image_url) ? part.image_url.url : part.image_url;
        if (typeof url === "string" && url) parts.push(decodeImageUrl(url));
        break;
      }
      // input_file, refusal and file_id images carry nothing we can forward yet
    }
  }
  return parts;
}

function decodeInputMessage(item: JsonObject, index: number): ChatMessage {
  const content = decodeInputContent(item.content);
  switch (item.role) {
    case "user":
      return { role: "user", content };
    case "system":
    case "developer":
      return { role: "system", content };
    case "assistant":
      return { role: "assistant", content, toolCalls: [] };
    default:
      throw invalid(
        `input[${index}].role must be one of user, assistant, system, developer`,
        `input[${index}].role`
      );
  }
}

/**
 * Turns input items into neutral messages. A `function_call` joins the assistant message right
 * before it (that is how one assistant turn is split into items); `function_call_output`
 * becomes a tool result named after its call.
 */
function decodeInput(input: unknown, knownCalls: Map<string, string>): ChatMessage[] {
  if (input === undefined || input === null) return [];
  if (typeof input === "string") {
    return input ? [{ role: "user", content: [{ type: "text", text: input }] }] : [];
  }
  if (!Array.isArray(input)) {
    throw invalid("`input` must be a string or an array of input items", "input");
  }

  const messages: ChatMessage[] = [];
  input.forEach((item, i) => {
    if (!isObject(item)) {
      throw invalid(`input[${i}] must be an object`, `input[${i}]`);
    }
    const type = item.type ?? (item.role !== undefined ? "message" : undefined);
    switch (type) {
      case "message":
        messages.push(decodeInputMessage(item, i));
        return;
      case "function_call": {
        const call: ToolCall = {
          id: optionalString(item.call_id) ?? optionalString(item.id) ?? "",
          name: optionalString(item.name) ?? "",
          arguments: encodeArguments(item.arguments),
        };
        knownCalls.set(call.id, call.name);
        const last = messages[messages.length - 1];
        if (last?.role === "assistant") {
          last.toolCalls.push(call);
        } else {
          messages.push({ role: "assistant", content: [], toolCalls: [call] });
        }
        return;
      }
      case "function_call_output": {
        const callId = optionalString(item.call_id);
        messages.push({
          role: "tool",
          content: decodeInputContent(item.output),
          toolCallId: callId,
          name: callId ? knownCalls.get(callId) : undefined,
        });
        return;
      }
      case "item_reference":
        throw invalid(
          `input[${i}]: item_reference is not supported; send the item itself or use previous_response_id`,
          `input[${i}]`
        );
      // reasoning and hosted-tool items carry nothing the model needs again
    }
  });
  return messages;
}

function decodeTools(raw: unknown): ToolDefinition[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid("`tools` must be an array", "tools");

  const tools: ToolDefinition[] = [];
  raw.forEach((tool, i) => {
    // Hosted tools (web_search, file_search, custom, mcp, ...) have no meaning for ACP models
    if (!isObject(tool) || tool.type !== "function") return;
    // Accept the Chat Completions nesting too; some clients reuse their tool lists
    const fn = isObject(tool.function) ? tool.function : tool;
    if (typeof fn.name !== "string" || !fn.name) {
      throw invalid(`tools[${i}].name is required`, `tools[${i}].name`);
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
  if (isObject(raw) && raw.type === "function" && typeof raw.name === "string") {
    return { name: raw.name };
  }
  return undefined;
}

function callsIn(messages: ChatMessage[]): Map<string, string> {
  const calls = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const tc of m.toolCalls) calls.set(tc.id, tc.name);
    }
  }
  return calls;
}

export function decodeResponsesRequest(
  body: unknown,
  store: ResponseStore
): DecodedRequest<ResponsesState> {
  if (!isObject(body)) {
    throw invalid("Request body must be a JSON object");
  }

  const previousId = optionalString(body.previous_response_id);
  let history: ChatMessage[] = [];
  if (previousId) {
    const stored = store.get(previousId);
    if (!stored) {
      throw invalid(
        `Previous response with id '${previousId}' not found.`,
        "previous_response_id",
        "previous_response_not_found"
      );
    }
    history = stored;
  }

  const input = decodeInput(body.input, callsIn(history));
  if (input.length === 0 && !previousId) {
    throw invalid("`input` must contain at least one item", "input");
  }

  const instructions = optionalString(body.instructions);
  const instructionMessages: ChatMessage[] = instructions
    ? [{ role: "system", content: [{ type: "text", text: instructions }] }]
    : [];
  const reasoning = isObject(body.reasoning) ? body.reasoning : {};

  return {
    chat: {
      model: optionalString(body.model) ?? "",
      effort: normalizeThinkingLevel(
        optionalString(reasoning.effort) ?? optionalString(body.reasoning_effort)
      ),
      messages: [...instructionMessages, ...history, ...input],
      tools: decodeTools(body.tools),
      toolChoice: decodeToolChoice(body.tool_choice),
      stream: Boolean(body.stream),
    },
    state: {
      instructionMessages: instructionMessages.length,
      echo: {
        instructions: instructions ?? null,
        max_output_tokens: optionalNumber(body.max_output_tokens) ?? null,
        metadata: isObject(body.metadata) ? body.metadata : {},
        parallel_tool_calls:
          typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : true,
        previous_response_id: previousId ?? null,
        reasoning: {
          effort: optionalString(reasoning.effort) ?? null,
          summary: optionalString(reasoning.summary) ?? null,
        },
        store: body.store !== false,
        temperature: optionalNumber(body.temperature) ?? 1,
        text: isObject(body.text) ? body.text : { format: { type: "text" } },
        tool_choice: body.tool_choice ?? "auto",
        tools: Array.isArray(body.tools) ? body.tools : [],
        top_p: optionalNumber(body.top_p) ?? 1,
        truncation: optionalString(body.truncation) ?? "disabled",
        user: optionalString(body.user) ?? null,
      },
    },
  };
}

// ============================================================================
// Response encoding
// ============================================================================

interface SummaryText {
  type: "summary_text";
  text: string;
}

interface OutputText {
  type: "output_text";
  text: string;
  annotations: unknown[];
}

type ItemStatus = "in_progress" | "completed";

interface ReasoningItem {
  type: "reasoning";
  id: string;
  summary: SummaryText[];
}

interface MessageItem {
  type: "message";
  id: string;
  status: ItemStatus;
  role: "assistant";
  content: OutputText[];
}

interface FunctionCallItem {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: ItemStatus;
}

type OutputItem = ReasoningItem | MessageItem | FunctionCallItem;

export interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

export function toResponsesUsage(usage: TokenUsage): ResponsesUsage {
  const inputTokens = usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens;
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: usage.cachedReadTokens },
    // ACP `outputTokens` already includes `thoughtTokens`
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: usage.thoughtTokens },
    total_tokens: inputTokens + usage.outputTokens,
  };
}

const summaryText = (text: string): SummaryText => ({ type: "summary_text", text });
const outputText = (text: string): OutputText => ({ type: "output_text", text, annotations: [] });

function functionCallItem(call: ToolCall): FunctionCallItem {
  return {
    type: "function_call",
    id: newId("fc"),
    call_id: call.id,
    name: call.name,
    arguments: call.arguments,
    status: "completed",
  };
}

function outputItems(reasoning: string, message: AssistantMessage): OutputItem[] {
  const items: OutputItem[] = [];
  if (reasoning) {
    items.push({ type: "reasoning", id: newId("rs"), summary: [summaryText(reasoning)] });
  }
  const text = textOf(message.content);
  if (text) {
    items.push({
      type: "message",
      id: newId("msg"),
      status: "completed",
      role: "assistant",
      content: [outputText(text)],
    });
  }
  items.push(...message.toolCalls.map(functionCallItem));
  return items;
}

function responseObject(
  ctx: ResponseContext<ResponsesState>,
  fields: {
    status: "in_progress" | "completed" | "failed";
    model: string;
    output: OutputItem[];
    usage?: ResponsesUsage;
    error?: { code: string; message: string };
  }
): JsonObject {
  return {
    id: ctx.id,
    object: "response",
    created_at: ctx.created,
    status: fields.status,
    error: fields.error ?? null,
    incomplete_details: null,
    model: fields.model,
    output: fields.output,
    usage: fields.usage ?? null,
    ...ctx.state.echo,
  };
}

/**
 * Emits the `response.*` event sequence. Thought and text runs become reasoning and message
 * items; an item is closed (with its `.done` events) before the next one opens, so a thought
 * arriving after text simply starts a new reasoning item.
 */
class ResponsesStreamEncoder implements ChatStreamEncoder {
  private sequence = 0;
  private model: string;
  private readonly items: OutputItem[] = [];
  private open: { item: ReasoningItem | MessageItem; index: number; text: string } | null = null;

  constructor(private readonly ctx: ResponseContext<ResponsesState>) {
    this.model = ctx.model;
  }

  start(): SseFrame[] {
    const response = this.snapshot("in_progress");
    return [
      this.frame("response.created", { response }),
      this.frame("response.in_progress", { response }),
    ];
  }

  event(event: TurnEvent): SseFrame[] {
    switch (event.type) {
      case "model":
        this.model = event.model;
        return [];
      case "thought":
        return [...this.ensureOpen("reasoning"), ...this.delta(event.text)];
      case "text":
        return [...this.ensureOpen("message"), ...this.delta(event.text)];
      case "tool_call":
        return [...this.closeOpen(), ...this.functionCall(event.call)];
    }
  }

  finish(result: TurnResult): SseFrame[] {
    this.model = result.actualModel;
    return [
      ...this.closeOpen(),
      this.frame("response.completed", {
        response: this.snapshot("completed", toResponsesUsage(result.usage)),
      }),
    ];
  }

  fail(message: string): SseFrame[] {
    return [
      ...this.closeOpen(),
      this.frame("response.failed", {
        response: {
          ...this.snapshot("failed"),
          error: { code: "server_error", message },
        },
      }),
    ];
  }

  private snapshot(status: "in_progress" | "completed" | "failed", usage?: ResponsesUsage) {
    return responseObject(this.ctx, { status, model: this.model, output: this.items, usage });
  }

  private frame(type: string, payload: JsonObject): SseFrame {
    return {
      event: type,
      data: JSON.stringify({ type, sequence_number: this.sequence++, ...payload }),
    };
  }

  private ensureOpen(kind: "reasoning" | "message"): SseFrame[] {
    if (this.open?.item.type === kind) return [];
    const frames = this.closeOpen();
    const index = this.items.length;
    if (kind === "reasoning") {
      const item: ReasoningItem = { type: "reasoning", id: newId("rs"), summary: [] };
      this.items.push(item);
      this.open = { item, index, text: "" };
      frames.push(
        this.frame("response.output_item.added", { output_index: index, item }),
        this.frame("response.reasoning_summary_part.added", {
          item_id: item.id,
          output_index: index,
          summary_index: 0,
          part: summaryText(""),
        })
      );
    } else {
      const item: MessageItem = {
        type: "message",
        id: newId("msg"),
        status: "in_progress",
        role: "assistant",
        content: [],
      };
      this.items.push(item);
      this.open = { item, index, text: "" };
      frames.push(
        this.frame("response.output_item.added", { output_index: index, item }),
        this.frame("response.content_part.added", {
          item_id: item.id,
          output_index: index,
          content_index: 0,
          part: outputText(""),
        })
      );
    }
    return frames;
  }

  private delta(text: string): SseFrame[] {
    const open = this.open!;
    open.text += text;
    const where = { item_id: open.item.id, output_index: open.index };
    return open.item.type === "reasoning"
      ? [this.frame("response.reasoning_summary_text.delta", { ...where, summary_index: 0, delta: text })]
      : [this.frame("response.output_text.delta", { ...where, content_index: 0, delta: text, logprobs: [] })];
  }

  private closeOpen(): SseFrame[] {
    const open = this.open;
    if (!open) return [];
    this.open = null;
    const where = { item_id: open.item.id, output_index: open.index };

    if (open.item.type === "reasoning") {
      const part = summaryText(open.text);
      open.item.summary = [part];
      return [
        this.frame("response.reasoning_summary_text.done", { ...where, summary_index: 0, text: open.text }),
        this.frame("response.reasoning_summary_part.done", { ...where, summary_index: 0, part }),
        this.frame("response.output_item.done", { output_index: open.index, item: open.item }),
      ];
    }

    const part = outputText(open.text);
    open.item.content = [part];
    open.item.status = "completed";
    return [
      this.frame("response.output_text.done", { ...where, content_index: 0, text: open.text, logprobs: [] }),
      this.frame("response.content_part.done", { ...where, content_index: 0, part }),
      this.frame("response.output_item.done", { output_index: open.index, item: open.item }),
    ];
  }

  private functionCall(call: ToolCall): SseFrame[] {
    const index = this.items.length;
    const item = { ...functionCallItem(call), arguments: "", status: "in_progress" as ItemStatus };
    this.items.push(item);
    const where = { item_id: item.id, output_index: index };
    const frames = [
      this.frame("response.output_item.added", { output_index: index, item }),
      this.frame("response.function_call_arguments.delta", { ...where, delta: call.arguments }),
      this.frame("response.function_call_arguments.done", {
        ...where,
        name: call.name,
        arguments: call.arguments,
      }),
    ];
    item.arguments = call.arguments;
    item.status = "completed";
    frames.push(this.frame("response.output_item.done", { output_index: index, item }));
    return frames;
  }
}

export function createResponsesProtocol(
  store: ResponseStore = new ResponseStore()
): ChatProtocol<ResponsesState> {
  return {
    decodeRequest: (body) => decodeResponsesRequest(body, store),

    newResponseId: () => newId("resp"),

    encodeResponse(ctx, result) {
      return responseObject(ctx, {
        status: "completed",
        model: result.actualModel,
        output: outputItems(result.reasoning, result.message),
        usage: toResponsesUsage(result.usage),
      });
    },

    createStreamEncoder: (ctx) => new ResponsesStreamEncoder(ctx),

    encodeError(err) {
      return {
        error: {
          message: err.message,
          type: err.type,
          param: err.param ?? null,
          code: err.code ?? null,
        },
      };
    },

    onTurnComplete(ctx, request, result) {
      if (!ctx.state.echo.store) return;
      store.save(ctx.id, [
        ...request.messages.slice(ctx.state.instructionMessages),
        result.message,
      ]);
    },
  };
}
