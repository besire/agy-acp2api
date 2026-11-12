import { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { ChatService, ChatTurn, errorMessage } from "../core/chat-service.js";
import { ChatRequest, GatewayError } from "../core/chat.js";
import { ChatProtocol, ResponseContext, SseFrame } from "../protocols/protocol.js";

function toGatewayError(err: unknown): GatewayError {
  return err instanceof GatewayError
    ? err
    : new GatewayError(errorMessage(err), 500, "server_error");
}

/**
 * HTTP handler for one chat protocol: decode → prepare → (stream | respond). All protocol
 * specifics live in `protocol`; everything else is shared.
 */
export function chatEndpoint(protocol: ChatProtocol, service: ChatService) {
  const fail = (c: Context, err: GatewayError) =>
    c.json(protocol.encodeError(err) as object, err.status);

  return async (c: Context) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, new GatewayError("Invalid JSON request body", 400, "invalid_request_error"));
    }

    let req: ChatRequest;
    let turn: ChatTurn;
    const id = protocol.newResponseId();
    const created = Math.floor(Date.now() / 1000);
    try {
      req = protocol.decodeRequest(body);
      turn = await service.prepare(req, id);
    } catch (err) {
      return fail(c, toGatewayError(err));
    }

    c.header("X-Agy2Api-Session-Cache", turn.sessionCache);
    c.header("X-Agy2Api-Session-Id", turn.sessionId);
    c.header("X-Agy2Api-Worker-Id", turn.workerId);
    c.header("X-Agy2Api-Resolved-Model", turn.target.baseModelId);
    c.header("X-Agy2Api-Thinking-Level", turn.target.thinkingLevel);

    const ctx: ResponseContext = { id, created, model: turn.target.baseModelId };

    if (req.stream) {
      return streamSSE(c, async (stream) => {
        const abortController = new AbortController();
        stream.onAbort(() => abortController.abort());

        const encoder = protocol.createStreamEncoder(ctx);
        // Events arrive from synchronous worker callbacks; writes are queued in order
        const send = (frames: SseFrame[]) => {
          for (const frame of frames) void stream.writeSSE(frame);
        };
        const sendAndWait = async (frames: SseFrame[]) => {
          for (const frame of frames) await stream.writeSSE(frame);
        };

        send(encoder.start());
        try {
          const result = await turn.run((event) => send(encoder.event(event)), abortController.signal);
          await sendAndWait(encoder.finish(result));
        } catch (err) {
          await sendAndWait(encoder.fail(errorMessage(err)));
        }
      });
    }

    try {
      const result = await turn.run(() => {}, c.req.raw.signal);
      c.header("X-Agy2Api-Actual-Model", result.actualModel);
      c.header("X-Agy2Api-TTFT-Ms", String(result.ttftMs));
      return c.json(protocol.encodeResponse(ctx, result) as object);
    } catch (err) {
      return fail(c, new GatewayError(errorMessage(err), 500, "server_error"));
    }
  };
}
