import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BACKUP_GRACE_MS, backupStatus, restoreFromBackup, runBackup } from "../src/backup";
import { takedown } from "../src/moderation";
import { call, upload } from "./helpers";

// Runs the cron step until both passes have gone through the whole bucket once.
async function fullPass(now = Date.now()) {
  const total = { copied: 0, dropped: 0, waiting: 0 };
  for (let i = 0; i < 50; i++) {
    const r = await runBackup(env, now);
    total.copied += r!.copied;
    total.dropped += r!.dropped;
    total.waiting += r!.waiting;
    const cur = await env.DB.prepare("SELECT value FROM ops_state WHERE name = 'backup_cursor'").first<{ value: string }>();
    const gc = await env.DB.prepare("SELECT value FROM ops_state WHERE name = 'backup_gc_cursor'").first<{ value: string }>();
    if (JSON.parse(cur!.value) === "" && JSON.parse(gc!.value) === "") break;
  }
  return total;
}

describe("backup", () => {
  it("is off without the BACKUP binding", async () => {
    expect(await runBackup({ ...env, BACKUP: undefined } as Env)).toBeNull();
    expect(await backupStatus({ ...env, BACKUP: undefined } as Env)).toEqual({ enabled: false });
  });

  it("copies permanent files once, and leaves temporary files out", async () => {
    const perm = await upload();
    const temp = await upload(undefined, "?expire=1h");
    await fullPass();
    const copy = await env.BACKUP!.head(`f/${perm.id}`);
    expect(copy?.customMetadata?.src_etag).toBe((await env.BUCKET.head(`f/${perm.id}`))!.etag);
    expect(await env.BACKUP!.head(`t/${temp.id}`)).toBeNull();
    // Nothing changed: the next pass copies nothing.
    expect((await fullPass()).copied).toBe(0);
  });

  it("drops a taken-down file from the backup at once and never restores it", async () => {
    const f = await upload();
    await fullPass();
    expect(await env.BACKUP!.head(`f/${f.id}`)).not.toBeNull();
    await takedown(env, f.page, { reason: "test" });
    expect(await env.BACKUP!.head(`f/${f.id}`)).toBeNull();
    const r = await restoreFromBackup(env, { keys: [`f/${f.id}`], dryRun: false, limit: 10 });
    expect(r.restored).toEqual([]);
  });

  it("keeps a deleted file's copy for the grace period, can restore it, and drops it afterwards", async () => {
    const f = await upload();
    await fullPass();
    const del = await call(new Request(`https://sugi.moe/api/files/${f.id}`, { method: "DELETE", headers: { "sugi-token": f.delete_token } }));
    expect(del.status).toBe(200);
    await fullPass();
    expect(await env.BACKUP!.head(`f/${f.id}`)).not.toBeNull();
    // Restore: dry run first, then for real; the link works again.
    const dry = await restoreFromBackup(env, { keys: [`f/${f.id}`], dryRun: true, limit: 10 });
    expect(dry.would_restore).toEqual([`f/${f.id}`]);
    expect(await env.BUCKET.head(`f/${f.id}`)).toBeNull();
    const done = await restoreFromBackup(env, { keys: [`f/${f.id}`], dryRun: false, limit: 10 });
    expect(done.restored).toEqual([`f/${f.id}`]);
    expect((await call(new Request(f.url))).status).toBe(200);
    // Deleted again and left alone: after the grace period the copy goes.
    await call(new Request(`https://sugi.moe/api/files/${f.id}`, { method: "DELETE", headers: { "sugi-token": f.delete_token } }));
    const now = Date.now();
    await fullPass(now);
    expect(await env.BACKUP!.head(`f/${f.id}`)).not.toBeNull();
    await fullPass(now + BACKUP_GRACE_MS + 1000);
    expect(await env.BACKUP!.head(`f/${f.id}`)).toBeNull();
  });
});
