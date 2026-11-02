// Backup of the bucket to a second R2 bucket (the optional BACKUP binding; off when it is absent). The cron copies permanent files a small batch at a time, so each run stays far below the Worker CPU limit, and walks the whole bucket over and over with a cursor kept in ops_state. Temporary files are not backed up: they disappear within three days anyway.
//
// The backup follows the live bucket with a delay in one direction only: a file deleted by its owner (or by the account deletion) keeps its backup copy for BACKUP_GRACE_MS, so a mistake that deletes many files can be undone, and then the copy goes too. A takedown removes the backup copy at once (moderation.ts calls dropFromBackup), so removed content never survives in the backup.
import { HttpError } from "./http";
import { isTombstone } from "./moderation";
import { LEGACY_KEY_RE } from "./legacy";

/** Objects the copy pass looks at per cron run (and the clean-up pass checks). */
export const BACKUP_BATCH = 100;
/** How long a deleted file's backup copy is kept. */
export const BACKUP_GRACE_MS = 7 * 86400e3;

const isPermanent = (key: string) => key.startsWith("f/") || LEGACY_KEY_RE.test(key);

async function getState(env: Env, name: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT value FROM ops_state WHERE name = ?").bind(name).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as string) : undefined;
}

async function setState(env: Env, name: string, value: string | undefined, now: number): Promise<void> {
  await env.DB.prepare("INSERT INTO ops_state (name, value, at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, at = excluded.at")
    .bind(name, JSON.stringify(value ?? ""), now)
    .run();
}

/** Takedowns: the backup copy goes at once. */
export async function dropFromBackup(env: Env, keys: string[]): Promise<void> {
  if (!env.BACKUP || keys.length === 0) return;
  await env.BACKUP.delete(keys);
  await env.DB.prepare(`DELETE FROM backup_gone WHERE key IN (${keys.map(() => "?").join(",")})`)
    .bind(...keys)
    .run();
}

export interface BackupRun {
  copied: number;
  checked: number;
  dropped: number;
  /** Deleted from the live bucket, waiting out the grace period. */
  waiting: number;
}

/** One cron step: copy a batch of new or changed permanent files, and clean up a batch of copies whose original is gone. */
export async function runBackup(env: Env, now = Date.now()): Promise<BackupRun | null> {
  if (!env.BACKUP) return null;
  const run: BackupRun = { copied: 0, checked: 0, dropped: 0, waiting: 0 };

  // Copy pass over the live bucket.
  const cursor = (await getState(env, "backup_cursor")) || undefined;
  const page = await env.BUCKET.list({ limit: BACKUP_BATCH, cursor, include: ["customMetadata"] });
  for (const obj of page.objects) {
    if (!isPermanent(obj.key)) continue;
    run.checked++;
    if (isTombstone(obj)) {
      await dropFromBackup(env, [obj.key]);
      continue;
    }
    const copy = await env.BACKUP.head(obj.key);
    if (copy?.customMetadata?.src_etag === obj.etag) continue;
    const body = await env.BUCKET.get(obj.key);
    if (!body || !("body" in body)) continue;
    await env.BACKUP.put(obj.key, body.body, {
      httpMetadata: body.httpMetadata,
      customMetadata: { ...(body.customMetadata ?? {}), src_etag: body.etag, backed_up: new Date(now).toISOString() },
    });
    run.copied++;
  }
  await setState(env, "backup_cursor", page.truncated ? page.cursor : undefined, now);

  // Clean-up pass over the backup bucket: copies whose original is gone wait out the grace period, then go.
  const gcCursor = (await getState(env, "backup_gc_cursor")) || undefined;
  const copies = await env.BACKUP.list({ limit: BACKUP_BATCH, cursor: gcCursor });
  for (const obj of copies.objects) {
    const live = await env.BUCKET.head(obj.key);
    if (live && !isTombstone(live)) {
      await env.DB.prepare("DELETE FROM backup_gone WHERE key = ?").bind(obj.key).run();
      continue;
    }
    if (live && isTombstone(live)) {
      await dropFromBackup(env, [obj.key]);
      run.dropped++;
      continue;
    }
    const row = await env.DB.prepare("SELECT since FROM backup_gone WHERE key = ?").bind(obj.key).first<{ since: number }>();
    if (!row) {
      await env.DB.prepare("INSERT INTO backup_gone (key, since) VALUES (?, ?)").bind(obj.key, now).run();
      run.waiting++;
    } else if (now - row.since >= BACKUP_GRACE_MS) {
      await dropFromBackup(env, [obj.key]);
      run.dropped++;
    } else run.waiting++;
  }
  await setState(env, "backup_gc_cursor", copies.truncated ? copies.cursor : undefined, now);
  return run;
}

