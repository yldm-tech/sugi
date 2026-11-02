// Serving uploaded files from the files and tmp origins: tombstones, expiry, ETags, ranges, and fetching through the zone cache when CACHE_ORIGIN is set.
import { fetchViaCache } from "./cache";
import { countOps } from "./ops";
import { etagMatches, hasBody, HttpError, RemovedError } from "./http";
import { isTombstone } from "./moderation";
import { isFileId } from "./ids";
import { MEDIA_BY_EXT } from "./sniff";
import { describe, fileKey, IMAGE_CSP, VIDEO_CSP } from "./files";

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
    // Only a confirmed object's 200, 206 and 304 may be cached; an error never is.
    headers.set("cache-control", "no-store");
    return new Response(null, { status: 416, headers });
  }
  if (request.method === "HEAD") {
    headers.set("content-length", String(obj.size));
    return new Response(null, { status: 200, headers });
  }

  if (env.CACHE_ORIGIN) {
    const opts = { ttl, range: range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : null };
    let upstream = await fetchViaCache(env, key, opts);
    if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 451) {
      // The bucket has just confirmed the object, so anything else from our own R2 custom domain (a 404 right after the upload, a 403, a 5xx) is not the visitor's fault: count it and try once more.
      await upstream.body?.cancel();
      await countOps(env, `cache_${upstream.status}`);
      upstream = await fetchViaCache(env, key, opts);
    }
    // A CSAM match (451) is passed on, never worked around by reading the bucket directly, which would defeat the block.
    if (upstream.status === 451) {
      await upstream.body?.cancel();
      throw new RemovedError();
    }
    if (upstream.status === 200 || upstream.status === 206) {
      for (const h of ["content-length", "content-range"]) {
        const v = upstream.headers.get(h);
        if (v) headers.set(h, v);
      }
      return new Response(upstream.body, { status: upstream.status, headers });
    }
    // Still failing: serve the confirmed object from the bucket rather than fail a visitor (typically the first view right after an upload).
    await upstream.body?.cancel();
    await countOps(env, "cache_fallback");
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
