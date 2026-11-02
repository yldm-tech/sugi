// Storing uploads: sniffing and streaming bodies into R2, the PUT and multipart POST handlers of /api/upload, and importing a file from a link.
import {
  parseMultipartRequest,
  MultipartParseError,
  MaxFileSizeExceededError,
  MaxTotalSizeExceededError,
  MaxPartsExceededError,
} from "@remix-run/multipart-parser";
import { sha256Hex, toHex } from "./crypto";
import { authorizeUpload, HttpError, type Uploader } from "./http";
import { assertHashAllowed } from "./moderation";
import { ownFile } from "./auth/core";
import { HASH_MAX_BYTES, IMPORT_MAX_REDIRECTS, IMPORT_TIMEOUT_MS, IMPORT_UNKNOWN_LENGTH_MAX_BYTES, MAX_FILE_BYTES, SINGLE_REQUEST_MAX_BYTES } from "./limits";
import { SNIFF_BYTES, sniffMedia } from "./sniff";
import { fileKey, type Prepared, prepare, result, sanitizeName, parseOptions, uploadResponse, type UploadOptions, type UploadResult } from "./files";

const MiB = 1024 * 1024;

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
export async function storeStream(
  env: Env,
  uploader: Uploader,
  opts: UploadOptions,
  body: ReadableStream<Uint8Array>,
  length: number,
  fixedId?: string,
): Promise<UploadResult> {
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
  // Hash on the way through (no second copy of the body in memory) so blocked content can be refused; only up to HASH_MAX_BYTES, see limits.ts.
  const digest = length <= HASH_MAX_BYTES ? new crypto.DigestStream("SHA-256") : null;
  const hashWriter = digest?.getWriter();
  const hasher = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      if (hashWriter) await hashWriter.write(chunk.slice());
      controller.enqueue(chunk);
    },
    async flush() {
      if (hashWriter) await hashWriter.close();
    },
  });
  const piping = stream
    .pipeThrough(hasher)
    .pipeTo(fixed.writable, { signal: abort.signal })
    .then(
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
    if (digest) await assertHashAllowed(env, toHex(await digest.digest));
  } catch (err) {
    await env.BUCKET.delete(p.key);
    throw err;
  }
  await ownFile(env, uploader.userId, p.key);
  return result(env, p, length, opts.name);
}

export async function storeBytes(env: Env, uploader: Uploader, opts: UploadOptions, bytes: Uint8Array, fixedId?: string): Promise<UploadResult> {
  if (bytes.byteLength === 0) throw new HttpError(400, "empty upload");
  const type = sniffMedia(bytes.subarray(0, SNIFF_BYTES));
  if (!type) throw unsupportedType();
  if (bytes.byteLength <= HASH_MAX_BYTES) await assertHashAllowed(env, await sha256Hex(bytes));
  const p = await prepare(env, uploader, opts, type, fixedId);
  const stored = await env.BUCKET.put(p.key, bytes, await reservedPutOptions(env, p, fixedId));
  if (stored === null) throw linkUsed();
  await ownFile(env, uploader.userId, p.key);
  return result(env, p, bytes.byteLength, opts.name);
}

export function tooLargeSingle(): HttpError {
  return new HttpError(
    413,
    `file too large for a single request (max ${SINGLE_REQUEST_MAX_BYTES / MiB} MB); use the chunked upload API for files up to ${MAX_FILE_BYTES / MiB} MB`,
  );
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
    for await (const part of parseMultipartRequest(request, {
      maxFileSize: SINGLE_REQUEST_MAX_BYTES,
      maxParts: 16,
      maxTotalSize: SINGLE_REQUEST_MAX_BYTES + 64 * 1024,
    })) {
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
  return h === "localhost" || own.some((o) => h === o || h.endsWith(`.${o}`));
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
      res = await fetch(target.toString(), {
        redirect: "manual",
        signal,
        headers: { "user-agent": `sugi-importer/1 (+${env.MAIN_ORIGIN}/faq)`, accept: "image/*,video/*;q=0.9,*/*;q=0.1" },
      });
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
