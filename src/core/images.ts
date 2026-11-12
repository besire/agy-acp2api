import dns from "node:dns/promises";
import net from "node:net";
import { ChatMessage, ContentPart, GatewayError, ImagePart } from "./chat.js";

/**
 * Turns every image the agent will see into inline base64 with a known MIME type:
 * `data:` images are validated, URL images are downloaded. Problems are the client's (400).
 */

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export interface ImageResolveOptions {
  /** Allow URLs that resolve to loopback / private / link-local addresses. */
  allowPrivateUrls?: boolean;
  timeoutMs?: number;
}

const defaultOptions = (): ImageResolveOptions => ({
  allowPrivateUrls: /^(1|true|yes)$/i.test(process.env.AGY2API_ALLOW_PRIVATE_IMAGE_URLS || ""),
  timeoutMs: FETCH_TIMEOUT_MS,
});

function invalidImage(message: string): GatewayError {
  return new GatewayError(message, 400, "invalid_request_error", "invalid_image");
}

// ---------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------

const blocked = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  blocked.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(prefix, bits, "ipv6");
}

/** Loopback, private, link-local, CGNAT, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPrivateAddress(mapped[1]);
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) return blocked.check(ip, "ipv6");
  return true;
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host)
    ? [host]
    : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) {
    throw invalidImage(`Could not resolve image host '${host}'`);
  }
  if (addresses.some(isPrivateAddress)) {
    throw invalidImage(
      `Image URL host '${host}' resolves to a private address; set AGY2API_ALLOW_PRIVATE_IMAGE_URLS=1 to allow it`
    );
  }
}

// ---------------------------------------------------------------------------
// Format checks
// ---------------------------------------------------------------------------

/** Recognises PNG, JPEG, GIF and WebP from their first bytes. */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  const at = (i: number, ...sig: number[]) => sig.every((b, j) => bytes[i + j] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return undefined;
}

function pickMimeType(declared: string | undefined, head: Uint8Array): string {
  const type = declared?.split(";")[0].trim().toLowerCase();
  if (type?.startsWith("image/")) return type;
  const sniffed = sniffImageType(head);
  if (sniffed) return sniffed;
  throw invalidImage("Could not determine the image type (expected PNG, JPEG, GIF or WebP)");
}

function checkInline(image: ImagePart): ImagePart {
  const data = (image.data ?? "").replace(/\s+/g, "");
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw invalidImage("Image data is not valid base64");
  }
  if (Math.floor((data.length * 3) / 4) > MAX_IMAGE_BYTES) {
    throw invalidImage(`Image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  }
  const head = Buffer.from(data.slice(0, 64), "base64");
  return { ...image, data, mimeType: pickMimeType(image.mimeType, head) };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function readCapped(res: Response): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_IMAGE_BYTES) {
    throw invalidImage(`Image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      throw invalidImage(`Image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function downloadImage(url: string, opts: ImageResolveOptions): Promise<ImagePart> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw invalidImage(`Invalid image URL '${url}'`);
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw invalidImage(`Unsupported image URL scheme '${current.protocol}'`);
    }
    if (!opts.allowPrivateUrls) await assertPublicHost(current.hostname);

    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS),
      });
    } catch (err: any) {
      throw invalidImage(`Failed to download image from '${url}': ${err?.message || String(err)}`);
    }

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      // Each hop is checked again so a redirect cannot reach a private address
      current = new URL(location, current);
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw invalidImage(`Failed to download image from '${url}' (HTTP ${res.status})`);
    }

    const bytes = await readCapped(res);
    return {
      type: "image",
      url,
      mimeType: pickMimeType(res.headers.get("content-type") ?? undefined, bytes.subarray(0, 16)),
      data: bytes.toString("base64"),
    };
  }
  throw invalidImage(`Too many redirects while downloading image from '${url}'`);
}

/**
 * Returns copies of `messages` whose images are all inline and validated. The originals are
 * left alone: their URLs are what the session hash was computed from. Each distinct URL is
 * fetched once.
 */
export async function resolveImages(
  messages: ChatMessage[],
  opts: ImageResolveOptions = defaultOptions()
): Promise<ChatMessage[]> {
  const downloads = new Map<string, Promise<ImagePart>>();
  // Async on purpose: a synchronous throw would orphan downloads already started for
  // sibling parts, and their later rejection would go unhandled
  const resolvePart = async (part: ContentPart): Promise<ContentPart> => {
    if (part.type !== "image") return part;
    if (part.data) return checkInline(part);
    if (!part.url) throw invalidImage("Image has neither data nor a URL");
    let pending = downloads.get(part.url);
    if (!pending) {
      pending = downloadImage(part.url, opts);
      downloads.set(part.url, pending);
    }
    return pending;
  };

  return Promise.all(
    messages.map(async (msg) => {
      // The agent never sees system or assistant images, so they are not fetched
      if (msg.role === "system" || msg.role === "assistant") return msg;
      if (!msg.content.some((p) => p.type === "image")) return msg;
      const content = await Promise.all(msg.content.map(resolvePart));
      return { ...msg, content };
    })
  );
}
