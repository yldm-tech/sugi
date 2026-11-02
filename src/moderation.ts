// Moderation for admins: inspect anything by link or id, take content down (with a tombstone so the id is never reused and serves 451, and optionally a content-hash block so the same bytes cannot come back), act on everything from one source, block sources from uploading, and keep an append-only audit log. Used by the admin MCP tools and by the admin HTTP endpoints, so both behave the same.
import { purgeUrls } from "./cache";
import { toHex } from "./crypto";
import { describe, fileKey, pageUrl, publicUrl } from "./files";
import { MEDIA_BY_EXT } from "./sniff";
import { HASH_MAX_BYTES } from "./limits";
import { HttpError, isSourceBlocked, RemovedError } from "./http";
import { isFileId } from "./ids";
import { LEGACY_KEY_RE } from "./legacy";

export type Target = { kind: "file"; id: string } | { kind: "legacy"; key: string } | { kind: "album"; id: string };

const SOURCE_RE = /^[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const ALBUM_RE = /^[a-z0-9]{8}$/;
const ACTOR = "admin";

/** An empty object left at a removed file's key. */
export function isTombstone(obj: R2Object | null): boolean {
  return obj?.customMetadata?.tomb === "1";
}

/** Throws 451 if the current-API file id was taken down (checks both namespaces). */
export async function assertFileNotRemoved(env: Env, id: string): Promise<void> {
  if (!isFileId(id)) return;
  const [a, b] = await Promise.all([env.BUCKET.head(fileKey(id, false)), env.BUCKET.head(fileKey(id, true))]);
  if (isTombstone(a) || isTombstone(b)) throw new RemovedError();
}

/** Throws 451 if the album was taken down. */
export async function assertAlbumNotRemoved(env: Env, id: string): Promise<void> {
  if (!ALBUM_RE.test(id)) return;
  if (await env.DB.prepare("SELECT 1 FROM tombstones WHERE target = ?").bind(`album:${id}`).first()) throw new RemovedError();
}

// ---- content hashes ----

/** SHA-256 of a stored object, streamed so big files are never held in memory. */
export async function hashObject(env: Env, key: string): Promise<string | null> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  // Too big to hash within the CPU limit; such files are taken down without a content block.
  if (obj.size > HASH_MAX_BYTES) {
    await obj.body.cancel();
    return null;
  }
  const digest = new crypto.DigestStream("SHA-256");
  await obj.body.pipeTo(digest);
  return toHex(await digest.digest);
}

export async function isHashBlocked(env: Env, sha256: string): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 FROM blocked_hashes WHERE sha256 = ?").bind(sha256).first()) !== null;
}

/** Rejects content an admin blocked. Called on every upload path before (or right after) storing. */
export async function assertHashAllowed(env: Env, sha256: string): Promise<void> {
  if (await isHashBlocked(env, sha256)) throw new RemovedError();
}

// ---- targets ----

/** Accepts a file id, any file link (files./tmp. host, /f/<id> page, R2 key f/<id> or t/<id>), a legacy link or key (<16 hex>.<ext>), or an album link (/a/<id>, a/<id>). */
export function parseTarget(raw: string): Target {
  const s = raw.trim();
  let path = s;
  try {
    path = new URL(s).pathname;
  } catch {}
  path = path.replace(/^\/+/, "");
  const album = /^a\/([a-z0-9]{8})$/.exec(path);
  if (album) return { kind: "album", id: album[1] };
  const last = path.split("/").pop() ?? "";
  if (LEGACY_KEY_RE.test(last)) return { kind: "legacy", key: last };
  const id = last.replace(/\.[a-z0-9]+$/i, "");
  if (isFileId(id)) return { kind: "file", id };
  throw new HttpError(400, `not a sugi file or album: ${raw}`);
}

function targetName(t: Target): string {
  return t.kind === "legacy" ? `legacy:${t.key}` : `${t.kind}:${t.id}`;
}

async function findKey(env: Env, t: Target): Promise<{ key: string; obj: R2Object } | null> {
  if (t.kind === "legacy") {
    const obj = await env.BUCKET.head(t.key);
    return obj ? { key: t.key, obj } : null;
  }
  if (t.kind === "file") {
    for (const temporary of [false, true]) {
      const key = fileKey(t.id, temporary);
      const obj = await env.BUCKET.head(key);
      if (obj) return { key, obj };
    }
  }
  return null;
}

