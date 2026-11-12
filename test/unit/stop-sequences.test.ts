import "../helpers/isolate-env.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { finishReasonFor } from "../../src/core/chat-service.js";
import { StopSequenceFilter } from "../../src/core/stop-sequences.js";

function run(stops: string[], chunks: string[]) {
  const filter = new StopSequenceFilter(stops);
  const shown = chunks.map((c) => filter.push(c));
  shown.push(filter.flush());
  return { text: shown.join(""), shown, stopped: filter.stopped };
}

describe("StopSequenceFilter", () => {
  test("cuts before the earliest stop sequence", () => {
    assert.deepEqual(run(["END", "x"], ["abc", "dxEND"]), {
      text: "abcd",
      shown: ["abc", "d", ""],
      stopped: true,
    });
  });

  test("holds back a possible prefix until the next chunk decides", () => {
    const { shown, text, stopped } = run(["</ans>"], ["one </a", "ns> two"]);
    assert.deepEqual(shown, ["one ", "", ""]);
    assert.equal(text, "one ");
    assert.equal(stopped, true);

    const released = run(["</ans>"], ["one </a", "bc>"]);
    assert.deepEqual(released.shown, ["one ", "</abc>", ""]);
    assert.equal(released.stopped, false);
  });

  test("releases the held tail at the end and ignores text after a stop", () => {
    const filter = new StopSequenceFilter(["STOP"]);
    assert.equal(filter.push("almost ST"), "almost ");
    assert.equal(filter.flush(), "ST");

    const stopped = new StopSequenceFilter(["!"]);
    assert.equal(stopped.push("hi! there"), "hi");
    assert.equal(stopped.push("more"), "");
    assert.equal(stopped.flush(), "");
  });
});

describe("finishReasonFor", () => {
  test("maps ACP stop reasons; tool calls win", () => {
    assert.equal(finishReasonFor("end_turn", 0), "stop");
    assert.equal(finishReasonFor("max_tokens", 0), "length");
    assert.equal(finishReasonFor("max_turn_requests", 0), "length");
    assert.equal(finishReasonFor("refusal", 0), "content_filter");
    assert.equal(finishReasonFor("cancelled", 0), "stop");
    assert.equal(finishReasonFor(undefined, 0), "stop");
    assert.equal(finishReasonFor("max_tokens", 2), "tool_calls");
  });
});
