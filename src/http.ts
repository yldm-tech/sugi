import { resolvePrincipal } from "./auth/core";
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

/** Content removed by an admin (takedown): 451 Unavailable For Legal Reasons, with a short bilingual page for browsers. */
export class RemovedError extends HttpError {
  constructor() {
    super(451, "removed after a report");
  }
}

const REMOVED_PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width, initial-scale=1"><title>451</title></head>
<body><p>这个内容因为被举报，已经被删除。</p><p lang="en">This content was removed after a report.</p></body></html>
`;

export function wantsJson(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("application/json");
}

export function errorResponse(request: Request, err: HttpError): Response {
  const headers = new Headers(err.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "no-store");
  if (err instanceof RemovedError) headers.set("x-robots-tag", "noindex");
  if (err instanceof RemovedError && !wantsJson(request) && (request.headers.get("accept") ?? "").includes("text/html")) {
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("content-security-policy", "default-src 'none'");
    return new Response(request.method === "HEAD" ? null : REMOVED_PAGE, { status: 451, headers });
  }
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

// The maintainers' own tokens (TRUSTED_TOKEN, and ADMIN_TOKEN, which can do everything TRUSTED_TOKEN can): never rate limited, never source-blocked, and accepted while the upload gate is on.
export async function isTrusted(request: Request, env: Env): Promise<boolean> {
  const given = bearerToken(request);
  if (given === null) return false;
  if (env.TRUSTED_TOKEN && (await constantTimeEqual(given, env.TRUSTED_TOKEN))) return true;
  return Boolean(env.ADMIN_TOKEN) && (await constantTimeEqual(given, env.ADMIN_TOKEN!));
}

/** True while an admin has blocked this source from uploading (see moderation.ts). */
export async function isSourceBlocked(env: Env, source: string, now = Date.now()): Promise<boolean> {
  const row = await env.DB.prepare("SELECT expires_at FROM blocked_sources WHERE source = ?").bind(source).first<{ expires_at: number | null }>();
  return row !== null && (row.expires_at === null || row.expires_at > now);
}

export interface Uploader {
  /** HMAC of the client IP; stored with every object and album for abuse tracing. */
  source: string;
  trusted: boolean;
  /** Account the upload is recorded under (API token or logged-in session), if any. */
  userId?: string;
}

// Shared gate for every route that stores user content: the UPLOAD_TOKEN gate (skipped for the trusted token), the IP_HASH_SECRET requirement and the per-source rate limit. `bucket` separates counters, e.g. uploads from album creation; `cost` is how many uploads the call accounts for.
export async function authorizeUpload(request: Request, env: Env, bucket = "upload", cost = 1): Promise<Uploader> {
  const trusted = await isTrusted(request, env);
  if (!trusted && env.UPLOAD_TOKEN) await requireBearer(request, env.UPLOAD_TOKEN, "upload");
  const principal = trusted ? null : await resolvePrincipal(request, env);
  // Without the secret there is no way to record a traceable source, so refuse rather than store untraceable uploads.
  if (!env.IP_HASH_SECRET) throw new HttpError(503, "uploads are not configured");
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const source = await hmacSha256Hex(env.IP_HASH_SECRET, ip);
  if (!trusted) {
    // Neutral wording: the client is not told why, nor that a block exists.
    if (await isSourceBlocked(env, source)) throw new HttpError(403, "uploads are not accepted from this network");
    const key = bucket === "upload" ? source : `${bucket}:${source}`;
    // `cost` > 1 reserves several uploads at once (one per upload link handed out).
    for (let i = 0; i < cost; i++) {
      const { success } = await env.UPLOAD_LIMITER.limit({ key });
      if (!success) throw new HttpError(429, "too many uploads, slow down", { "retry-after": String(RATE_LIMIT_PERIOD_SECONDS) });
    }
  }
  return { source, trusted, userId: principal?.user.id };
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