/** A bare 8-character id may be a file or an album; files win, albums are tried when no file has that id. */
async function resolve(env: Env, raw: string): Promise<Target> {
  const t = parseTarget(raw);
  if (t.kind === "file" && ALBUM_RE.test(t.id) && !raw.includes("/") && !(await findKey(env, t))) {
    const album = await env.DB.prepare("SELECT 1 FROM albums WHERE id = ? UNION SELECT 1 FROM tombstones WHERE target = ?").bind(t.id, `album:${t.id}`).first();
    if (album) return { kind: "album", id: t.id };
  }
  return t;
}

// Every URL an object was served from: the cache origin (when files go through the zone cache), its public link and its share page. Tombstone markers keep the extension so a retried takedown can purge again.
function objectUrls(env: Env, key: string, obj: R2Object): string[] {
  const urls = env.CACHE_ORIGIN ? [`${env.CACHE_ORIGIN}/${key}`] : [];
  if (LEGACY_KEY_RE.test(key)) return [...urls, `${env.MAIN_ORIGIN}/${key}`];
  const ext = obj.customMetadata?.ext;
  const type = ext ? MEDIA_BY_EXT[ext] : undefined;
  const id = key.slice(2);
  return type ? [...urls, publicUrl(env, { id, temporary: key.startsWith("t/"), type }), pageUrl(env, id)] : urls;
}

export async function auditLog(env: Env, action: string, target: string | null, reason: string | null, detail: unknown = null): Promise<D1PreparedStatement> {
  return env.DB.prepare("INSERT INTO admin_log (at, actor, action, target, reason, detail) VALUES (?, ?, ?, ?, ?, ?)").bind(
    Date.now(),
    ACTOR,
    action,
    target,
    reason,
    detail === null ? null : JSON.stringify(detail),
  );
}

function iso(ms: number | null | undefined): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

// ---- inspect ----

export async function inspect(env: Env, raw: string): Promise<Record<string, unknown>> {
  const t = await resolve(env, raw);
  const tomb = await env.DB.prepare("SELECT reason, sha256, source, created_at FROM tombstones WHERE target = ?")
    .bind(targetName(t))
    .first<{ reason: string | null; sha256: string | null; source: string | null; created_at: number }>();
  const takedown = tomb ? { reason: tomb.reason, sha256: tomb.sha256, at: iso(tomb.created_at) } : null;

  if (t.kind === "album") {
    const row = await env.DB.prepare("SELECT title, created_at, source FROM albums WHERE id = ?")
      .bind(t.id)
      .first<{ title: string; created_at: number; source: string }>();
    const files = row
      ? (await env.DB.prepare("SELECT file_key FROM album_files WHERE album_id = ? ORDER BY position").bind(t.id).all<{ file_key: string }>()).results.map(
          (r) => r.file_key,
        )
      : [];
    const source = row?.source ?? tomb?.source ?? null;
    return {
      kind: "album",
      id: t.id,
      status: row ? "live" : tomb ? "taken_down" : "missing",
      title: row?.title ?? null,
      created_at: iso(row?.created_at),
      source,
      source_blocked: source ? await isSourceBlocked(env, source) : false,
      files,
      takedown,
      owner: null,
    };
  }

  const found = await findKey(env, t);
  const obj = found?.obj ?? null;
  const key = found?.key ?? (t.kind === "legacy" ? t.key : null);
  const m = obj?.customMetadata ?? {};
  const removed = isTombstone(obj);
  const expires = m.expires ? Number(m.expires) : null;
  const source = removed ? (tomb?.source ?? null) : (m.source ?? null);
  const albums = key
    ? (await env.DB.prepare("SELECT DISTINCT album_id FROM album_files WHERE file_key = ?").bind(key).all<{ album_id: string }>()).results.map(
        (r) => r.album_id,
      )
    : [];
  const status = !obj ? "missing" : removed ? "taken_down" : expires !== null && expires <= Date.now() ? "expired" : "live";
  const f = obj && !removed && key ? describe(key, obj) : null;
  return {
    kind: t.kind,
    id: t.kind === "file" ? t.id : t.key,
    key,
    status,
    type: removed ? null : (obj?.httpMetadata?.contentType ?? null),
    size: removed || !obj ? null : obj.size,
    name: m.name ?? null,
    created_at: removed ? null : (m.uploaded ?? (obj ? obj.uploaded.toISOString() : null)),
    expires_at: iso(expires),
    url: f ? publicUrl(env, f) : t.kind === "legacy" && obj && !removed ? `${env.MAIN_ORIGIN}/${t.key}` : null,
    source,
    source_blocked: source ? await isSourceBlocked(env, source) : false,
    sha256: m.sha256 ?? tomb?.sha256 ?? null,
    content_blocked: (m.sha256 ?? tomb?.sha256) ? await isHashBlocked(env, (m.sha256 ?? tomb?.sha256)!) : false,
    albums,
    takedown,
    owner: null,
  };
}

