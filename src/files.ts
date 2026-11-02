// Current upload API: short ids, permanent (f/<id>) or temporary (t/<id>) objects, per-upload delete tokens, served from FILES_ORIGIN / TMP_ORIGIN.
import { parseMultipartRequest, MultipartParseError, MaxFileSizeExceededError, MaxTotalSizeExceededError, MaxPartsExceededError } from "@remix-run/multipart-parser";
import { deletionResponse, fetchViaCache, purgeCache } from "./cache";
import { constantTimeEqual, sha256Hex, toHex } from "./crypto";
import { authorizeUpload, etagMatches, hasBody, HttpError, isAdmin, jsonResponse, RemovedError, textResponse, Uploader, wantsJson } from "./http";
import { assertFileNotRemoved, assertHashAllowed, isTombstone, takedown } from "./moderation";
import { cuteId, deleteToken, isFileId, randomId } from "./ids";
import { EXPIRIES, ExpiryId, IMPORT_MAX_REDIRECTS, IMPORT_TIMEOUT_MS, IMPORT_UNKNOWN_LENGTH_MAX_BYTES, MAX_FILE_BYTES, NAME_MAX, parseExpiry, SINGLE_REQUEST_MAX_BYTES } from "./limits";
import { MEDIA_BY_EXT, MediaType, SNIFF_BYTES, sniffMedia } from "./sniff";

const MiB = 1024 * 1024;

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

/** Reads up to `n` bytes from the front of a stream and returns them together with a stream that still yields everything. */
export async function peekStream(stream: ReadableStream<Uint8Array>, n: number): Promise<{ head: Uint8Array; stream: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  while (total < n) {
    const r = await reader.read();
    if (r.done) {
      done = true;
      break;
    }
    chunks.push(r.value);
    total += r.value.byteLength;
  }
  const head = new Uint8Array(Math.min(total, n));
  let off = 0;
  for (const c of chunks) {
    if (off >= head.length) break;
    const take = Math.min(c.byteLength, head.length - off);
    head.set(c.subarray(0, take), off);
    off += take;
  }
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      if (done) controller.close();
    },
    async pull(controller) {
      const r = await reader.read();
      if (r.done) controller.close();
      else controller.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { head, stream: rest };
}

export function unsupportedType(): HttpError {
  return new HttpError(415, "unsupported file type (only PNG, JPEG, WebP, GIF, AVIF, MP4 and WebM)");
}

function linkUsed(): HttpError {
  return new HttpError(409, "this upload link has already been used; ask for a new one");
}

// A reserved id (upload links) must not exist in either namespace yet, and the write itself is conditional so the link can be used only once even under concurrent requests.
async function reservedPutOptions(env: Env, p: Prepared, fixedId: string | undefined): Promise<R2PutOptions> {
  if (fixedId === undefined) return p.r2;
  const [a, b] = await Promise.all([env.BUCKET.head(fileKey(fixedId, false)), env.BUCKET.head(fileKey(fixedId, true))]);
  if (a || b) throw linkUsed();
  return { ...p.r2, onlyIf: { etagDoesNotMatch: "*" } };
}

// Streams a body of known length into R2 without buffering it, after sniffing its first bytes.
export async function storeStream(env: Env, uploader: Uploader, opts: UploadOptions, body: ReadableStream<Uint8Array>, length: number, fixedId?: string): Promise<UploadResult> {
  if (length <= 0) throw new HttpError(400, "empty upload");
  const { head, stream } = await peekStream(body, SNIFF_BYTES);
  const type = sniffMedia(head);
  if (!type) {
    await stream.cancel();
    throw unsupportedType();
  }
  const p = await prepare(env, uploader, opts, type, fixedId);
  let put: R2PutOptions;
  try {
    put = await reservedPutOptions(env, p, fixedId);
  } catch (err) {
    await stream.cancel();
    throw err;
  }
  const fixed = new FixedLengthStream(length);
  const abort = new AbortController();
  // Hash on the way through (no second copy of the body in memory) so blocked content can be refused.
  const digest = new crypto.DigestStream("SHA-256");
  const hashWriter = digest.getWriter();
  const hasher = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      await hashWriter.write(chunk.slice());
      controller.enqueue(chunk);
    },
    async flush() {
      await hashWriter.close();
    },
  });
  const piping = stream.pipeThrough(hasher).pipeTo(fixed.writable, { signal: abort.signal }).then(
    () => null,
    (err: unknown) => err ?? new Error("pipe failed"),
  );
  let stored: R2Object | null;
  try {
    stored = await env.BUCKET.put(p.key, fixed.readable, put);
  } catch {
    abort.abort();
    await piping;
    // A short or long body makes FixedLengthStream fail; make sure nothing partial is left behind.
    if (fixedId === undefined) await env.BUCKET.delete(p.key);
    throw new HttpError(400, "upload body did not match its declared length");
  }
  if (stored === null) {
    abort.abort();
    await piping;
    throw linkUsed();
  }
  if ((await piping) !== null) {
    await env.BUCKET.delete(p.key);
    throw new HttpError(400, "upload body did not match its declared length");
  }
  try {
    await assertHashAllowed(env, toHex(await digest.digest));
  } catch (err) {
    await env.BUCKET.delete(p.key);
    throw err;
  }
  return result(env, p, length, opts.name);
}

