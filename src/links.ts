// Upload links: one-time, short-lived URLs that accept exactly one file each, so an agent that can run shell commands but cannot send bytes over its tool channel can upload local files with curl. The MCP tool create_upload hands them out after the usual gate and rate limit (an anonymous caller pays one upload per link up front; a trusted caller pays nothing), and the link itself is the authorization when it is used.
//
// PUT  /api/upload/<link>   raw body (curl -T file), optional ?name=
// POST /api/upload/<link>   multipart with field "file" (curl -F file=@file)
//   -> 201 JSON, the same body as /api/upload
//
// The link is a signed token carrying a reserved file id, so the Worker keeps no state: the R2 write is conditional on the key not existing yet, which makes each link single-use.
import { constantTimeEqual, hmacSha256Hex } from "./crypto";
import { parseOptions, sanitizeName, type UploadOptions } from "./files";
import { readMultipartUpload, storeBytes, storeStream, tooLargeSingle } from "./upload";
import { HttpError, jsonResponse, type Uploader } from "./http";
import { base64url, cuteId, randomId } from "./ids";
import { type ExpiryId, SINGLE_REQUEST_MAX_BYTES, UPLOAD_LINK_TTL_SECONDS } from "./limits";

interface LinkClaims {
  id: string;
  ex: ExpiryId | null; // file lifetime
  nm: string | null; // display name chosen when the link was made
  src: string; // source HMAC of whoever asked for the link
  exp: number; // link expiry (ms)
  tr?: 1; // made by the trusted or admin token
  uid?: string; // made by a logged-in account (session or API token); the upload is recorded under it
}

export interface UploadLink {
  id: string;
  upload_url: string;
}

async function signingKey(env: Env): Promise<string> {
  if (!env.IP_HASH_SECRET) throw new HttpError(503, "uploads are not configured");
  return `${env.IP_HASH_SECRET}:upload-link`;
}

async function encode(env: Env, claims: LinkClaims): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  return `${payload}.${await hmacSha256Hex(await signingKey(env), payload)}`;
}

async function decode(env: Env, token: string): Promise<LinkClaims> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) throw new HttpError(404, "no such upload link");
  const payload = token.slice(0, dot);
  if (!(await constantTimeEqual(token.slice(dot + 1), await hmacSha256Hex(await signingKey(env), payload)))) throw new HttpError(404, "no such upload link");
  const bin = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as LinkClaims;
  if (claims.exp < Date.now()) throw new HttpError(410, "this upload link has expired; ask for a new one");
  return claims;
}

/** Makes `count` links for an uploader that has already passed the gate and paid the rate limit. */
export async function createUploadLinks(
  env: Env,
  uploader: Uploader,
  opts: UploadOptions,
  count: number,
): Promise<{ links: UploadLink[]; expires_at: string }> {
  const exp = Date.now() + UPLOAD_LINK_TTL_SECONDS * 1000;
  const ids = new Set<string>();
  while (ids.size < count) ids.add(opts.style === "cute" ? cuteId() : randomId());
  const links: UploadLink[] = [];
  for (const id of ids) {
    const token = await encode(env, {
      id,
      ex: opts.expire,
      nm: count === 1 ? opts.name : null,
      src: uploader.source,
      exp,
      ...(uploader.trusted ? { tr: 1 as const } : {}),
      ...(uploader.userId ? { uid: uploader.userId } : {}),
    });
    links.push({ id, upload_url: `${env.MAIN_ORIGIN}/api/upload/${token}` });
  }
  return { links, expires_at: new Date(exp).toISOString() };
}

// PUT or POST /api/upload/<link>
export async function handleLinkUpload(request: Request, env: Env, token: string): Promise<Response> {
  const claims = await decode(env, token);
  // The link carries who asked for it, so quotas, ownership and the video rule apply as if they had uploaded directly.
  const uploader: Uploader = { source: claims.src, trusted: claims.tr === 1, userId: claims.uid };
  const url = new URL(request.url);
  const opts: UploadOptions = { ...parseOptions(() => null), expire: claims.ex, name: claims.nm };
  if (request.method === "PUT") {
    const declared = request.headers.get("content-length");
    if (declared === null) throw new HttpError(411, "Content-Length required (upload a file, not a pipe)");
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw new HttpError(400, "invalid Content-Length");
    if (length > SINGLE_REQUEST_MAX_BYTES) throw tooLargeSingle();
    if (!request.body) throw new HttpError(400, "empty upload");
    opts.name ??= sanitizeName(url.searchParams.get("name"));
    return jsonResponse(await storeStream(env, uploader, opts, request.body, length, claims.id), 201);
  }
  const { file } = await readMultipartUpload(request);
  if (!file) throw new HttpError(400, 'missing multipart field "file"');
  opts.name ??= sanitizeName(file.filename);
  return jsonResponse(await storeBytes(env, uploader, opts, file.bytes, claims.id), 201);
}
