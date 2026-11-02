import { env } from "cloudflare:test";
import worker from "../src/index";

export const MAIN = "https://sugi.test";
export const FILES = "https://files.sugi.moe";
export const TMP = "https://tmp.sugi.moe";
export const TRUSTED = { authorization: "Bearer test-trusted-token" };
export const UPLOAD_AUTH = { authorization: "Bearer test-upload-token" };
export const ADMIN = { authorization: "Bearer test-admin-token" };

let ip = 0;
// Each test gets its own client address so the per-source rate limiter never couples tests together.
export function freshIp(): string {
  ip += 1;
  return `198.51.${Math.floor(ip / 250)}.${ip % 250}`;
}

// Real clients (browsers, curl) send Content-Length; workerd's Request constructor does not add it to the headers, so tests add it here for buffered bodies. Mark a request with x-test-raw to send it untouched (e.g. a stream without a length).
export async function call(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  let req = request;
  if (req.headers.has("x-test-raw")) {
    const headers = new Headers(req.headers);
    headers.delete("x-test-raw");
    req = new Request(req, { headers });
  } else if (req.body && !req.headers.has("content-length")) {
    const body = await req.arrayBuffer();
    const headers = new Headers(req.headers);
    headers.set("content-length", String(body.byteLength));
    req = new Request(req.url, { method: req.method, headers, body });
  }
  return worker.fetch(req as Parameters<typeof worker.fetch>[0], { ...env, ...overrides } as Env) as Promise<Response>;
}

function withPayload(prefix: number[], size: number): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, prefix.length + 8));
  bytes.set(prefix);
  // Random tail so every call produces distinct content.
  crypto.getRandomValues(bytes.subarray(prefix.length, Math.min(bytes.length, prefix.length + 64)));
  return bytes;
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

export const png = (size = 128) => withPayload([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], size);
export const jpeg = (size = 128) => withPayload([0xff, 0xd8, 0xff, 0xe0], size);
export const mp4 = (size = 256) => withPayload([0, 0, 0, 0x18, ...ascii("ftypisom"), 0, 0, 2, 0, ...ascii("isomiso2")], size);
export const webm = (size = 256) => withPayload([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0x82, 0x84, ...ascii("webm")], size);
export const avif = (size = 256) => withPayload([0, 0, 0, 0x1c, ...ascii("ftypavif"), 0, 0, 0, 0, ...ascii("avifmif1miaf")], size);

export function put(path: string, body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(`${MAIN}${path}`, { method: "PUT", body, headers: { "cf-connecting-ip": freshIp(), ...TRUSTED, ...headers } });
}

export interface Uploaded {
  id: string;
  url: string;
  page: string;
  size: number;
  type: string;
  name: string | null;
  expires_at: string | null;
  delete_token: string;
}

export async function upload(body: Uint8Array = png(), query = "", headers: Record<string, string> = {}): Promise<Uploaded> {
  const res = await call(put(`/api/upload${query}`, body, { accept: "application/json", ...headers }));
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  return res.json<Uploaded>();
}

export async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}