export async function storeBytes(env: Env, uploader: Uploader, opts: UploadOptions, bytes: Uint8Array, fixedId?: string): Promise<UploadResult> {
  if (bytes.byteLength === 0) throw new HttpError(400, "empty upload");
  const type = sniffMedia(bytes.subarray(0, SNIFF_BYTES));
  if (!type) throw unsupportedType();
  await assertHashAllowed(env, await sha256Hex(bytes));
  const p = await prepare(env, uploader, opts, type, fixedId);
  const stored = await env.BUCKET.put(p.key, bytes, await reservedPutOptions(env, p, fixedId));
  if (stored === null) throw linkUsed();
  return result(env, p, bytes.byteLength, opts.name);
}

export function tooLargeSingle(): HttpError {
  return new HttpError(413, `file too large for a single request (max ${SINGLE_REQUEST_MAX_BYTES / MiB} MB); use the chunked upload API for files up to ${MAX_FILE_BYTES / MiB} MB`);
}

// PUT /api/upload: raw body, options in the query string. This is what the web client and the CLI use; nothing is buffered.
export async function handleUploadPut(request: Request, env: Env): Promise<Response> {
  const uploader = await authorizeUpload(request, env);
  const url = new URL(request.url);
  const opts = parseOptions((k) => url.searchParams.get(k));
  const declared = request.headers.get("content-length");
  if (declared === null) throw new HttpError(411, "Content-Length required");
  const length = Number(declared);
  if (!Number.isSafeInteger(length) || length < 0) throw new HttpError(400, "invalid Content-Length");
  if (length > SINGLE_REQUEST_MAX_BYTES) throw tooLargeSingle();
  if (!request.body) throw new HttpError(400, "empty upload");
  return uploadResponse(request, await storeStream(env, uploader, opts, request.body, length));
}

export interface MultipartUpload {
  fields: Map<string, string>;
  file: { bytes: Uint8Array; filename: string | undefined } | null;
}

// Parses a multipart/form-data upload incrementally; only the file part itself is held in memory.
export async function readMultipartUpload(request: Request): Promise<MultipartUpload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data/i.test(contentType)) throw new HttpError(415, "expected multipart/form-data (or use PUT with the raw file)");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > SINGLE_REQUEST_MAX_BYTES + 64 * 1024) throw tooLargeSingle();

  const fields = new Map<string, string>();
  let file: MultipartUpload["file"] = null;
  try {
    for await (const part of parseMultipartRequest(request, { maxFileSize: SINGLE_REQUEST_MAX_BYTES, maxParts: 16, maxTotalSize: SINGLE_REQUEST_MAX_BYTES + 64 * 1024 })) {
      if (!part.name) continue;
      if (part.name === "file" && part.isFile) {
        if (file) throw new HttpError(400, "send one file per request");
        file = { bytes: part.bytes, filename: part.filename };
      } else if (!part.isFile) {
        fields.set(part.name, part.text);
      }
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof MaxFileSizeExceededError || err instanceof MaxTotalSizeExceededError) throw tooLargeSingle();
    if (err instanceof MaxPartsExceededError) throw new HttpError(400, "too many form fields");
    if (err instanceof MultipartParseError) throw new HttpError(400, "malformed multipart body");
    throw err;
  }
  return { fields, file };
}

