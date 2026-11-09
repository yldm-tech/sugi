import { resolvePrincipal } from "./auth/core";
import { constantTimeEqual, hmacSha256Hex, sha256Hex } from "./crypto";
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

// Small bilingual pages for browsers that open a file link that does not work. A bare status with no body makes Chrome show its own "HTTP ERROR" page, which says nothing about why.
function filePage(status: number): string {
  const [zh, en] =
    status === 404
      ? ["这个文件不存在，可能已经过期或被删除了。", "This file does not exist; it may have expired or been deleted."]
      : status === 429
        ? ["请求太多了，稍等一下再试。", "Too many requests; please wait a moment and try again."]
        : status >= 500
          ? ["文件暂时打不开，过一会儿再试。", "The file cannot be opened right now; please try again in a moment."]
          : ["这个文件现在打不开。", "This file cannot be opened."];
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${status}</title></head>
<body><p>${zh}</p><p lang="en">${en}</p><p><small>${status}</small></p></body></html>
`;
}

/** `filesHost`: the request came to the files or tmp host, where a browser gets a small HTML page for every error. */
export function errorResponse(request: Request, err: HttpError, filesHost = false): Response {
  const headers = new Headers(err.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "no-store");
  if (err instanceof RemovedError) headers.set("x-robots-tag", "noindex");
  const html = !wantsJson(request) && (request.headers.get("accept") ?? "").includes("text/html");
  if ((err instanceof RemovedError || filesHost) && html) {
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("content-security-policy", "default-src 'none'");
    return new Response(request.method === "HEAD" ? null : err instanceof RemovedError ? REMOVED_PAGE : filePage(err.status), { status: err.status, headers });
  }
  if (wantsJson(request)) {
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(`${JSON.stringify({ error: err.message })}\n`, { status: err.status, headers });
  }
  headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(`${err.message}\n`, { status: err.status, headers });
}

export function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra },
  });
}

export function textResponse(text: string, status = 200): Response {
  return new Response(`${text}\n`, {
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

/** Who an admin token belongs to: "ADMIN_TOKEN" for the shared token, or the account and token prefix of a personal API token whose role is "admin" (set by hand in D1), so a maintainer can use their own token instead of the shared one. Null for any other token. */
export async function adminTokenLabel(env: Env, token: string): Promise<string | null> {
  if (env.ADMIN_TOKEN && (await constantTimeEqual(token, env.ADMIN_TOKEN))) return "ADMIN_TOKEN";
  if (!token.startsWith("sugi_") || env.FEATURE_ACCOUNTS !== "1" || !(env.ACCOUNT_FEATURES ?? "").split(",").some((f) => f.trim() === "tokens")) return null;
  const row = await env.DB.prepare(
    "SELECT t.role AS role, t.prefix AS prefix, u.email AS email FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?",
  )
    .bind(await sha256Hex(new TextEncoder().encode(token)))
    .first<{ role: string; prefix: string; email: string | null }>();
  return row?.role === "admin" ? `${row.email ?? "account"} (${row.prefix}…)` : null;
}

/** The request carries the shared ADMIN_TOKEN or a personal admin token (see adminTokenLabel). */
export async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const given = bearerToken(request);
  return given !== null && (await adminTokenLabel(env, given)) !== null;
}

/** Gate for the admin HTTP endpoints. */
export async function requireAdmin(request: Request, env: Env): Promise<void> {
  if (await isAdmin(request, env)) return;
  if (!env.ADMIN_TOKEN) throw new HttpError(403, "admin is disabled");
  throw new HttpError(401, "unauthorized", { "www-authenticate": 'Bearer realm="admin"' });
}

// The maintainers' own tokens (TRUSTED_TOKEN, and ADMIN_TOKEN, which can do everything TRUSTED_TOKEN can): never rate limited, never source-blocked, and accepted while the upload gate is on.
export async function isTrusted(request: Request, env: Env): Promise<boolean> {
  const given = bearerToken(request);
  if (given === null) return false;
  if (env.TRUSTED_TOKEN && (await constantTimeEqual(given, env.TRUSTED_TOKEN))) return true;
  return isAdmin(request, env);
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

/** Who may upload videos (VIDEO_UPLOADS): "anyone"; "account" (a logged-in session or API token, plus the trusted and admin tokens); "trusted" (only the trusted and admin tokens; what "account" means while accounts are off). Cloudflare's CSAM Scanning Tool checks images only, which is why videos are not anonymous by default. */
export type VideoPolicy = "anyone" | "account" | "trusted";

export function videoPolicy(env: Env): VideoPolicy {
  if ((env.VIDEO_UPLOADS ?? "").trim() === "anyone") return "anyone";
  return env.FEATURE_ACCOUNTS === "1" ? "account" : "trusted";
}

/** Refuses a video from an uploader the video policy does not cover; images always pass. */
export function assertMayUpload(env: Env, uploader: Uploader, kind: "image" | "video"): void {
  if (kind !== "video" || uploader.trusted) return;
  const policy = videoPolicy(env);
  if (policy === "anyone" || (policy === "account" && uploader.userId)) return;
  throw new HttpError(
    403,
    policy === "account"
      ? `video uploads need an account: log in at ${env.MAIN_ORIGIN}/login, or use an API token (sugi login TOKEN)`
      : "video uploads are limited to this site's maintainers",
  );
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
    // Accounts get their own, larger allowance (ACCOUNT_LIMITER), counted per account; everyone else is counted per source.
    const account = principal && env.ACCOUNT_LIMITER;
    const limiter = account ? env.ACCOUNT_LIMITER : env.UPLOAD_LIMITER;
    const who = account ? `user:${principal.user.id}` : source;
    const key = bucket === "upload" ? who : `${bucket}:${who}`;
    // `cost` > 1 reserves several uploads at once (one per upload link handed out).
    for (let i = 0; i < cost; i++) {
      const { success } = await limiter.limit({ key });
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
