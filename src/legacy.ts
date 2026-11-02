// The original content-addressed API, kept unchanged because its links are embedded in pull requests and bin/sugi-upload and other scripts post to /upload: images only, at most 20 MB, key = first 16 hex of SHA-256 + extension, served from the main origin at /<key>.
import { accountsOn, forgetFiles } from "./auth/core";
import { deletionResponse, fetchViaCache, purgeCache } from "./cache";
import { sha256Hex } from "./crypto";
import { authorizeUpload, etagMatches, hasBody, HttpError, jsonResponse, RemovedError, requireBearer, textResponse, wantsJson } from "./http";
import { assertHashAllowed, isTombstone, takedown, takedownBySource } from "./moderation";
import { LEGACY_MAX_BYTES } from "./limits";
import { sniffImageType, TYPES_BY_EXT } from "./sniff";

// Room for multipart boundaries and part headers on top of the file itself.
const MULTIPART_OVERHEAD = 64 * 1024;

export const LEGACY_KEY_RE = /^[0-9a-f]{16}\.(png|jpg|webp|gif)$/;
const SOURCE_RE = /^[0-9a-f]{64}$/;

export const IMAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";

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
  return new HttpError(413, `file too large (max ${LEGACY_MAX_BYTES / 1024 / 1024} MB)`);
}

async function extractUpload(request: Request): Promise<Uint8Array> {
  const contentType = request.headers.get("content-type") ?? "";
  if (request.method === "POST" && /^multipart\/form-data/i.test(contentType)) {
    const raw = await readBodyCapped(request, LEGACY_MAX_BYTES + MULTIPART_OVERHEAD);
    let form: FormData;
    try {
      form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
    } catch {
      throw new HttpError(400, "malformed multipart body");
    }
    const file = form.get("file");
    if (file === null || typeof file === "string") throw new HttpError(400, 'missing multipart field "file"');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > LEGACY_MAX_BYTES) throw tooLarge();
    return bytes;
  }
  return readBodyCapped(request, LEGACY_MAX_BYTES);
}

export async function handleLegacyUpload(request: Request, env: Env): Promise<Response> {
  const { source } = await authorizeUpload(request, env);

  const bytes = await extractUpload(request);
  if (bytes.byteLength === 0) throw new HttpError(400, "empty upload");
  const type = sniffImageType(bytes);
  if (type === null) throw new HttpError(415, "unsupported file type (only PNG, JPEG, WebP and GIF)");

  const sha256 = await sha256Hex(bytes);
  await assertHashAllowed(env, sha256);
  const key = `${sha256.slice(0, 16)}.${type.ext}`;
  const url = `${new URL(request.url).origin}/${key}`;

  let created = false;
  const existing = await env.BUCKET.head(key);
  if (isTombstone(existing)) throw new RemovedError();
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
  return textResponse(url, status);
}

export async function handleLegacyServe(request: Request, env: Env, key: string): Promise<Response> {
  const viaCache = Boolean(env.CACHE_ORIGIN) && request.method === "GET";
  const obj = request.method === "HEAD" || viaCache ? await env.BUCKET.head(key) : await env.BUCKET.get(key);
  if (obj === null) throw new HttpError(404, "not found");
  if (isTombstone(obj)) {
    if (hasBody(obj)) await obj.body.cancel();
    throw new RemovedError();
  }

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
    const upstream = await fetchViaCache(env, key, { ttl: 31536000 });
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

// Admin deletion of a legacy object is a takedown: tombstone (451 from now on), audit log, cache purge.
export async function handleLegacyDelete(request: Request, env: Env, key: string): Promise<Response> {
  await requireBearer(request, env.ADMIN_TOKEN, "admin");
  const existing = await env.BUCKET.head(key);
  if (existing === null) {
    // Purge anyway so that retrying a DELETE whose purge failed finishes the job.
    if (!(await purgeCache(env, [key]))) return deletionResponse([], false);
    throw new HttpError(404, "not found");
  }
  const url = new URL(request.url);
  const r = await takedown(env, key, { reason: url.searchParams.get("reason") ?? "admin DELETE (legacy)", blockContent: url.searchParams.get("block_content") === "1", via: "http" });
  return deletionResponse(r.removed, r.cache_purged, r.already_removed.length ? { already_removed: r.already_removed } : {});
}

// Admin view of any stored object: legacy keys ("<hex>.<ext>") and current ones ("f/<id>", "t/<id>").
export async function handleInfo(request: Request, env: Env, key: string): Promise<Response> {
  await requireBearer(request, env.ADMIN_TOKEN, "admin");
  const obj = await env.BUCKET.head(key);
  if (obj === null) throw new HttpError(404, "not found");
  const m = obj.customMetadata ?? {};
  return jsonResponse({
    key,
    size: obj.size,
    type: obj.httpMetadata?.contentType ?? null,
    uploaded: m.uploaded ?? obj.uploaded.toISOString(),
    source: m.source ?? null,
    sha256: m.sha256 ?? null,
    expires: m.expires ? new Date(Number(m.expires)).toISOString() : null,
    name: m.name ?? null,
  });
}

// Deletes every object (legacy and current) and every album recorded with a given source HMAC.
export async function handlePurgeBySource(request: Request, env: Env): Promise<Response> {
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
  // Same as the takedown_by_source admin tool: tombstones, audit log and cache purge.
  const r = await takedownBySource(env, source, { dryRun, reason: typeof (body as { reason?: unknown }).reason === "string" ? (body as { reason: string }).reason : "admin purge-by-source", via: "http" });
  const keys = r.keys as string[];
  if (dryRun) return jsonResponse({ source, dry_run: true, count: keys.length, matched: keys, albums: r.album_ids });
  return deletionResponse(keys, r.cache_purged as boolean, { source, dry_run: false, count: keys.length, albums: r.album_ids });
}