/** Admin: the backup's size and what is waiting to be dropped. */
export async function backupStatus(env: Env): Promise<Record<string, unknown>> {
  if (!env.BACKUP) return { enabled: false };
  let objects = 0;
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const page = await env.BACKUP.list({ limit: 1000, cursor });
    for (const o of page.objects) {
      objects++;
      bytes += o.size;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const gone = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(since) AS oldest FROM backup_gone").first<{ n: number; oldest: number | null }>();
  return {
    enabled: true,
    objects,
    bytes,
    deleted_waiting: gone?.n ?? 0,
    oldest_deleted_since: gone?.oldest ? new Date(gone.oldest).toISOString() : null,
    grace_days: BACKUP_GRACE_MS / 86400e3,
  };
}

/** Admin: copies files back from the backup. `keys` restores those keys; otherwise every backup copy whose original is missing (deleted, not taken down), up to `limit`. dry_run only lists them. A taken-down file is never restored. */
export async function restoreFromBackup(
  env: Env,
  opts: { keys?: string[]; dryRun: boolean; limit: number; cursor?: string },
): Promise<Record<string, unknown>> {
  if (!env.BACKUP) throw new HttpError(503, "no backup bucket is configured (BACKUP binding)");
  const candidates: string[] = [];
  let next: string | undefined;
  if (opts.keys?.length) candidates.push(...opts.keys);
  else {
    const page = await env.BACKUP.list({ limit: Math.min(1000, opts.limit), cursor: opts.cursor });
    candidates.push(...page.objects.map((o) => o.key));
    next = page.truncated ? page.cursor : undefined;
  }
  const restored: string[] = [];
  const skipped: { key: string; why: string }[] = [];
  for (const key of candidates) {
    const live = await env.BUCKET.head(key);
    if (live && isTombstone(live)) {
      skipped.push({ key, why: "taken down" });
      continue;
    }
    if (live) {
      skipped.push({ key, why: "present" });
      continue;
    }
    const copy = await env.BACKUP.get(key);
    if (!copy || !("body" in copy)) {
      skipped.push({ key, why: "not in backup" });
      continue;
    }
    if (opts.dryRun) {
      await copy.body.cancel();
      restored.push(key);
      continue;
    }
    const { src_etag, backed_up, ...meta } = copy.customMetadata ?? {};
    // onlyIf: never overwrite something that appeared in the meantime.
    const put = await env.BUCKET.put(key, copy.body, { httpMetadata: copy.httpMetadata, customMetadata: meta, onlyIf: { etagDoesNotMatch: "*" } });
    if (put) {
      restored.push(key);
      await env.DB.prepare("DELETE FROM backup_gone WHERE key = ?").bind(key).run();
    } else skipped.push({ key, why: "appeared meanwhile" });
  }
  return {
    dry_run: opts.dryRun,
    [opts.dryRun ? "would_restore" : "restored"]: restored,
    skipped: skipped.filter((s) => s.why !== "present").slice(0, 100),
    present: skipped.filter((s) => s.why === "present").length,
    next_cursor: next ?? null,
  };
}
