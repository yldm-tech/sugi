// Read-only queries behind the dashboard's lists: files (from the file index), accounts, albums, the audit log, and the numbers on the overview. Writes go through moderation.ts, reports.ts and the small account actions at the end of this file, each of which leaves an audit-log entry.
import { LEGACY_KEY_RE } from "../legacy";
import { auditLog } from "../moderation";
import { MEDIA_BY_EXT } from "../sniff";

const HEX64 = /^[0-9a-f]{64}$/;

/** A LIKE pattern matching `s` anywhere, with LIKE's own wildcards escaped (use with ESCAPE '\'). */
export function likeAny(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The public link of an indexed file. */
export function fileUrl(env: Env, key: string, type: string | null): string | null {
  if (LEGACY_KEY_RE.test(key)) return `${env.MAIN_ORIGIN}/${key}`;
  const ext = Object.values(MEDIA_BY_EXT).find((m) => m.mime === type && m.ext !== "jpg")?.ext ?? (type === "image/jpeg" ? "jpg" : null);
  if (!ext) return null;
  return `${key.startsWith("t/") ? env.TMP_ORIGIN : env.FILES_ORIGIN}/${key.slice(2)}.${ext}`;
}

// ---- files ----

export interface FileRow {
  key: string;
  size: number;
  type: string | null;
  name: string | null;
  source: string | null;
  sha256: string | null;
  created_at: number;
  expires_at: number | null;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
}

export interface FileFilter {
  q: string;
  kind: "" | "image" | "video";
  life: "" | "permanent" | "temporary" | "legacy";
  owner: "" | "account" | "anonymous";
  user: string;
  source: string;
  sort: "new" | "old" | "big";
}

export function parseFileFilter(p: URLSearchParams): FileFilter {
  const pick = <T extends string>(v: string | null, allowed: readonly T[], dflt: T): T => (allowed.includes(v as T) ? (v as T) : dflt);
  return {
    q: (p.get("q") ?? "").trim().slice(0, 200),
    kind: pick(p.get("kind"), ["", "image", "video"] as const, ""),
    life: pick(p.get("life"), ["", "permanent", "temporary", "legacy"] as const, ""),
    owner: pick(p.get("owner"), ["", "account", "anonymous"] as const, ""),
    user: (p.get("user") ?? "").trim().slice(0, 64),
    source: HEX64.test(p.get("source") ?? "") ? p.get("source")! : "",
    sort: pick(p.get("sort"), ["new", "old", "big"] as const, "new"),
  };
}

const OWNER = "(SELECT user_id FROM user_files WHERE file_key = fi.key LIMIT 1)";

function fileWhere(f: FileFilter): { sql: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];
  if (f.q) {
    const q = f.q.toLowerCase();
    if (HEX64.test(q)) {
      parts.push("(fi.source = ? OR fi.sha256 = ?)");
      args.push(q, q);
    } else {
      // A link or id matches its key; anything else is looked for in keys and file names.
      const last = (f.q.split(/[/?#]/).filter(Boolean).pop() ?? "").replace(/\.[a-z0-9]+$/i, "");
      parts.push("(fi.key IN (?, ?, ?) OR fi.key LIKE ? ESCAPE '\\' OR fi.name LIKE ? ESCAPE '\\')");
      args.push(`f/${last}`, `t/${last}`, f.q.split("/").pop() ?? "", likeAny(f.q), likeAny(f.q));
    }
  }
  if (f.kind) {
    parts.push("fi.type LIKE ?");
    args.push(`${f.kind}/%`);
  }
  if (f.life === "permanent") parts.push("fi.key LIKE 'f/%'");
  if (f.life === "temporary") parts.push("fi.key LIKE 't/%'");
  if (f.life === "legacy") parts.push("fi.key NOT LIKE 'f/%' AND fi.key NOT LIKE 't/%'");
  if (f.owner === "account") parts.push("EXISTS (SELECT 1 FROM user_files WHERE file_key = fi.key)");
  if (f.owner === "anonymous") parts.push("NOT EXISTS (SELECT 1 FROM user_files WHERE file_key = fi.key)");
  if (f.user) {
    parts.push("EXISTS (SELECT 1 FROM user_files WHERE file_key = fi.key AND user_id = ?)");
    args.push(f.user);
  }
  if (f.source) {
    parts.push("fi.source = ?");
    args.push(f.source);
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", args };
}

export async function listFiles(env: Env, f: FileFilter, offset: number, limit: number): Promise<{ total: number; bytes: number; files: FileRow[] }> {
  const w = fileWhere(f);
  const order = (t: string) =>
    f.sort === "old" ? `${t}.created_at ASC, ${t}.key` : f.sort === "big" ? `${t}.size DESC, ${t}.key` : `${t}.created_at DESC, ${t}.key`;
  const [totals, rows] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(fi.size), 0) AS bytes FROM file_index fi ${w.sql}`).bind(...w.args),
    env.DB.prepare(
      `SELECT p.key, p.size, p.type, p.name, p.source, p.sha256, p.created_at, p.expires_at, p.owner AS user_id, u.email AS user_email, u.name AS user_name
FROM (SELECT fi.*, ${OWNER} AS owner FROM file_index fi ${w.sql} ORDER BY ${order("fi")} LIMIT ? OFFSET ?) p
LEFT JOIN users u ON u.id = p.owner ORDER BY ${order("p")}`,
    ).bind(...w.args, limit, offset),
  ]);
  const t = (totals.results[0] ?? { n: 0, bytes: 0 }) as { n: number; bytes: number };
  return { total: t.n, bytes: t.bytes, files: rows.results as FileRow[] };
}

/** Totals of the whole index for the overview. */
export async function fileTotals(env: Env): Promise<Record<string, number>> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes,
SUM(CASE WHEN type LIKE 'video/%' THEN 1 ELSE 0 END) AS videos, COALESCE(SUM(CASE WHEN type LIKE 'video/%' THEN size END), 0) AS video_bytes,
SUM(CASE WHEN key LIKE 't/%' THEN 1 ELSE 0 END) AS temporary, COALESCE(SUM(CASE WHEN key LIKE 't/%' THEN size END), 0) AS temporary_bytes,
SUM(CASE WHEN key NOT LIKE 'f/%' AND key NOT LIKE 't/%' THEN 1 ELSE 0 END) AS legacy, COALESCE(SUM(CASE WHEN key NOT LIKE 'f/%' AND key NOT LIKE 't/%' THEN size END), 0) AS legacy_bytes,
(SELECT COUNT(DISTINCT file_key) FROM user_files) AS owned
FROM file_index`,
  ).first<Record<string, number | null>>();
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(row ?? {})) out[k] = v ?? 0;
  return out;
}

// ---- accounts ----

export interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  created_at: number;
  providers: string | null;
  passkeys: number;
  files: number;
  bytes: number;
  albums: number;
  tokens: number;
  admin_tokens: number;
  last_login: number | null;
}

