import "../helpers/isolate-env.js";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { ChatMessage, GatewayError } from "../../src/core/chat.js";
import {
  isPrivateAddress,
  MAX_IMAGE_BYTES,
  resolveImages,
  sniffImageType,
} from "../../src/core/images.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");

const userWith = (...content: ChatMessage["content"]): ChatMessage => ({ role: "user", content });

const isInvalidImage = (err: unknown) =>
  err instanceof GatewayError && err.status === 400 && err.code === "invalid_image";

describe("image address policy and formats", () => {
  test("private, loopback and link-local addresses are blocked", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.5.4",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "not-an-ip",
    ]) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "93.184.216.34", "2001:4860:4860::8888"]) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });

  test("sniffs PNG, JPEG, GIF and WebP", () => {
    assert.equal(sniffImageType(PNG), "image/png");
    assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffImageType(Buffer.from("GIF89a")), "image/gif");
    assert.equal(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
    assert.equal(sniffImageType(Buffer.from("<html>")), undefined);
  });
});

describe("resolveImages", () => {
  test("validates inline images and fills in a missing MIME type", async () => {
    const [msg] = await resolveImages([userWith({ type: "image", data: PNG_B64 })]);
    assert.deepEqual(msg.content, [{ type: "image", data: PNG_B64, mimeType: "image/png" }]);

    for (const data of ["not base64!", "QUJD", "A".repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8)]) {
      await assert.rejects(resolveImages([userWith({ type: "image", data })]), isInvalidImage);
    }
  });

  test("refuses non-http schemes and private hosts unless allowed", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/a.png", "not a url"]) {
      await assert.rejects(resolveImages([userWith({ type: "image", url })]), isInvalidImage, url);
    }
    await assert.rejects(
      resolveImages([userWith({ type: "image", url: "http://127.0.0.1:1/a.png" })], {
        allowPrivateUrls: false,
      }),
      (err) => isInvalidImage(err) && /private address/.test((err as Error).message)
    );
  });

  test("leaves system and assistant images alone and does not mutate its input", async () => {
    const input: ChatMessage[] = [
      { role: "system", content: [{ type: "image", url: "http://127.0.0.1:1/s.png" }] },
      { role: "assistant", content: [{ type: "image", url: "http://127.0.0.1:1/a.png" }], toolCalls: [] },
      userWith({ type: "text", text: "plain" }),
    ];
    const snapshot = structuredClone(input);
    const out = await resolveImages(input, { allowPrivateUrls: false });
    assert.deepEqual(out, snapshot);
    assert.deepEqual(input, snapshot);
  });

  describe("downloads", () => {
    let server: http.Server;
    let base = "";
    const hits = new Map<string, number>();

    before(async () => {
      server = http.createServer((req, res) => {
        hits.set(req.url!, (hits.get(req.url!) ?? 0) + 1);
        if (req.url === "/a.png") {
          res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
        } else if (req.url === "/untyped") {
          res.writeHead(200).end(PNG);
        } else if (req.url === "/page") {
          res.writeHead(200, { "Content-Type": "text/html" }).end("<html></html>");
        } else if (req.url === "/moved") {
          res.writeHead(302, { Location: "/a.png" }).end();
        } else {
          res.writeHead(404).end();
        }
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => new Promise<void>((r) => server.close(() => r())));

    const allow = { allowPrivateUrls: true, timeoutMs: 5000 };

    test("fetches each URL once, follows redirects and sniffs untyped bodies", async () => {
      const out = await resolveImages(
        [
          userWith({ type: "image", url: `${base}/a.png` }, { type: "image", url: `${base}/moved` }),
          { role: "tool", content: [{ type: "image", url: `${base}/a.png` }, { type: "image", url: `${base}/untyped` }] },
        ],
        allow
      );
      const images = out.flatMap((m) => m.content);
      assert.deepEqual(
        images.map((p) => p.type === "image" && [p.mimeType, p.data, p.url]),
        [
          ["image/png", PNG_B64, `${base}/a.png`],
          ["image/png", PNG_B64, `${base}/moved`],
          ["image/png", PNG_B64, `${base}/a.png`],
          ["image/png", PNG_B64, `${base}/untyped`],
        ]
      );
      assert.equal(hits.get("/a.png"), 2, "once directly, once via the redirect");
    });

    test("reports missing and non-image resources as invalid images", async () => {
      for (const path of ["/missing", "/page"]) {
        await assert.rejects(
          resolveImages([userWith({ type: "image", url: base + path })], allow),
          isInvalidImage,
          path
        );
      }
    });
  });
});
