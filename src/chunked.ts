// Chunked uploads for files too big for one request (Cloudflare caps request bodies at 100 MB on Free/Pro zones). Backed by an R2 multipart upload. The session lives in a signed token handed to the client, so the Worker keeps no state between requests.
//
// 1. POST /api/uploads?size=<total>[&expire=&style=&name=]   body = part 1 (its length is the part size)
//    -> 201 {"upload": "<session>", "part_size", "parts", "id", "etag"}
// 2. PUT /api/uploads/<n>   Sugi-Upload: <session>   body = part n (n = 2..parts)
//    -> 200 {"part": n, "etag"}
// 3. POST /api/uploads/complete   Sugi-Upload: <session>   {"etags": ["<part 1>", "<part 2>", ...]}
//    -> 201 same body as /api/upload
//    DELETE /api/uploads   Sugi-Upload: <session>   aborts.
import { base64url } from "./ids";
import { constantTimeEqual, hmacSha256Hex } from "./crypto";
import { prepare, peekStream, result, sanitizeName, unsupportedType, uploadResponse, parseOptions } from "./files";
import { authorizeUpload, HttpError, jsonResponse } from "./http";
import { ownFile } from "./auth/core";
import { MAX_FILE_BYTES, MAX_PART_BYTES, MIN_PART_BYTES } from "./limits";
import { MEDIA_BY_EXT, SNIFF_BYTES, sniffMedia } from "./sniff";

const MiB = 1024 * 1024;
const SESSION_TTL_MS = 24 * 3600 * 1000;

interface Session {
  k: string; // R2 key
  u: string; // R2 multipart upload id
  id: string;
  ext: string;
  ps: number; // part size
  sz: number; // total size
  ex: number | null; // file expiry (ms)
  nm: string | null;
  tk: string; // delete token, returned on completion
  exp: number; // session expiry (ms)
  uid?: string; // account the finished file is recorded under
}

function partsOf(s: Pick<Session, "ps" | "sz">): number {
  return Math.ceil(s.sz / s.ps);
}

function expectedLength(s: Session, n: number): number {
  const parts = partsOf(s);
  return n < parts ? s.ps : s.sz - s.ps * (parts - 1);
}

async function signingKey(env: Env): Promise<string> {
  if (!env.IP_HASH_SECRET) throw new HttpError(503, "uploads are not configured");
  return `${env.IP_HASH_SECRET}:upload-session`;
}

async function encodeSession(env: Env, s: Session): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(s)));
  return `${payload}.${await hmacSha256Hex(await signingKey(env), payload)}`;
}

async function decodeSession(env: Env, request: Request): Promise<Session> {
  const raw = request.headers.get("sugi-upload") ?? "";
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) throw new HttpError(401, "missing or malformed Sugi-Upload header");
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!(await constantTimeEqual(sig, await hmacSha256Hex(await signingKey(env), payload)))) throw new HttpError(401, "invalid upload session");
  const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  const s = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0)))) as Session;
  if (s.exp < Date.now()) throw new HttpError(410, "upload session expired");
  return s;
}

function bodyLength(request: Request): number {
  const declared = request.headers.get("content-length");
  if (declared === null) throw new HttpError(411, "Content-Length required");
  const n = Number(declared);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, "invalid Content-Length");
  return n;
}

async function uploadPartStream(mpu: R2MultipartUpload, n: number, body: ReadableStream<Uint8Array>, length: number): Promise<R2UploadedPart> {
  const fixed = new FixedLengthStream(length);
  try {
    const [, part] = await Promise.all([body.pipeTo(fixed.writable), mpu.uploadPart(n, fixed.readable)]);
    return part;
  } catch {
    throw new HttpError(400, `part ${n} did not match its declared length`);
  }
}

