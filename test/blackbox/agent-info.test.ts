import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Gateway, startGateway } from "../helpers/gateway.js";

describe("agent info", () => {
  let gw: Gateway;
  before(async () => {
    gw = await startGateway();
  });
  after(async () => {
    await gw?.stop();
  });

  test("admin overview reports what agy declared in initialize", async () => {
    const res = await gw.fetch("/api/admin/overview");
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.agent.protocolVersion, 1);
    assert.deepEqual(body.agent.agentCapabilities.promptCapabilities, {
      image: true,
      audio: false,
      embeddedContext: true,
    });
  });
});
