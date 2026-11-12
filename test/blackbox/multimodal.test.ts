import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { Gateway, startGateway } from "../helpers/gateway.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_B64, "base64").length;
// A different (tiny) image so two turns can be told apart
const GIF_B64 = "R0lGODlhAQABAAAAACw=";

const dataUrl = (mime: string, b64: string) => `data:${mime};base64,${b64}`;

describe("image input", () => {
  let gw: Gateway;
  before(async () => {
    gw = await startGateway();
  });
  after(async () => {
    await gw?.stop();
  });

  const promptsOf = (g: Gateway, sessionId: string | null) =>
    g
      .acpRequests("session/prompt")
      .filter((m) => m.params.sessionId === sessionId)
      .map((m) => m.params.prompt as any[]);

  test("chat completions: an image_url part reaches agy as an image block in place", async () => {
    const res = await gw.chat({
      model: "gemini-3.8-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: dataUrl("image/png", PNG_B64) } },
            { type: "text", text: "this" },
          ],
        },
      ],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.choices[0].message.content, `echo: describe <image image/png ${PNG_BYTES}B> this`);

    const [prompt] = promptsOf(gw, res.headers.get("X-Agy2Api-Session-Id"));
    assert.deepEqual(prompt, [
      { type: "text", text: "describe\n" },
      { type: "image", mimeType: "image/png", data: PNG_B64 },
      { type: "text", text: "\nthis" },
    ]);
  });

  test("responses: input_image works the same, and a warm session only gets the new image", async () => {
    const input: any[] = [
      {
        role: "user",
        content: [
          { type: "input_text", text: "first" },
          { type: "input_image", image_url: dataUrl("image/png", PNG_B64) },
        ],
      },
    ];
    const post = (body: Record<string, unknown>) =>
      gw.fetch("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const res1 = await post({ model: "gemini-3.8-flash", store: false, input });
    assert.equal(res1.status, 200);
    const sessionId = res1.headers.get("X-Agy2Api-Session-Id");
    const body1 = (await res1.json()) as any;
    assert.match(body1.output.at(-1).content[0].text, /<image image\/png \d+B>/);

    // Image without a declared type: sniffed as GIF
    input.push(...body1.output, {
      role: "user",
      content: [{ type: "input_image", image_url: `data:;base64,${GIF_B64}` }],
    });
    const res2 = await post({ model: "gemini-3.8-flash", store: false, input });
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get("X-Agy2Api-Session-Cache"), "HIT");
    assert.equal(res2.headers.get("X-Agy2Api-Session-Id"), sessionId);
    await res2.arrayBuffer();

    const prompts = promptsOf(gw, sessionId);
    assert.equal(prompts.length, 2);
    assert.deepEqual(prompts[1], [{ type: "image", mimeType: "image/gif", data: GIF_B64 }]);
  });

  test("an unusable image is a 400 and does not cost a worker", async () => {
    const boots = () => gw.acpLog().filter((e) => e.event === "boot").length;
    const before = boots();
    for (const url of ["http://127.0.0.1:9/cat.png", "data:image/png;base64,***", "file:///etc/hosts"]) {
      const res = await gw.chat({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }],
      });
      assert.equal(res.status, 400, url);
      const body = (await res.json()) as any;
      assert.equal(body.error.code, "invalid_image");
    }
    const ok = await gw.chat({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "still fine" }] });
    assert.equal(ok.status, 200);
    await ok.arrayBuffer();
    assert.equal(boots(), before);
  });
});

describe("image URLs", () => {
  let gw: Gateway;
  let server: http.Server;
  let imageUrl = "";

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/cat.png") res.writeHead(200, { "Content-Type": "image/png" }).end(Buffer.from(PNG_B64, "base64"));
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    imageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cat.png`;
    gw = await startGateway({ env: { AGY2API_ALLOW_PRIVATE_IMAGE_URLS: "1" } });
  });
  after(async () => {
    await gw?.stop();
    await new Promise<void>((r) => server.close(() => r()));
  });

  test("are downloaded by the gateway and sent inline with their source URI", async () => {
    const res = await gw.chat({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: imageUrl } }] }],
    });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    const prompt = gw
      .acpRequests("session/prompt")
      .find((m) => m.params.sessionId === res.headers.get("X-Agy2Api-Session-Id"))!.params.prompt;
    assert.deepEqual(prompt, [{ type: "image", mimeType: "image/png", data: PNG_B64, uri: imageUrl }]);
  });
});

describe("agent without image support", () => {
  let gw: Gateway;
  before(async () => {
    gw = await startGateway({ fakeControl: { promptCapabilities: { image: false } } });
  });
  after(async () => {
    await gw?.stop();
  });

  test("images become a placeholder instead of an unsupported block", async () => {
    const res = await gw.chat({
      model: "gemini-3.8-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is" },
            // Would be a 400 if the gateway tried to fetch it
            { type: "image_url", image_url: { url: "http://127.0.0.1:9/cat.png" } },
          ],
        },
      ],
    });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    const prompt = gw
      .acpRequests("session/prompt")
      .find((m) => m.params.sessionId === res.headers.get("X-Agy2Api-Session-Id"))!.params.prompt;
    assert.deepEqual(prompt, [{ type: "text", text: "what is\n[image omitted]" }]);
  });
});