export async function handleChunkCreate(request: Request, env: Env): Promise<Response> {
  const uploader = await authorizeUpload(request, env);
  const url = new URL(request.url);
  const opts = parseOptions((k) => url.searchParams.get(k));
  const size = Number(url.searchParams.get("size"));
  if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, 'query parameter "size" (total bytes) is required');
  if (size > MAX_FILE_BYTES) throw new HttpError(413, `file too large (max ${MAX_FILE_BYTES / MiB} MB)`);
  const partSize = bodyLength(request);
  if (partSize > MAX_PART_BYTES) throw new HttpError(413, `parts can be at most ${MAX_PART_BYTES / MiB} MB`);
  if (partSize < MIN_PART_BYTES && partSize < size) throw new HttpError(400, `parts must be at least ${MIN_PART_BYTES / MiB} MB (except the last)`);
  if (partSize > size) throw new HttpError(400, "the first part is larger than the declared size");
  if (!request.body) throw new HttpError(400, "empty upload");

  const { head, stream } = await peekStream(request.body, SNIFF_BYTES);
  const type = sniffMedia(head);
  if (!type) {
    await stream.cancel();
    throw unsupportedType();
  }
  const p = await prepare(env, uploader, opts, type);
  const mpu = await env.BUCKET.createMultipartUpload(p.key, p.r2);
  let part: R2UploadedPart;
  try {
    part = await uploadPartStream(mpu, 1, stream, partSize);
  } catch (err) {
    await mpu.abort();
    throw err;
  }
  const session: Session = { k: p.key, u: mpu.uploadId, id: p.id, ext: type.ext, ps: partSize, sz: size, ex: p.expires, nm: opts.name, tk: p.token, exp: Date.now() + SESSION_TTL_MS, uid: uploader.userId };
  return jsonResponse({ upload: await encodeSession(env, session), id: p.id, part_size: partSize, parts: partsOf(session), etag: part.etag }, 201);
}

export async function handleChunkPart(request: Request, env: Env, n: number): Promise<Response> {
  const s = await decodeSession(env, request);
  const parts = partsOf(s);
  if (!Number.isInteger(n) || n < 2 || n > parts) throw new HttpError(400, `part number must be between 2 and ${parts}`);
  const length = bodyLength(request);
  const expected = expectedLength(s, n);
  if (length !== expected) throw new HttpError(400, `part ${n} must be exactly ${expected} bytes`);
  if (!request.body) throw new HttpError(400, "empty part");
  const mpu = env.BUCKET.resumeMultipartUpload(s.k, s.u);
  const part = await uploadPartStream(mpu, n, request.body, length);
  return jsonResponse({ part: n, etag: part.etag });
}

export async function handleChunkComplete(request: Request, env: Env): Promise<Response> {
  const s = await decodeSession(env, request);
  let body: { etags?: unknown };
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, 'expected JSON body {"etags": [...]}');
  }
  const parts = partsOf(s);
  const etags = body.etags;
  if (!Array.isArray(etags) || etags.length !== parts || !etags.every((e) => typeof e === "string" && e.length > 0)) {
    throw new HttpError(400, `"etags" must list the etag of each of the ${parts} parts in order`);
  }
  const mpu = env.BUCKET.resumeMultipartUpload(s.k, s.u);
  let obj: R2Object;
  try {
    obj = await mpu.complete(etags.map((etag, i) => ({ partNumber: i + 1, etag: etag as string })));
  } catch {
    throw new HttpError(400, "could not complete the upload; check the part etags");
  }
  if (obj.size !== s.sz) {
    await env.BUCKET.delete(s.k);
    throw new HttpError(400, "the uploaded parts do not add up to the declared size");
  }
  // Chunked files are always over HASH_MAX_BYTES, so the content blocklist does not apply to them (hashing them exceeds the CPU limit).
  const type = MEDIA_BY_EXT[s.ext];
  await ownFile(env, s.uid, s.k);
  return uploadResponse(request, result(env, { id: s.id, key: s.k, type, token: s.tk, expires: s.ex, r2: {} }, s.sz, sanitizeName(s.nm)));
}

export async function handleChunkAbort(request: Request, env: Env): Promise<Response> {
  const s = await decodeSession(env, request);
  await env.BUCKET.resumeMultipartUpload(s.k, s.u).abort();
  return jsonResponse({ aborted: true });
}
