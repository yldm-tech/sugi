const MiB = 1024 * 1024;

/** Legacy /upload: images only, content-addressed. */
export const LEGACY_MAX_BYTES = 20 * MiB;

/** Largest file the current API accepts (single request or chunked). */
export const MAX_FILE_BYTES = 200 * MiB;

/** Cloudflare Free and Pro zones reject request bodies over 100 MB, so a single request carries at most this much; larger files go through the chunked upload API. */
export const SINGLE_REQUEST_MAX_BYTES = 90 * MiB;

/** Chunked uploads: R2 needs every part but the last to be the same size and at least 5 MiB. */
export const MIN_PART_BYTES = 5 * MiB;
export const MAX_PART_BYTES = SINGLE_REQUEST_MAX_BYTES;

/** URL import: the remote server must declare a Content-Length up to MAX_FILE_BYTES; without one we buffer at most this much. */
export const IMPORT_UNKNOWN_LENGTH_MAX_BYTES = 20 * MiB;
export const IMPORT_TIMEOUT_MS = 30_000;
export const IMPORT_MAX_REDIRECTS = 3;

/** Keep in sync with the `ratelimits` entry in wrangler.jsonc; the binding does not expose its own configuration. */
export const RATE_LIMIT = 10;
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/** Keep in sync with the zone WAF rate limiting rule (see README); shown on the developer page. */
export const WAF_LIMIT = 5;
export const WAF_PERIOD_SECONDS = 10;

/** Upload links (MCP create_upload): how many one call may hand out and how long each stays valid. */
export const UPLOAD_LINK_MAX = 50;
export const UPLOAD_LINK_TTL_SECONDS = 600;

/** Content blocklist: files up to this size are hashed on upload (and on takedown). Hashing a whole 90-200 MB file exceeds the Worker CPU limit (error 1102), so bigger files are not checked. */
export const HASH_MAX_BYTES = 20 * MiB;

/** Album limits. */
export const ALBUM_MAX_FILES = 100;
export const ALBUM_TITLE_MAX = 80;

/** Display names stored with an upload. */
export const NAME_MAX = 120;

export const EXPIRIES = {
  "1h": 3600,
  "12h": 12 * 3600,
  "72h": 72 * 3600,
} as const;
export type ExpiryId = keyof typeof EXPIRIES;

/** Accepts the API spellings plus the few aliases a person is likely to type. */
export function parseExpiry(raw: string | null | undefined): ExpiryId | null | "invalid" {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "perm" || v === "permanent" || v === "never" || v === "0") return null;
  if (v === "1h" || v === "60m") return "1h";
  if (v === "12h") return "12h";
  if (v === "72h" || v === "3d") return "72h";
  return "invalid";
}
