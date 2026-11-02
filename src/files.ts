// Files of the current API: ids, R2 keys (f/<id> permanent, t/<id> temporary), metadata, public links, lookup, deletion and the expiry sweep. Storing lives in upload.ts and serving in serve.ts.
import { deletionResponse, purgeCache } from "./cache";
import { constantTimeEqual, sha256Hex } from "./crypto";
import { assertMayUpload, HttpError, isAdmin, jsonResponse, textResponse, type Uploader, wantsJson } from "./http";
import { assertFileNotRemoved, isTombstone, takedown } from "./moderation";
import { cuteId, deleteToken, isFileId, randomId } from "./ids";
import { accountsOn, forgetFiles, ownsFile, resolvePrincipal } from "./auth/core";
import { EXPIRIES, type ExpiryId, NAME_MAX, parseExpiry } from "./limits";
import { MEDIA_BY_EXT, type MediaType } from "./sniff";

const _MiB = 1024 * 1024;

export const IMAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
export const VIDEO_CSP = "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'";

export interface UploadOptions {
  expire: ExpiryId | null;
  style: "random" | "cute";
  name: string | null;
}

export interface StoredFile {
  id: string;
  key: string;
  temporary: boolean;
  type: MediaType;
  size: number;
  uploaded: number;
  expires: number | null;
  name: string | null;
}

export function fileKey(id: string, temporary: boolean): string {
  return `${temporary ? "t" : "f"}/${id}`;
}

export function publicUrl(env: Env, f: { id: string; temporary: boolean; type: MediaType }): string {
  return `${f.temporary ? env.TMP_ORIGIN : env.FILES_ORIGIN}/${f.id}.${f.type.ext}`;
}

export function pageUrl(env: Env, id: string): string {
  return `${env.MAIN_ORIGIN}/f/${id}`;
}

export function sanitizeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Strip control and bidi-override characters, collapse whitespace, keep only the last path segment.
  const cleaned = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .split(/[\\/]/)
    .pop()!
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, NAME_MAX).join("");
}

export function parseOptions(get: (key: string) => string | null): UploadOptions {
  const expire = parseExpiry(get("expire") ?? get("expires") ?? get("expiry"));
  if (expire === "invalid") throw new HttpError(400, 'invalid "expire": use 1h, 12h or 72h (omit for permanent)');
  const styleRaw = (get("style") ?? "random").toLowerCase();
  if (styleRaw !== "random" && styleRaw !== "cute") throw new HttpError(400, 'invalid "style": use random or cute');
  return { expire, style: styleRaw, name: sanitizeName(get("name")) };
}

export function describe(key: string, obj: R2Object): StoredFile | null {
  const m = obj.customMetadata ?? {};
  // Tombstone markers of taken-down files keep the extension (for cache purges) but are not files.
  if (m.tomb === "1") return null;
  const type = MEDIA_BY_EXT[m.ext ?? ""];
  if (!type) return null;
  return {
    id: key.slice(2),
    key,
    temporary: key.startsWith("t/"),
    type,
    size: obj.size,
    uploaded: Number(m.uploaded_ms ?? obj.uploaded.getTime()),
    expires: m.expires ? Number(m.expires) : null,
    name: m.name ?? null,
  };
}

/** Looks up a file by id in both namespaces; expired temporary files count as missing. */
export async function findFile(env: Env, id: string, now = Date.now()): Promise<{ file: StoredFile; obj: R2Object } | null> {
  if (!isFileId(id)) return null;
  for (const temporary of [false, true]) {
    const key = fileKey(id, temporary);
    const obj = await env.BUCKET.head(key);
    if (!obj) continue;
    const file = describe(key, obj);
    if (!file || (file.expires !== null && file.expires <= now)) return null;
    return { file, obj };
  }
  return null;
}

async function allocateId(env: Env, style: UploadOptions["style"]): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    // Cute ids live in a small space; after a few collisions fall back to a random id rather than spin.
    const id = style === "cute" && attempt < 5 ? cuteId() : randomId();
    const [a, b] = await Promise.all([env.BUCKET.head(fileKey(id, false)), env.BUCKET.head(fileKey(id, true))]);
    if (!a && !b) return id;
  }
  throw new HttpError(503, "could not allocate an id, try again");
}

export interface Prepared {
  id: string;
  key: string;
  type: MediaType;
  token: string;
  expires: number | null;
  r2: R2PutOptions;
}

// Everything decided before the bytes are stored: id, key, delete token, metadata. `fixedId` is an id reserved earlier (upload links); otherwise a free one is allocated.
export async function prepare(env: Env, uploader: Uploader, opts: UploadOptions, type: MediaType, fixedId?: string): Promise<Prepared> {
  assertMayUpload(env, uploader, type.kind);
  const id = fixedId ?? (await allocateId(env, opts.style));
  const temporary = opts.expire !== null;
  const now = Date.now();
  const expires = opts.expire ? now + EXPIRIES[opts.expire] * 1000 : null;
  const token = deleteToken();
  const customMetadata: Record<string, string> = {
    uploaded: new Date(now).toISOString(),
    uploaded_ms: String(now),
    source: uploader.source,
    ext: type.ext,
    del: await sha256Hex(new TextEncoder().encode(token)),
  };
  if (expires !== null) customMetadata.expires = String(expires);
  if (opts.name) customMetadata.name = opts.name;
  return { id, key: fileKey(id, temporary), type, token, expires, r2: { httpMetadata: { contentType: type.mime }, customMetadata } };
}