// POST /api/upload: multipart/form-data with `file` or `url`, plus optional `expire`, `style`, `name`.
export async function handleUploadPost(request: Request, env: Env): Promise<Response> {
  const uploader = await authorizeUpload(request, env);
  const { fields, file } = await readMultipartUpload(request);

  const opts = parseOptions((k) => fields.get(k) ?? null);
  const remote = fields.get("url");
  if (file && remote) throw new HttpError(400, 'send either "file" or "url", not both');
  if (remote) return uploadResponse(request, await importUrl(env, uploader, opts, remote));
  if (!file) throw new HttpError(400, 'missing multipart field "file" (or "url")');
  if (!opts.name) opts.name = sanitizeName(file.filename);
  return uploadResponse(request, await storeBytes(env, uploader, opts, file.bytes));
}

function isOwnHost(env: Env, host: string): boolean {
  const own = [env.MAIN_ORIGIN, env.FILES_ORIGIN, env.TMP_ORIGIN, env.CACHE_ORIGIN].filter(Boolean).map((o) => new URL(o).hostname);
  const h = host.toLowerCase();
  return h === "localhost" || own.some((o) => h === o || h.endsWith("." + o)) || h.endsWith(".sugi.moe") || h === "sugi.moe";
}

function checkRemoteUrl(env: Env, raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HttpError(400, "that does not look like a URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, "only http and https links can be imported");
  if (u.username || u.password) throw new HttpError(400, "links with credentials are not accepted");
  if (isOwnHost(env, u.hostname)) throw new HttpError(400, "that link is already on sugi");
  return u;
}

// Fetches a remote image or video and stores it like an upload. Redirects are followed by hand so that every hop is checked; the whole import is bounded by a timeout.
export async function importUrl(env: Env, uploader: Uploader, opts: UploadOptions, raw: string): Promise<UploadResult> {
  let target = checkRemoteUrl(env, raw);
  const signal = AbortSignal.timeout(IMPORT_TIMEOUT_MS);
  let res: Response | null = null;
  for (let hop = 0; hop <= IMPORT_MAX_REDIRECTS; hop++) {
    try {
      res = await fetch(target.toString(), { redirect: "manual", signal, headers: { "user-agent": "sugi.moe-importer/1 (+https://sugi.moe/faq)", accept: "image/*,video/*;q=0.9,*/*;q=0.1" } });
    } catch {
      throw new HttpError(502, "could not fetch that link");
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel();
      if (!loc) throw new HttpError(502, "the link redirected nowhere");
      target = checkRemoteUrl(env, new URL(loc, target).toString());
      res = null;
      continue;
    }
    break;
  }
  if (!res) throw new HttpError(502, "too many redirects");
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new HttpError(502, `the link answered with HTTP ${res.status}`);
  }
  if (!opts.name) opts.name = sanitizeName(decodeURIComponent(target.pathname.split("/").pop() ?? "")) ?? null;

  const declared = res.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared)) {
    const length = Number(declared);
    if (length > MAX_FILE_BYTES) {
      await res.body.cancel();
      throw new HttpError(413, `that file is larger than ${MAX_FILE_BYTES / MiB} MB`);
    }
    try {
      return await storeStream(env, uploader, opts, res.body, length);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, "the download was interrupted");
    }
  }
  // No declared length: buffer, but only up to a small cap.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let r: ReadableStreamReadResult<Uint8Array>;
    try {
      r = await reader.read();
    } catch {
      throw new HttpError(502, "the download was interrupted");
    }
    if (r.done) break;
    total += r.value.byteLength;
    if (total > IMPORT_UNKNOWN_LENGTH_MAX_BYTES) {
      await reader.cancel();
      throw new HttpError(413, `that link did not say how big the file is, and it is over ${IMPORT_UNKNOWN_LENGTH_MAX_BYTES / MiB} MB`);
    }
    chunks.push(r.value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return storeBytes(env, uploader, opts, bytes);
}

interface ByteRange {
  offset: number;
  length: number;
}

// Single-range parser for "bytes=a-b", "bytes=a-" and "bytes=-n". Returns "invalid" for unsatisfiable ranges and null when the header should be ignored.
export function parseRange(header: string | null, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    const length = Math.min(n, size);
    return { offset: size - length, length };
  }
  const start = Number(m[1]);
  if (start >= size) return "invalid";
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return "invalid";
  return { offset: start, length: end - start + 1 };
}