const USER_COLUMNS = `u.id, u.email, u.name, u.created_at,
(SELECT group_concat(provider, ',') FROM identities WHERE user_id = u.id) AS providers,
(SELECT COUNT(*) FROM passkeys WHERE user_id = u.id) AS passkeys,
(SELECT COUNT(*) FROM user_files uf JOIN file_index fi ON fi.key = uf.file_key WHERE uf.user_id = u.id) AS files,
(SELECT COALESCE(SUM(fi.size), 0) FROM user_files uf JOIN file_index fi ON fi.key = uf.file_key WHERE uf.user_id = u.id) AS bytes,
(SELECT COUNT(*) FROM user_albums WHERE user_id = u.id) AS albums,
(SELECT COUNT(*) FROM api_tokens WHERE user_id = u.id) AS tokens,
(SELECT COUNT(*) FROM api_tokens WHERE user_id = u.id AND role = 'admin') AS admin_tokens,
(SELECT MAX(created_at) FROM sessions WHERE user_id = u.id) AS last_login`;

export async function listUsers(
  env: Env,
  q: string,
  sort: "new" | "files" | "bytes",
  offset: number,
  limit: number,
): Promise<{ total: number; users: UserRow[] }> {
  const where = q ? "WHERE u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.id = ?" : "";
  const args = q ? [likeAny(q.toLowerCase()), likeAny(q), q] : [];
  const order = sort === "files" ? "files DESC, u.created_at DESC" : sort === "bytes" ? "bytes DESC, u.created_at DESC" : "u.created_at DESC";
  const [total, rows] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).bind(...args),
    env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users u ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...args, limit, offset),
  ]);
  return { total: (total.results[0] as { n: number }).n, users: rows.results as UserRow[] };
}

export interface UserDetail {
  user: UserRow;
  identities: { provider: string; subject: string; email: string | null; created_at: number }[];
  passkeys: { id: string; name: string | null; created_at: number; last_used_at: number | null }[];
  sessions: { via: string; created_at: number; expires_at: number }[];
  tokens: { id: string; prefix: string; role: string; created_at: number; last_used_at: number | null; token_hash: string }[];
  albums: { id: string; title: string; created_at: number; n: number }[];
}

