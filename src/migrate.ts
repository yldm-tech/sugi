// Applies the D1 schema at runtime, so a one-click deploy (where nobody runs `wrangler d1 migrations apply`) works on its first request. It shares wrangler's own bookkeeping table, so migrations applied with wrangler are recognised and vice versa.
import m0001 from "../migrations/0001_albums.sql";
import m0002 from "../migrations/0002_moderation.sql";
import m0003 from "../migrations/0003_accounts.sql";
import m0004 from "../migrations/0004_e2e_inbox.sql";
import m0005 from "../migrations/0005_usage.sql";
import m0006 from "../migrations/0006_ops.sql";
import m0007 from "../migrations/0007_reports.sql";
import m0008 from "../migrations/0008_ops_state.sql";
import m0009 from "../migrations/0009_backup.sql";
import m0010 from "../migrations/0010_admin_sessions.sql";

// Every file in migrations/, in order; test/template.test.ts checks that none is missing.
export const MIGRATIONS: [string, string][] = [
  ["0001_albums.sql", m0001],
  ["0002_moderation.sql", m0002],
  ["0003_accounts.sql", m0003],
  ["0004_e2e_inbox.sql", m0004],
  ["0005_usage.sql", m0005],
  ["0006_ops.sql", m0006],
  ["0007_reports.sql", m0007],
  ["0008_ops_state.sql", m0008],
  ["0009_backup.sql", m0009],
  ["0010_admin_sessions.sql", m0010],
];

let ready: Promise<void> | null = null;

// The same table wrangler creates for `wrangler d1 migrations apply`.
const BOOKKEEPING =
  "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)";

// Splits a migration file into statements: drops comment lines, splits on semicolons at the end of a line.
export function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function run(db: D1Database): Promise<void> {
  await db.prepare(BOOKKEEPING).run();
  const { results } = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  const done = new Set(results.map((r) => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (done.has(name)) continue;
    try {
      await db.batch([...statements(sql).map((s) => db.prepare(s)), db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name)]);
    } catch (err) {
      // Another isolate may have applied it at the same moment; only give up if it is still missing.
      const again = await db.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").bind(name).first();
      if (!again) throw err;
    }
  }
}

/** Runs once per isolate; later calls reuse the same promise. A failure is retried on the next request. */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!ready)
    ready = run(db).catch((err) => {
      ready = null;
      throw err;
    });
  return ready;
}