// GET/HEAD https://files.sugi.moe/<id>.<ext> and https://tmp.sugi.moe/<id>.<ext>.
export async function handleFileServe(request: Request, env: Env, temporary: boolean, name: string): Promise<Response> {
  const dot = name.lastIndexOf(".");
  const id = name.slice(0, dot);
  const ext = name.slice(dot + 1);
  if (dot <= 0 || !isFileId(id) || !MEDIA_BY_EXT[ext]) throw new HttpError(404, "not found");
  const key = fileKey(id, temporary);
  const obj = await env.BUCKET.head(key);
  if (isTombstone(obj)) throw new RemovedError();
  const file = obj && describe(key, obj);
  const now = Date.now();
  if (!obj || !file || file.type.ext !== ext || (file.expires !== null && file.expires <= now)) throw new HttpError(404, "not found");

  const ttl = file.expires === null ? 31536000 : Math.max(1, Math.floor((file.expires - now) / 1000));
  const headers = new Headers({
    "content-type": file.type.mime,
    "x-content-type-options": "nosniff",
    "content-disposition": `inline; filename="${id}.${ext}"`,
    "content-security-policy": file.type.kind === "video" ? VIDEO_CSP : IMAGE_CSP,
    "cache-control": file.expires === null ? "public, max-age=31536000, immutable" : `public, max-age=${ttl}`,
    "accept-ranges": "bytes",
    etag: obj.httpEtag,
    "last-modified": obj.uploaded.toUTCString(),
  });
  if (etagMatches(request.headers.get("if-none-match"), obj.httpEtag)) return new Response(null, { status: 304, headers });

  const range = parseRange(request.headers.get("range"), obj.size);
  if (range === "invalid") {
    headers.set("content-range", `bytes */${obj.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (request.method === "HEAD") {
    headers.set("content-length", String(obj.size));
    return new Response(null, { status: 200, headers });
  }

  if (env.CACHE_ORIGIN) {
    const upstream = await fetchViaCache(env, key, { ttl, range: range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : null });
    if (upstream.status !== 200 && upstream.status !== 206) {
      // Passes through blocks such as a CSAM match (451) instead of falling back to the bucket, which would defeat the block.
      await upstream.body?.cancel();
      throw new HttpError(upstream.status === 404 ? 404 : upstream.status >= 500 ? 502 : upstream.status, upstream.status === 404 ? "not found" : "unavailable");
    }
    for (const h of ["content-length", "content-range"]) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  const body = await env.BUCKET.get(key, range ? { range } : undefined);
  if (!body || !hasBody(body)) throw new HttpError(404, "not found");
  if (range) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${obj.size}`);
    headers.set("content-length", String(range.length));
    return new Response(body.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(body.body, { status: 200, headers });
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

/** Deletes a current-API file after checking its delete token (`null` = already authorised, e.g. admin). Returns null when the file does not exist. */
export async function deleteFile(env: Env, id: string, token: string | null): Promise<{ key: string; cachePurged: boolean } | null> {
  if (!isFileId(id)) return null;
  for (const temporary of [false, true]) {
    const key = fileKey(id, temporary);
    const obj = await env.BUCKET.head(key);
    if (!obj || isTombstone(obj)) continue;
    if (token !== null) {
      const expected = obj.customMetadata?.del ?? "";
      const given = await sha256Hex(new TextEncoder().encode(token));
      if (!expected || !(await constantTimeEqual(given, expected))) throw new HttpError(403, "wrong delete token");
    }
    await env.BUCKET.delete(key);
    return { key, cachePurged: await purgeCache(env, [key]) };
  }
  return null;
}

// DELETE /api/files/:id with `Sugi-Token: <delete_token>` (or the admin bearer token).
export async function handleFileDelete(request: Request, env: Env, id: string): Promise<Response> {
  if (!isFileId(id)) throw new HttpError(404, "not found");
  const admin = await isAdmin(request, env);
  const token = request.headers.get("sugi-token");
  if (!admin && !token) throw new HttpError(401, "missing Sugi-Token header (the delete_token returned by the upload)");
  // An admin deletion is a takedown, exactly like the MCP tool: tombstone (451, id never reused), audit log, cache purge.
  if (admin) {
    const url = new URL(request.url);
    const r = await takedown(env, id, { reason: url.searchParams.get("reason") ?? "admin DELETE /api/files", blockContent: url.searchParams.get("block_content") === "1", via: "http" });
    return deletionResponse(r.removed.length ? [id] : [], r.cache_purged, r.already_removed.length ? { already_removed: [id] } : {});
  }
  const done = await deleteFile(env, id, token);
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
  return { deleted: expired, cachePurged: await purgeCache(env, expired) };
}