// ---- takedown ----

export interface TakedownOptions {
  reason?: string | null;
  blockContent?: boolean;
  /** Albums only: also take down every file in the album. */
  includeFiles?: boolean;
  /** Recorded in the log, e.g. "mcp" or "http". */
  via?: string;
}

export interface TakedownResult {
  target: string;
  removed: string[];
  already_removed: string[];
  blocked_hashes: string[];
  /** block_content was asked for but these files are over HASH_MAX_BYTES, so only taken down. */
  not_blocked_too_big?: string[];
  cache_purged: boolean;
}

/** Takes down objects by key: replaces each with a tombstone marker, records it, optionally blocks its content, and purges every URL it was served from. */
async function takedownKeys(env: Env, keys: string[], opts: TakedownOptions, action: string, logTarget: string): Promise<Omit<TakedownResult, "target">> {
  const removed: string[] = [];
  const already: string[] = [];
  const hashes: string[] = [];
  const tooBig: string[] = [];
  const urls: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  const now = Date.now();
  for (const key of keys) {
    const obj = await env.BUCKET.head(key);
    if (!obj) continue;
    urls.push(...objectUrls(env, key, obj));
    if (isTombstone(obj)) {
      already.push(key);
      continue;
    }
    const m = obj.customMetadata ?? {};
    let sha: string | null = m.sha256 ?? null;
    if (opts.blockContent && !sha) sha = await hashObject(env, key);
    const marker: Record<string, string> = { tomb: "1", removed: new Date(now).toISOString() };
    if (m.ext) marker.ext = m.ext;
    await env.BUCKET.put(key, new Uint8Array(0), { httpMetadata: { contentType: "application/octet-stream" }, customMetadata: marker });
    const name = LEGACY_KEY_RE.test(key) ? `legacy:${key}` : `file:${key.slice(2)}`;
    stmts.push(
      env.DB.prepare("INSERT OR REPLACE INTO tombstones (target, reason, sha256, source, created_at) VALUES (?, ?, ?, ?, ?)").bind(
        name,
        opts.reason ?? null,
        sha,
        m.source ?? null,
        now,
      ),
    );
    if (opts.blockContent && !sha) tooBig.push(key);
    if (opts.blockContent && sha) {
      stmts.push(
        env.DB.prepare("INSERT OR IGNORE INTO blocked_hashes (sha256, target, reason, created_at) VALUES (?, ?, ?, ?)").bind(
          sha,
          name,
          opts.reason ?? null,
          now,
        ),
      );
      hashes.push(sha);
    }
    removed.push(key);
  }
  stmts.push(
    await auditLog(env, action, logTarget, opts.reason ?? null, {
      via: opts.via ?? null,
      removed,
      already_removed: already,
      blocked_hashes: hashes,
      too_big_to_block: tooBig,
    }),
  );
  await env.DB.batch(stmts);
  const purged = await purgeUrls(env, urls);
  return { removed, already_removed: already, blocked_hashes: hashes, ...(tooBig.length ? { not_blocked_too_big: tooBig } : {}), cache_purged: purged };
}

async function takedownAlbum(env: Env, id: string, opts: TakedownOptions): Promise<TakedownResult> {
  const row = await env.DB.prepare("SELECT source FROM albums WHERE id = ?").bind(id).first<{ source: string }>();
  const target = `album:${id}`;
  if (!row) {
    if (await env.DB.prepare("SELECT 1 FROM tombstones WHERE target = ?").bind(target).first())
      return { target, removed: [], already_removed: [target], blocked_hashes: [], cache_purged: true };
    throw new HttpError(404, "album not found");
  }
  const keys = (await env.DB.prepare("SELECT file_key FROM album_files WHERE album_id = ? ORDER BY position").bind(id).all<{ file_key: string }>()).results.map(
    (r) => r.file_key,
  );
  const files = opts.includeFiles ? await takedownKeys(env, keys, opts, "takedown", target) : null;
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO tombstones (target, reason, sha256, source, created_at) VALUES (?, ?, NULL, ?, ?)").bind(
      target,
      opts.reason ?? null,
      row.source,
      Date.now(),
    ),
    env.DB.prepare("DELETE FROM album_files WHERE album_id = ?").bind(id),
    env.DB.prepare("DELETE FROM albums WHERE id = ?").bind(id),
    await auditLog(env, "takedown", target, opts.reason ?? null, { via: opts.via ?? null, include_files: Boolean(opts.includeFiles) }),
  ]);
  const purged = await purgeUrls(env, [`${env.MAIN_ORIGIN}/a/${id}`]);
  return {
    target,
    removed: [target, ...(files?.removed ?? [])],
    already_removed: files?.already_removed ?? [],
    blocked_hashes: files?.blocked_hashes ?? [],
    cache_purged: purged && (files?.cache_purged ?? true),
  };
}

