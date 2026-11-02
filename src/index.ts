import { constantTimeEqual, hmacSha256Hex, sha256Hex } from "./crypto";
import { pageCsp, pickLang, renderIndex } from "./page";
import { sniffImageType, TYPES_BY_EXT } from "./sniff";

export const MAX_BYTES = 20 * 1024 * 1024;
// Room for multipart boundaries and part headers on top of the file itself.
const MULTIPART_OVERHEAD = 64 * 1024;
// Keep in sync with the `ratelimits` entry in wrangler.jsonc; the binding does not expose its own configuration.
const RATE_LIMIT = 10;
const RATE_LIMIT_PERIOD_SECONDS = 60;

const KEY_RE = /^[0-9a-f]{16}\.(png|jpg|webp|gif)$/;
const SOURCE_RE = /^[0-9a-f]{64}$/;

const IMAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function wantsJson(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("application/json");
}

function errorResponse(request: Request, err: HttpError): Response {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function bearerToken(request: Request): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

async function requireBearer(request: Request, expected: string | undefined, realm: string): Promise<void> {
  if (!expected) throw new HttpError(403, `${realm} is disabled`);
  const given = bearerToken(request);
  if (given === null || !(await constantTimeEqual(given, expected))) {
    throw new HttpError(401, "unauthorized", { "www-authenticate": `Bearer realm="${realm}"` });
  }
}

function methodNotAllowed(allow: string): HttpError {
  return new HttpError(405, "method not allowed", { allow });
}

// Reads the request body into memory but gives up as soon as it grows past `cap`, so an oversized or lying upload never gets fully buffered.
async function readBodyCapped(request: Request, cap: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > cap) throw tooLarge();
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function tooLarge(): HttpError {
  return new HttpError(413, `file too large (max ${MAX_BYTES / 1024 / 1024} MB)`);
}

async function extractUpload(request: Request): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type") ?? "";
  if (request.method === "POST" && /^multipart\/form-data/i.test(contentType)) {
    const raw = await readBodyCapped(request, MAX_BYTES + MULTIPART_OVERHEAD);
    let form: FormData;
    try {
      form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
    } catch {
      throw new HttpError(400, "malformed multipart body");
    }
    const file = form.get("file");
    if (file === null || typeof file === "string") throw new HttpError(400, 'missing multipart field "file"');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) throw tooLarge();
    return bytes;
  }
  return readBodyCapped(request, MAX_BYTES);
}