export async function getUserDetail(env: Env, id: string, now = Date.now()): Promise<UserDetail | null> {
  const [u, ids, pks, sess, toks, albums] = await env.DB.batch([
    env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`).bind(id),
    env.DB.prepare("SELECT provider, subject, email, created_at FROM identities WHERE user_id = ? ORDER BY created_at").bind(id),
    env.DB.prepare("SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at").bind(id),
    env.DB.prepare("SELECT via, created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC").bind(id, now),
    env.DB.prepare("SELECT id, prefix, role, created_at, last_used_at, token_hash FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC").bind(id),
    env.DB.prepare(
      "SELECT a.id, a.title, a.created_at, (SELECT COUNT(*) FROM album_files WHERE album_id = a.id) AS n FROM user_albums ua JOIN albums a ON a.id = ua.album_id WHERE ua.user_id = ? ORDER BY a.created_at DESC LIMIT 100",
    ).bind(id),
  ]);
  const user = u.results[0] as UserRow | undefined;
  if (!user) return null;
  return {
    user,
    identities: ids.results as UserDetail["identities"],
    passkeys: pks.results as UserDetail["passkeys"],
    sessions: sess.results as UserDetail["sessions"],
    tokens: toks.results as UserDetail["tokens"],
    albums: albums.results as UserDetail["albums"],
  };
}

/** Owner of a stored key, for the inspect page. */
export async function ownerOf(env: Env, key: string): Promise<{ id: string; email: string | null; name: string | null } | null> {
  return env.DB.prepare("SELECT u.id, u.email, u.name FROM user_files uf JOIN users u ON u.id = uf.user_id WHERE uf.file_key = ? LIMIT 1")
    .bind(key)
    .first<{ id: string; email: string | null; name: string | null }>();
}

export async function albumOwnerOf(env: Env, id: string): Promise<{ id: string; email: string | null; name: string | null } | null> {
  return env.DB.prepare("SELECT u.id, u.email, u.name FROM user_albums ua JOIN users u ON u.id = ua.user_id WHERE ua.album_id = ? LIMIT 1")
    .bind(id)
    .first<{ id: string; email: string | null; name: string | null }>();
}

/** Index rows of some keys, in the order given (missing ones left out), for album and account previews. */
export async function indexRows(env: Env, keys: string[]): Promise<FileRow[]> {
  const out = new Map<string, FileRow>();
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const { results } = await env.DB.prepare(
      `SELECT fi.*, NULL AS user_id, NULL AS user_email, NULL AS user_name FROM file_index fi WHERE fi.key IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .all<FileRow>();
    for (const r of results) out.set(r.key, r);
  }
  return keys.flatMap((k) => (out.has(k) ? [out.get(k)!] : []));
}

// ---- account actions ----

export async function revokeUserSessions(env: Env, userId: string, by: string): Promise<number> {
  const [r] = await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    await auditLog(env, "revoke_sessions", `user:${userId}`, null, { via: "web", by }),
  ]);
  return r.meta.changes;
}

export async function revokeUserToken(env: Env, userId: string, tokenId: string, by: string): Promise<boolean> {
  const [r] = await env.DB.batch([
    env.DB.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").bind(tokenId, userId),
    await auditLog(env, "revoke_token", `user:${userId}`, null, { via: "web", by, token: tokenId }),
  ]);
  return r.meta.changes > 0;
}

export async function setTokenRole(env: Env, userId: string, tokenId: string, role: "admin" | "user", by: string): Promise<boolean> {
  const [r] = await env.DB.batch([
    env.DB.prepare("UPDATE api_tokens SET role = ? WHERE id = ? AND user_id = ?").bind(role, tokenId, userId),
    await auditLog(env, "set_token_role", `user:${userId}`, null, { via: "web", by, token: tokenId, role }),
  ]);
  return r.meta.changes > 0;
}

// ---- albums ----

export interface AlbumRow {
  id: string;
  title: string;
  created_at: number;
  source: string;
  n: number;
  cover: string | null;
  user_id: string | null;
  user_email: string | null;
}

export async function listAlbums(env: Env, q: string, offset: number, limit: number): Promise<{ total: number; albums: AlbumRow[] }> {
  const where = q ? "WHERE a.title LIKE ? ESCAPE '\\' OR a.id = ?" : "";
  const args = q ? [likeAny(q), q.replace(/^.*\/a\//, "").replace(/^a\//, "")] : [];
  const [total, rows] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM albums a ${where}`).bind(...args),
    env.DB.prepare(
      `SELECT a.id, a.title, a.created_at, a.source,
(SELECT COUNT(*) FROM album_files WHERE album_id = a.id) AS n,
(SELECT file_key FROM album_files WHERE album_id = a.id ORDER BY position LIMIT 1) AS cover,
ua.user_id, u.email AS user_email
FROM albums a LEFT JOIN user_albums ua ON ua.album_id = a.id LEFT JOIN users u ON u.id = ua.user_id ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    ).bind(...args, limit, offset),
  ]);
  return { total: (total.results[0] as { n: number }).n, albums: rows.results as AlbumRow[] };
}

