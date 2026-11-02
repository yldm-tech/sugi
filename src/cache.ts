import { jsonResponse } from "./http";

export interface CacheFetchOptions {
  /** Edge TTL in seconds for a successful response; temporary files pass their remaining lifetime. */
  ttl: number;
  /** Forwarded Range header, so video seeking works through the cache. */
  range?: string | null;
}

// Fetches an object through the zone's CDN cache by way of the bucket's R2 custom domain, so that Cloudflare's cache-based features (the CSAM Scanning Tool in particular) see everything that is served. The bucket stays the source of truth: callers confirm the object exists (and has not expired) before calling this, so a deleted object stops being served even before its cached copy is purged.
export function fetchViaCache(env: Env, key: string, opts: CacheFetchOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.range) headers.range = opts.range;
  return fetch(`${env.CACHE_ORIGIN}/${key}`, {
    headers,
    cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": Math.max(1, Math.floor(opts.ttl)), "404": 1, "500-599": 0 } },
  });
}

// Free plans accept at most 30 URLs per purge request.
const PURGE_BATCH = 30;

// Removes deleted objects' copies from the zone cache. Returns false if cache-through serving is on but the purge could not be done, so the caller can report that the cached copies may still be reachable at the origin hostname.
export async function purgeCache(env: Env, keys: string[]): Promise<boolean> {
  if (!env.CACHE_ORIGIN || keys.length === 0) return true;
  return purgeUrls(
    env,
    keys.map((k) => `${env.CACHE_ORIGIN}/${k}`),
  );
}

// Purges arbitrary URLs of the zone (e.g. every public URL a removed file was served from). Without purge credentials this is a no-op that reports success only when the cache is not in use.
export async function purgeUrls(env: Env, urls: string[]): Promise<boolean> {
  if (urls.length === 0) return true;
  if (!env.ZONE_ID || !env.CF_PURGE_TOKEN) return !env.CACHE_ORIGIN;
  let ok = true;
  for (let i = 0; i < urls.length; i += PURGE_BATCH) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.ZONE_ID}/purge_cache`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.CF_PURGE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ files: urls.slice(i, i + PURGE_BATCH) }),
    });
    const body = await res.json<{ success?: boolean }>().catch(() => ({ success: false }));
    ok = ok && res.ok && body.success === true;
  }
  return ok;
}

export function deletionResponse(deleted: string[], cachePurged: boolean, extra: Record<string, unknown> = {}): Response {
  // 502 tells the operator to retry: the objects are gone from the bucket, but cached copies may still be served by the origin hostname.
  return jsonResponse({ ...extra, deleted, cache_purged: cachePurged }, cachePurged ? 200 : 502);
}