export interface UploadResult {
  id: string;
  url: string;
  page: string;
  size: number;
  type: string;
  name: string | null;
  expires_at: string | null;
  delete_token: string;
}

export function result(env: Env, p: Prepared, size: number, name: string | null): UploadResult {
  return {
    id: p.id,
    url: publicUrl(env, { id: p.id, temporary: p.expires !== null, type: p.type }),
    page: pageUrl(env, p.id),
    size,
    type: p.type.mime,
    name,
    expires_at: p.expires === null ? null : new Date(p.expires).toISOString(),
    delete_token: p.token,
  };
}

export function uploadResponse(request: Request, r: UploadResult): Response {
  if (wantsJson(request)) return jsonResponse(r, 201);
  return textResponse(r.url, 201);
}

export function publicInfo(env: Env, f: StoredFile) {
  return {
    id: f.id,
    url: publicUrl(env, f),
    page: pageUrl(env, f.id),
    name: f.name,
    size: f.size,
    type: f.type.mime,
    created_at: new Date(f.uploaded).toISOString(),
    expires_at: f.expires === null ? null : new Date(f.expires).toISOString(),
  };
}

// GET /api/files/:id
export async function handleFileInfo(env: Env, id: string): Promise<Response> {
  const found = await findFile(env, id);
  if (!found) {
    await assertFileNotRemoved(env, id);
    throw new HttpError(404, "not found");
  }
  return jsonResponse(publicInfo(env, found.file));
}

export type DeleteAuth = { token: string } | { userId: string } | "admin";

export async function tokenMatches(obj: R2Object, token: string): Promise<boolean> {
  const expected = obj.customMetadata?.del ?? "";
  return Boolean(expected) && (await constantTimeEqual(await sha256Hex(new TextEncoder().encode(token)), expected));
}

/** Deletes a current-API file after checking its delete token or account ownership. Returns null when the file does not exist. */
export async function deleteFile(env: Env, id: string, auth: DeleteAuth): Promise<{ key: string; cachePurged: boolean } | null> {
  if (!isFileId(id)) return null;
  for (const temporary of [false, true]) {
    const key = fileKey(id, temporary);
    const obj = await env.BUCKET.head(key);
    if (!obj || isTombstone(obj)) continue;
    if (auth !== "admin") {
      const ok = "token" in auth ? await tokenMatches(obj, auth.token) : await ownsFile(env, auth.userId, key);
      if (!ok) throw new HttpError(403, "token" in auth ? "wrong delete token" : "this file does not belong to your account");
    }
    await env.BUCKET.delete(key);
    if (accountsOn(env)) await forgetFiles(env, [key]);
    return { key, cachePurged: await purgeCache(env, [key]) };
  }
  return null;
}

// DELETE /api/files/:id with `Sugi-Token: <delete_token>` (or the admin bearer token).
export async function handleFileDelete(request: Request, env: Env, id: string): Promise<Response> {
  if (!isFileId(id)) throw new HttpError(404, "not found");
  const admin = await isAdmin(request, env);
  const token = request.headers.get("sugi-token");
  // An admin deletion is a takedown, exactly like the MCP tool: tombstone (451, id never reused), audit log, cache purge.
  if (admin) {
    const url = new URL(request.url);
    const r = await takedown(env, id, {
      reason: url.searchParams.get("reason") ?? "admin DELETE /api/files",
      blockContent: url.searchParams.get("block_content") === "1",
      via: "http",
    });
    return deletionResponse(r.removed.length ? [id] : [], r.cache_purged, r.already_removed.length ? { already_removed: [id] } : {});
  }
  let auth: DeleteAuth;
  if (token) auth = { token };
  else {
    const principal = await resolvePrincipal(request, env);
    if (!principal) throw new HttpError(401, "missing Sugi-Token header (the delete_token returned by the upload)");
    auth = { userId: principal.user.id };
  }
  const done = await deleteFile(env, id, auth);
  if (done) return deletionResponse([id], done.cachePurged);
  // Already gone; purge anyway so a retry after a failed purge completes.
  if (!(await purgeCache(env, [fileKey(id, false), fileKey(id, true)]))) return deletionResponse([], false);
  throw new HttpError(404, "not found");
}

// Cron: delete temporary files whose time is up and drop them from the zone cache.
export async function sweepExpired(env: Env, now = Date.now()): Promise<{ deleted: string[]; cachePurged: boolean }> {
  const expired: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: "t/", include: ["customMetadata"], limit: 1000, cursor });
    for (const obj of page.objects) {
      const exp = Number(obj.customMetadata?.expires ?? "0");
      if (exp && exp <= now) expired.push(obj.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < expired.length; i += 1000) await env.BUCKET.delete(expired.slice(i, i + 1000));
  if (accountsOn(env)) await forgetFiles(env, expired);
  return { deleted: expired, cachePurged: await purgeCache(env, expired) };
}