export async function takedown(env: Env, raw: string, opts: TakedownOptions): Promise<TakedownResult> {
  const t = await resolve(env, raw);
  if (t.kind === "album") return takedownAlbum(env, t.id, opts);
  const found = await findKey(env, t);
  if (!found) throw new HttpError(404, "not found");
  return { target: targetName(t), ...(await takedownKeys(env, [found.key], opts, "takedown", targetName(t))) };
}

// ---- retention ----

/** Takedown records keep the uploader's source HMAC for at most this long (privacy policy, "How long we keep things"). */
export const SOURCE_RETENTION_MS = 2 * 365 * 24 * 3600 * 1000;

/** Run from the cron: erases source HMACs older than SOURCE_RETENTION_MS from takedown records and the audit log (file id, time and reason stay), and drops source blocks that have expired. */
export async function eraseOldFingerprints(env: Env, now = Date.now()): Promise<{ tombstones: number; log: number; expired_blocks: number }> {
  const cutoff = now - SOURCE_RETENTION_MS;
  const [t, l, b] = await env.DB.batch([
    env.DB.prepare("UPDATE tombstones SET source = NULL WHERE source IS NOT NULL AND created_at < ?").bind(cutoff),
    env.DB.prepare("UPDATE admin_log SET target = 'source:(erased)' WHERE target LIKE 'source:%' AND target != 'source:(erased)' AND at < ?").bind(cutoff),
    env.DB.prepare("DELETE FROM blocked_sources WHERE expires_at IS NOT NULL AND expires_at < ?").bind(now),
  ]);
  return { tombstones: t.meta.changes, log: l.meta.changes, expired_blocks: b.meta.changes };
}

// ---- sources ----

/** A 64-hex source HMAC, or the source of the file/album the link points to. */
export async function resolveSource(env: Env, raw: string): Promise<string> {
  const s = raw.trim().toLowerCase();
  if (SOURCE_RE.test(s)) return s;
  const info = await inspect(env, raw);
  if (typeof info.source !== "string") throw new HttpError(404, "no source recorded for that target");
  return info.source;
}

interface SourceItem {
  kind: "file" | "legacy" | "album";
  key: string;
  created_at: string | null;
  size: number | null;
  expires_at: string | null;
  name: string | null;
}

