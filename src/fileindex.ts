// The file index (migrations/0011_file_index.sql): one D1 row per stored file, so the admin dashboard can show the newest uploads, filter them and search file names, none of which R2 can do (it lists keys in name order only). The upload, deletion, expiry, takedown and restore paths keep it current; reindexStep, run by the cron, walks the bucket one page at a time and repairs whatever differs, which also brings in files stored before the index existed.
import { LEGACY_KEY_RE } from "./legacy";
import { MEDIA_BY_EXT } from "./sniff";

/** Objects the cron compares with the index per run. */
export const INDEX_BATCH = 1000;
/** Rows younger than this are never dropped by the cron: the file may have been stored after the bucket page was listed. */
const SETTLE_MS = 10 * 60e3;

export interface IndexRow {
  key: string;
  size: number;
  type: string | null;
  name: string | null;
  source: string | null;
  sha256: string | null;
  created_at: number;
  expires_at: number | null;
}

/** Keys that are files: f/<id>, t/<id> and legacy <16 hex>.<ext>. Everything else in the bucket (tombstone markers aside, see rowOf) is not indexed. */
function isFileKey(key: string): boolean {
  return /^[ft]\/[A-Za-z0-9]+$/.test(key) || LEGACY_KEY_RE.test(key);
}

/** The index row of a stored object, or null for tombstone markers and objects that are not files. */
export function rowOf(key: string, obj: R2Object, sha256: string | null = null): IndexRow | null {
  if (!isFileKey(key)) return null;
  const m = obj.customMetadata ?? {};
  if (m.tomb === "1") return null;
  const ext = LEGACY_KEY_RE.test(key) ? key.slice(key.lastIndexOf(".") + 1) : (m.ext ?? "");
  const uploaded = Number(m.uploaded_ms) || Date.parse(m.uploaded ?? "") || obj.uploaded.getTime();
  return {
    key,
    size: obj.size,
    type: obj.httpMetadata?.contentType ?? MEDIA_BY_EXT[ext]?.mime ?? null,
    name: m.name ?? null,
    source: m.source ?? null,
    sha256: m.sha256 ?? sha256,
    created_at: uploaded,
    expires_at: m.expires ? Number(m.expires) : null,
  };
}

function upsert(env: Env, r: IndexRow): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO file_index (key, size, type, name, source, sha256, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (key) DO UPDATE SET size = excluded.size, type = excluded.type, name = excluded.name, source = excluded.source, sha256 = COALESCE(excluded.sha256, file_index.sha256), created_at = excluded.created_at, expires_at = excluded.expires_at`,
  ).bind(r.key, r.size, r.type, r.name, r.source, r.sha256, r.created_at, r.expires_at);
}

/** After a file is stored or restored. `sha256` is the content hash when the upload computed one (new-API files do not keep it in their metadata). */
export async function indexObject(env: Env, key: string, obj: R2Object, sha256: string | null = null): Promise<void> {
  const r = rowOf(key, obj, sha256);
  if (r) await upsert(env, r).run();
}

/** Statements that drop keys from the index, for callers that batch their own writes. */
export function unindexStatements(env: Env, keys: string[]): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    out.push(env.DB.prepare(`DELETE FROM file_index WHERE key IN (${chunk.map(() => "?").join(",")})`).bind(...chunk));
  }
  return out;
}

/** After files are deleted, expire or are taken down. */
export async function unindex(env: Env, keys: string[]): Promise<void> {
  const stmts = unindexStatements(env, keys);
  if (stmts.length) await env.DB.batch(stmts);
}

interface Cursor {
  cursor?: string;
  /** The last key of the previous page; this page covers the keys after it. */
  after?: string;
}

async function readCursor(env: Env): Promise<Cursor> {
  const row = await env.DB.prepare("SELECT value FROM ops_state WHERE name = 'index_cursor'").first<{ value: string }>();
  return row ? (JSON.parse(row.value) as Cursor) : {};
}

function writeState(env: Env, name: string, value: unknown, now: number): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO ops_state (name, value, at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, at = excluded.at").bind(
    name,
    JSON.stringify(value),
    now,
  );
}

const same = (a: IndexRow, b: IndexRow) =>
  a.size === b.size &&
  a.type === b.type &&
  a.name === b.name &&
  a.source === b.source &&
  a.created_at === b.created_at &&
  a.expires_at === b.expires_at &&
  (b.sha256 === null || a.sha256 === b.sha256);

export interface IndexRun {
  checked: number;
  added: number;
  updated: number;
  removed: number;
  /** This run finished a whole pass over the bucket. */
  pass_done: boolean;
}

/** One cron step: compares one page of the bucket with the index rows in the same key range and writes only the differences. Both sides are ordered by key (R2 lists in UTF-8 byte order, SQLite compares with BINARY), so the page's range is exact. */
export async function reindexStep(env: Env, now = Date.now(), batch = INDEX_BATCH): Promise<IndexRun> {
  const state = await readCursor(env);
  const page = await env.BUCKET.list({ limit: batch, cursor: state.cursor, include: ["customMetadata", "httpMetadata"] });
  const last = page.objects.at(-1)?.key;
  const after = state.after ?? "";
  const rows = (
    page.truncated && last !== undefined
      ? await env.DB.prepare("SELECT * FROM file_index WHERE key > ? AND key <= ?").bind(after, last).all<IndexRow>()
      : await env.DB.prepare("SELECT * FROM file_index WHERE key > ?").bind(after).all<IndexRow>()
  ).results;
  const have = new Map(rows.map((r) => [r.key, r]));
  const run: IndexRun = { checked: page.objects.length, added: 0, updated: 0, removed: 0, pass_done: !page.truncated };
  const stmts: D1PreparedStatement[] = [];
  const keep = new Set<string>();
  for (const obj of page.objects) {
    const want = rowOf(obj.key, obj);
    if (!want) continue;
    keep.add(obj.key);
    const got = have.get(obj.key);
    if (got && same(got, want)) continue;
    stmts.push(upsert(env, want));
    if (got) run.updated++;
    else run.added++;
  }
  const gone = rows.filter((r) => !keep.has(r.key) && r.created_at < now - SETTLE_MS).map((r) => r.key);
  stmts.push(...unindexStatements(env, gone));
  run.removed = gone.length;
  stmts.push(writeState(env, "index_cursor", page.truncated && last !== undefined ? { cursor: page.cursor, after: last } : {}, now));
  if (run.pass_done) stmts.push(writeState(env, "index_pass", { at: new Date(now).toISOString() }, now));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return run;
}

/** When the cron last finished a whole pass over the bucket; null until the first one. */
export async function lastIndexPass(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM ops_state WHERE name = 'index_pass'").first<{ value: string }>();
  return row ? ((JSON.parse(row.value) as { at: string }).at ?? null) : null;
}
