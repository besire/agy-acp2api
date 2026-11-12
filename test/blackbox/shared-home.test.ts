import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { Gateway, startGateway } from "../helpers/gateway.js";

describe("two gateways sharing one gemini home", () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "agy2api-shared-gemini-"));
  const gateways: Gateway[] = [];
  after(async () => {
    await Promise.all(gateways.map((g) => g.stop()));
    fs.rmSync(shared, { recursive: true, force: true });
  });

  const sandboxes = () => fs.readdirSync(shared).filter((e) => e.startsWith("agy2api-worker-"));

  test("starting the second does not delete the first one's worker sandboxes", async () => {
    gateways.push(await startGateway({ env: { AGY_GEMINI_HOME: shared } }));
    const first = sandboxes();
    assert.ok(first.length > 0);

    gateways.push(await startGateway({ env: { AGY_GEMINI_HOME: shared } }));
    const after = sandboxes();
    for (const name of first) {
      assert.ok(after.includes(name), `${name} was swept by the second gateway`);
    }
    assert.ok(after.length > first.length);

    const res = await gateways[0].chat({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "still here" }],
    });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
  });
});