// The maintainers' own token: never rate limited and accepted while the upload gate is on.
async function isTrusted(request: Request, env: Env): Promise<boolean> {
  if (!env.TRUSTED_TOKEN) return false;
  const given = bearerToken(request);
  return given !== null && (await constantTimeEqual(given, env.TRUSTED_TOKEN));
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const trusted = await isTrusted(request, env);
  if (!trusted && env.UPLOAD_TOKEN) await requireBearer(request, env.UPLOAD_TOKEN, "upload");
  // Without the secret there is no way to record a traceable source, so refuse rather than store untraceable uploads.
  if (!env.IP_HASH_SECRET) throw new HttpError(503, "uploads are not configured");

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const source = await hmacSha256Hex(env.IP_HASH_SECRET, ip);

  const { success } = trusted ? { success: true } : await env.UPLOAD_LIMITER.limit({ key: source });
  if (!success) throw new HttpError(429, "too many uploads, slow down", { "retry-after": String(RATE_LIMIT_PERIOD_SECONDS) });

  const bytes = await extractUpload(request);
  if (bytes.byteLength === 0) throw new HttpError(400, "empty upload");
  const type = sniffImageType(bytes);
  if (type === null) throw new HttpError(415, "unsupported file type (only PNG, JPEG, WebP and GIF)");

  const sha256 = await sha256Hex(bytes);
  const key = `${sha256.slice(0, 16)}.${type.ext}`;
  const url = `${new URL(request.url).origin}/${key}`;

  let created = false;
  const existing = await env.BUCKET.head(key);
  if (existing === null) {
    // The conditional put closes the race between head() and put(): if another request stored the key in between, R2 returns null instead of overwriting.
    const stored = await env.BUCKET.put(key, bytes, {
      httpMetadata: { contentType: type.mime },
      customMetadata: { uploaded: new Date().toISOString(), source, sha256 },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    created = stored !== null;
  } else if (existing.customMetadata?.sha256 && existing.customMetadata.sha256 !== sha256) {
    // A 64-bit prefix collision with different content; never overwrite, never pretend the old URL serves this file.
    throw new HttpError(409, "key collision with different content");
  }

  const status = created ? 201 : 200;
  if (wantsJson(request)) {
    return jsonResponse({ url, key, size: bytes.byteLength, type: type.mime, deduplicated: !created }, status);
  }
  return new Response(url + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function hasBody(obj: R2Object): obj is R2ObjectBody {
  return "body" in obj;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(",").some((t) => {
    const v = t.trim().replace(/^W\//, "");
    return v === "*" || v === etag;
  });
}

// Fetches the image through the zone's CDN cache by way of the bucket's R2 custom domain, so that Cloudflare's cache-based features (the CSAM Scanning Tool in particular) see every image that is served. The bucket is still the source of truth: handleServe has already confirmed the object exists, so a deleted object stops being served even before its cached copy is purged.
async function fetchViaCache(env: Env, key: string): Promise<Response> {
  return fetch(`${env.CACHE_ORIGIN}/${key}`, {
    cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 31536000, "404": 1, "500-599": 0 } },
  });
}

async function handleServe(request: Request, env: Env, key: string): Promise<Response> {
  const viaCache = Boolean(env.CACHE_ORIGIN) && request.method === "GET";
  const obj = request.method === "HEAD" || viaCache ? await env.BUCKET.head(key) : await env.BUCKET.get(key);
  if (obj === null) throw new HttpError(404, "not found");

  const ext = key.slice(key.lastIndexOf(".") + 1);
  const stored = obj.httpMetadata?.contentType;
  const allowed = Object.values(TYPES_BY_EXT).map((t) => t.mime as string);
  const contentType = stored && allowed.includes(stored) ? stored : TYPES_BY_EXT[ext].mime;

  const headers = new Headers({
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "content-disposition": `inline; filename="${key}"`,
    "content-security-policy": IMAGE_CSP,
    "cache-control": "public, max-age=31536000, immutable",
    etag: obj.httpEtag,
    "last-modified": obj.uploaded.toUTCString(),
  });

  if (etagMatches(request.headers.get("if-none-match"), obj.httpEtag)) {
    if (hasBody(obj)) await obj.body.cancel();
    return new Response(null, { status: 304, headers });
  }
  headers.set("content-length", String(obj.size));

  if (viaCache) {
    const upstream = await fetchViaCache(env, key);
    if (!upstream.ok) {
      // Passes through blocks such as a CSAM match (451) instead of falling back to the bucket, which would defeat the block.
      await upstream.body?.cancel();
      throw new HttpError(upstream.status === 404 ? 404 : upstream.status >= 500 ? 502 : upstream.status, upstream.status === 404 ? "not found" : "unavailable");
    }
    return new Response(upstream.body, { status: 200, headers });
  }
  if (!hasBody(obj)) return new Response(null, { status: 200, headers });
  return new Response(obj.body, { status: 200, headers });
}

// Free plans accept at most 30 URLs per purge request.
const PURGE_BATCH = 30;

// Removes deleted objects' copies from the zone cache. Returns false if cache-through serving is on but the purge could not be done, so the caller can report that the cached copies may still be reachable at the origin hostname.
async function purgeCache(env: Env, keys: string[]): Promise<boolean> {
  if (!env.CACHE_ORIGIN || keys.length === 0) return true;
  if (!env.ZONE_ID || !env.CF_PURGE_TOKEN) return false;
  let ok = true;
  for (let i = 0; i < keys.length; i += PURGE_BATCH) {
    const files = keys.slice(i, i + PURGE_BATCH).map((k) => `${env.CACHE_ORIGIN}/${k}`);
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.ZONE_ID}/purge_cache`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.CF_PURGE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ files }),
    });
    const body = await res.json<{ success?: boolean }>().catch(() => ({ success: false }));
    ok = ok && res.ok && body.success === true;
  }
  return ok;
}

function deletionResponse(deleted: string[], cachePurged: boolean, extra: Record<string, unknown> = {}): Response {
  // 502 tells the operator to retry: the objects are gone from the bucket, but cached copies may still be served by the origin hostname.
  return jsonResponse({ ...extra, deleted, cache_purged: cachePurged }, cachePurged ? 200 : 502);
}

async function handleDelete(request: Request, env: Env, key: string): Promise<Response> {
  await requireBearer(request, env.ADMIN_TOKEN, "admin");
  const existing = await env.BUCKET.head(key);
  if (existing === null) {
    // Purge anyway so that retrying a DELETE whose purge failed finishes the job.
    if (!(await purgeCache(env, [key]))) return deletionResponse([], false);
    throw new HttpError(404, "not found");
  }
  await env.BUCKET.delete(key);
  return deletionResponse([key], await purgeCache(env, [key]));
}

async function handleInfo(request: Request, env: Env, key: string): Promise<Response> {
  await requireBearer(request, env.ADMIN_TOKEN, "admin");
  const obj = await env.BUCKET.head(key);
  if (obj === null) throw new HttpError(404, "not found");
  return jsonResponse({
    key,
    size: obj.size,
    type: obj.httpMetadata?.contentType ?? null,
    uploaded: obj.customMetadata?.uploaded ?? obj.uploaded.toISOString(),
    source: obj.customMetadata?.source ?? null,
    sha256: obj.customMetadata?.sha256 ?? null,
  });
}

async function handlePurgeBySource(request: Request, env: Env): Promise<Response> {
  await requireBearer(request, env.ADMIN_TOKEN, "admin");
  let body: { source?: unknown; dry_run?: unknown };
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, 'expected JSON body {"source": "<64 hex chars>"}');
  }
  const source = typeof body.source === "string" ? body.source.toLowerCase() : "";
  if (!SOURCE_RE.test(source)) throw new HttpError(400, '"source" must be a 64-character hex HMAC');
  const dryRun = body.dry_run === true;

  const matched: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ include: ["customMetadata"], limit: 1000, cursor });
    for (const obj of page.objects) {
      if (obj.customMetadata?.source === source) matched.push(obj.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  if (dryRun) return jsonResponse({ source, dry_run: true, count: matched.length, matched });
  for (let i = 0; i < matched.length; i += 1000) await env.BUCKET.delete(matched.slice(i, i + 1000));
  return deletionResponse(matched, await purgeCache(env, matched), { source, dry_run: false, count: matched.length });
}

function handleIndex(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const lang = pickLang(url.searchParams.get("lang"), request.headers.get("accept-language"));
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...nonceBytes));
  const html = renderIndex({
    origin: url.origin,
    lang,
    maxMiB: MAX_BYTES / 1024 / 1024,
    rateLimit: RATE_LIMIT,
    ratePeriodSeconds: RATE_LIMIT_PERIOD_SECONDS,
    gated: Boolean(env.UPLOAD_TOKEN),
    nonce,
  });
  return new Response(request.method === "HEAD" ? null : html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-language": lang === "zh" ? "zh-CN" : "en",
      "content-security-policy": pageCsp(nonce),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      // Each response carries a fresh CSP nonce, so shared caches must not reuse it across visitors.
      "cache-control": "private, no-cache",
      vary: "Accept-Language",
    },
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (pathname === "/") {
    if (method === "GET" || method === "HEAD") return handleIndex(request, env);
    throw methodNotAllowed("GET, HEAD");
  }
  if (pathname === "/upload") {
    if (method === "POST" || method === "PUT") return handleUpload(request, env);
    throw methodNotAllowed("POST, PUT");
  }
  if (pathname === "/admin/purge-by-source") {
    if (method === "POST") return handlePurgeBySource(request, env);
    throw methodNotAllowed("POST");
  }
  if (pathname.startsWith("/admin/info/")) {
    const key = pathname.slice("/admin/info/".length);
    if (!KEY_RE.test(key)) throw new HttpError(404, "not found");
    if (method === "GET") return handleInfo(request, env, key);
    throw methodNotAllowed("GET");
  }
  const key = pathname.slice(1);
  if (KEY_RE.test(key)) {
    if (method === "GET" || method === "HEAD") return handleServe(request, env, key);
    if (method === "DELETE") return handleDelete(request, env, key);
    throw methodNotAllowed("GET, HEAD, DELETE");
  }
  throw new HttpError(404, "not found");
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(request, err);
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