// ---- audit log ----

export interface LogRow {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  reason: string | null;
  detail: string | null;
}

export async function queryLog(
  env: Env,
  opts: { action: string; q: string; before: number | null; limit: number },
): Promise<{ entries: LogRow[]; actions: string[] }> {
  const parts: string[] = [];
  const args: unknown[] = [];
  if (opts.action) {
    parts.push("action = ?");
    args.push(opts.action);
  }
  if (opts.q) {
    parts.push("(target LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')");
    args.push(likeAny(opts.q), likeAny(opts.q), likeAny(opts.q));
  }
  if (opts.before !== null) {
    parts.push("id < ?");
    args.push(opts.before);
  }
  const [rows, actions] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM admin_log ${parts.length ? `WHERE ${parts.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).bind(...args, opts.limit),
    env.DB.prepare("SELECT DISTINCT action FROM admin_log ORDER BY action"),
  ]);
  return { entries: rows.results as LogRow[], actions: (actions.results as { action: string }[]).map((a) => a.action) };
}

// ---- overview ----

export interface DayPoint {
  day: string;
  uploads: number;
  bytes: number;
}

/** Site-wide uploads per UTC day for the last `days` days, oldest first, zeros for days without a row. */
export async function uploadSeries(env: Env, days: number, now = Date.now()): Promise<DayPoint[]> {
  const out: DayPoint[] = [];
  for (let i = days - 1; i >= 0; i--) out.push({ day: new Date(now - i * 86400e3).toISOString().slice(0, 10), uploads: 0, bytes: 0 });
  const { results } = await env.DB.prepare("SELECT day, uploads, bytes FROM usage_daily WHERE scope = 'global' AND day >= ?").bind(out[0].day).all<DayPoint>();
  const by = new Map(results.map((r) => [r.day, r]));
  return out.map((p) => by.get(p.day) ?? p);
}

/** New accounts per UTC day for the last `days` days, oldest first. */
export async function signupSeries(env: Env, days: number, now = Date.now()): Promise<{ day: string; n: number }[]> {
  const start = Date.parse(`${new Date(now - (days - 1) * 86400e3).toISOString().slice(0, 10)}T00:00:00Z`);
  const { results } = await env.DB.prepare(
    "SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day",
  )
    .bind(start)
    .all<{ day: string; n: number }>();
  const by = new Map(results.map((r) => [r.day, r.n]));
  const out: { day: string; n: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now - i * 86400e3).toISOString().slice(0, 10);
    out.push({ day, n: by.get(day) ?? 0 });
  }
  return out;
}

/** Server errors per hour for the last `hours` hours, oldest first. */
export async function errorSeries(env: Env, hours: number, now = Date.now()): Promise<{ hour: string; n: number }[]> {
  const out: { hour: string; n: number }[] = [];
  for (let i = hours - 1; i >= 0; i--) out.push({ hour: new Date(now - i * 3600e3).toISOString().slice(0, 13), n: 0 });
  const { results } = await env.DB.prepare("SELECT hour, count AS n FROM ops_counters WHERE name = '5xx' AND hour >= ?")
    .bind(out[0].hour)
    .all<{ hour: string; n: number }>();
  const by = new Map(results.map((r) => [r.hour, r.n]));
  return out.map((p) => ({ ...p, n: by.get(p.hour) ?? 0 }));
}

export async function siteCounts(env: Env, now = Date.now()): Promise<Record<string, number>> {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users) AS users,
(SELECT COUNT(*) FROM users WHERE created_at >= ?) AS users_7d,
(SELECT COUNT(*) FROM albums) AS albums,
(SELECT COUNT(*) FROM reports WHERE resolved_at IS NULL) AS open_reports,
(SELECT COUNT(*) FROM blocked_sources WHERE expires_at IS NULL OR expires_at > ?) AS blocked_sources,
(SELECT COUNT(*) FROM blocked_hashes) AS blocked_hashes,
(SELECT COUNT(*) FROM tombstones) AS tombstones,
(SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS sessions`,
  )
    .bind(now - 7 * 86400e3, now, now)
    .first<Record<string, number>>();
  return row ?? {};
}