async function itemsBySource(env: Env, source: string): Promise<SourceItem[]> {
  const items: SourceItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ include: ["customMetadata"], limit: 1000, cursor });
    for (const obj of page.objects) {
      const m = obj.customMetadata ?? {};
      if (m.source !== source) continue;
      items.push({
        kind: LEGACY_KEY_RE.test(obj.key) ? "legacy" : "file",
        key: obj.key,
        created_at: m.uploaded ?? obj.uploaded.toISOString(),
        size: obj.size,
        expires_at: iso(m.expires ? Number(m.expires) : null),
        name: m.name ?? null,
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const albums = (
    await env.DB.prepare("SELECT id, title, created_at FROM albums WHERE source = ?").bind(source).all<{ id: string; title: string; created_at: number }>()
  ).results;
  for (const a of albums) items.push({ kind: "album", key: `a/${a.id}`, created_at: iso(a.created_at), size: null, expires_at: null, name: a.title || null });
  return items.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

export async function listBySource(env: Env, raw: string, offset = 0, limit = 50): Promise<Record<string, unknown>> {
  const source = await resolveSource(env, raw);
  const all = await itemsBySource(env, source);
  const n = Math.min(Math.max(1, limit), 200);
  const removed = (await env.DB.prepare("SELECT COUNT(*) AS n FROM tombstones WHERE source = ?").bind(source).first<{ n: number }>())?.n ?? 0;
  return {
    source,
    source_blocked: await isSourceBlocked(env, source),
    total: all.length,
    already_taken_down: removed,
    offset,
    items: all.slice(offset, offset + n),
    next_offset: offset + n < all.length ? offset + n : null,
  };
}

export async function takedownBySource(env: Env, raw: string, opts: TakedownOptions & { dryRun: boolean }): Promise<Record<string, unknown>> {
  const source = await resolveSource(env, raw);
  const items = await itemsBySource(env, source);
  const keys = items.filter((i) => i.kind !== "album").map((i) => i.key);
  const albums = items.filter((i) => i.kind === "album").map((i) => i.key.slice(2));
  if (opts.dryRun) return { source, dry_run: true, files: keys.length, albums: albums.length, keys, album_ids: albums };
  const done = await takedownKeys(env, keys, opts, "takedown_by_source", `source:${source}`);
  let purged = done.cache_purged;
  for (const id of albums) purged = (await takedownAlbum(env, id, { ...opts, includeFiles: false })).cache_purged && purged;
  return {
    source,
    dry_run: false,
    files: done.removed.length,
    albums: albums.length,
    keys: done.removed,
    album_ids: albums,
    blocked_hashes: done.blocked_hashes,
    cache_purged: purged,
  };
}

export async function blockSource(env: Env, raw: string, reason: string | null, expiresInHours: number | null): Promise<Record<string, unknown>> {
  const source = await resolveSource(env, raw);
  const expires = expiresInHours ? Date.now() + expiresInHours * 3600 * 1000 : null;
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO blocked_sources (source, reason, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(
      source,
      reason,
      expires,
      Date.now(),
    ),
    await auditLog(env, "block_source", `source:${source}`, reason, { expires_at: iso(expires) }),
  ]);
  return { source, blocked: true, expires_at: iso(expires) };
}

export async function unblockSource(env: Env, raw: string, reason: string | null): Promise<Record<string, unknown>> {
  const source = await resolveSource(env, raw);
  const res = await env.DB.prepare("DELETE FROM blocked_sources WHERE source = ?").bind(source).run();
  await (await auditLog(env, "unblock_source", `source:${source}`, reason)).run();
  return { source, unblocked: res.meta.changes > 0 };
}

export async function unblockContent(env: Env, sha256: string, reason: string | null): Promise<Record<string, unknown>> {
  const sha = sha256.trim().toLowerCase();
  if (!SHA_RE.test(sha)) throw new HttpError(400, "sha256 must be 64 hex characters");
  const res = await env.DB.prepare("DELETE FROM blocked_hashes WHERE sha256 = ?").bind(sha).run();
  await (await auditLog(env, "unblock_content", `sha256:${sha}`, reason)).run();
  return { sha256: sha, unblocked: res.meta.changes > 0 };
}

export async function listBlocks(env: Env, limit = 100): Promise<Record<string, unknown>> {
  const n = Math.min(Math.max(1, limit), 500);
  const sources = (
    await env.DB.prepare("SELECT source, reason, expires_at, created_at FROM blocked_sources ORDER BY created_at DESC LIMIT ?")
      .bind(n)
      .all<{ source: string; reason: string | null; expires_at: number | null; created_at: number }>()
  ).results;
  const hashes = (
    await env.DB.prepare("SELECT sha256, target, reason, created_at FROM blocked_hashes ORDER BY created_at DESC LIMIT ?")
      .bind(n)
      .all<{ sha256: string; target: string | null; reason: string | null; created_at: number }>()
  ).results;
  const now = Date.now();
  return {
    sources: sources.map((s) => ({
      source: s.source,
      reason: s.reason,
      expires_at: iso(s.expires_at),
      active: s.expires_at === null || s.expires_at > now,
      created_at: iso(s.created_at),
    })),
    content: hashes.map((h) => ({ sha256: h.sha256, target: h.target, reason: h.reason, created_at: iso(h.created_at) })),
  };
}

export async function readLog(env: Env, limit = 50): Promise<Record<string, unknown>> {
  const n = Math.min(Math.max(1, limit), 500);
  const rows = (
    await env.DB.prepare("SELECT id, at, actor, action, target, reason, detail FROM admin_log ORDER BY id DESC LIMIT ?")
      .bind(n)
      .all<{ id: number; at: number; actor: string; action: string; target: string | null; reason: string | null; detail: string | null }>()
  ).results;
  return {
    entries: rows.map((r) => ({
      id: r.id,
      at: iso(r.at),
      actor: r.actor,
      action: r.action,
      target: r.target,
      reason: r.reason,
      detail: r.detail ? JSON.parse(r.detail) : null,
    })),
  };
}
