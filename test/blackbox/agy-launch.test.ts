import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { startGateway } from "../helpers/gateway.js";

async function bootArgv(env: Record<string, string> = {}): Promise<string[]> {
  const gw = await startGateway({ env });
  try {
    const res = await gw.chat({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    return gw.acpLog().find((e) => e.event === "boot")!.argv!;
  } finally {
    await gw.stop();
  }
}

describe("how agy is launched", () => {
  test("by default agy reaches its backend directly, as a stock install would", async () => {
    const argv = await bootArgv();
    assert.equal(argv[0], "acp");
    assert.ok(!argv.some((a) => a.startsWith("--cloud_code_endpoint")), argv.join(" "));
  });

  test("AGY2API_MODEL_SNIFFER=1 routes it through the local model sniffer", async () => {
    const argv = await bootArgv({ AGY2API_MODEL_SNIFFER: "1" });
    assert.ok(argv.some((a) => /^--cloud_code_endpoint=http:\/\/127\.0\.0\.1:\d+$/.test(a)), argv.join(" "));
  });
});
