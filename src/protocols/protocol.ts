import { ChatRequest, GatewayError, TurnEvent, TurnResult } from "../core/chat.js";

/** Identity of one response, fixed before the turn starts. */
export interface ResponseContext<S = undefined> {
  id: string;
  /** Unix seconds. */
  created: number;
  /** Model reported until the upstream model is detected. */
  model: string;
  /** Protocol-specific data decoded with the request (e.g. fields echoed in the response). */
  state: S;
}

export interface DecodedRequest<S> {
  chat: ChatRequest;
  state: S;
}

export interface SseFrame {
  event?: string;
  data: string;
}

/** Stateful translator from turn events to one protocol's server-sent events. */
export interface ChatStreamEncoder {
  /** Frames sent before any upstream output. */
  start(): SseFrame[];
  event(event: TurnEvent): SseFrame[];
  finish(result: TurnResult): SseFrame[];
  /** Frames that end the stream after a failure mid-turn. */
  fail(message: string): SseFrame[];
}

/** One client-facing chat API, e.g. OpenAI Chat Completions. */
export interface ChatProtocol<S = undefined> {
  /** Validates a parsed JSON body; throws a 400 `GatewayError` when it is unusable. */
  decodeRequest(body: unknown): DecodedRequest<S>;
  newResponseId(): string;
  encodeResponse(ctx: ResponseContext<S>, result: TurnResult): unknown;
  createStreamEncoder(ctx: ResponseContext<S>): ChatStreamEncoder;
  encodeError(err: GatewayError): unknown;
  /** Runs after a successful turn, before the final response is sent. */
  onTurnComplete?(ctx: ResponseContext<S>, request: ChatRequest, result: TurnResult): void;
}
