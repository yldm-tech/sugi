import { constantTimeEqual, hmacSha256Hex } from "./crypto";
import { RATE_LIMIT_PERIOD_SECONDS } from "./limits";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function wantsJson(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("application/json");
}

export function errorResponse(request: Request, err: HttpError): Response {
  const headers = new Headers(err.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "no-store");
  if (wantsJson(request)) {
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify({ error: err.message }) + "\n", { status: err.status, headers });
  }
  headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(err.message + "\n", { status: err.status, headers });
}

export function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra },
  });
}

export function textResponse(text: string, status = 200): Response {
  return new Response(text + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export function methodNotAllowed(allow: string): HttpError {
  return new HttpError(405, "method not allowed", { allow });
}

export function bearerToken(request: Request): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

export async function requireBearer(request: Request, expected: string | undefined, realm: string): Promise<void> {
  if (!expected) throw new HttpError(403, `${realm} is disabled`);
  const given = bearerToken(request);
  if (given === null || !(await constantTimeEqual(given, expected))) {
    throw new HttpError(401, "unauthorized", { "www-authenticate": `Bearer realm="${realm}"` });
  }
}

export async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const given = bearerToken(request);
  return Boolean(env.ADMIN_TOKEN) && given !== null && (await constantTimeEqual(given, env.ADMIN_TOKEN!));
}

// The maintainers' own token: never rate limited and accepted while the upload gate is on.
export async function isTrusted(request: Request, env: Env): Promise<boolean> {
  if (!env.TRUSTED_TOKEN) return false;
  const given = bearerToken(request);
  return given !== null && (await constantTimeEqual(given, env.TRUSTED_TOKEN));
}

export interface Uploader {
  /** HMAC of the client IP; stored with every object and album for abuse tracing. */
  source: string;
  trusted: boolean;
}

// Shared gate for every route that stores user content: the UPLOAD_TOKEN gate (skipped for the trusted token), the IP_HASH_SECRET requirement and the per-source rate limit. `bucket` separates counters, e.g. uploads from album creation.
export async function authorizeUpload(request: Request, env: Env, bucket = "upload"): Promise<Uploader> {
  const trusted = await isTrusted(request, env);
  if (!trusted && env.UPLOAD_TOKEN) await requireBearer(request, env.UPLOAD_TOKEN, "upload");
  // Without the secret there is no way to record a traceable source, so refuse rather than store untraceable uploads.
  if (!env.IP_HASH_SECRET) throw new HttpError(503, "uploads are not configured");
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const source = await hmacSha256Hex(env.IP_HASH_SECRET, ip);
  if (!trusted) {
    const key = bucket === "upload" ? source : `${bucket}:${source}`;
    const { success } = await env.UPLOAD_LIMITER.limit({ key });
    if (!success) throw new HttpError(429, "too many uploads, slow down", { "retry-after": String(RATE_LIMIT_PERIOD_SECONDS) });
  }
  return { source, trusted };
}

export function hasBody(obj: R2Object): obj is R2ObjectBody {
  return "body" in obj;
}

export function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(",").some((t) => {
    const v = t.trim().replace(/^W\//, "");
    return v === "*" || v === etag;
  });
}

export function randomNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}
