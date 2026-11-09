import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { reindexStep } from "../src/fileindex";
import { sweepExpired } from "../src/files";
import { takedown } from "../src/moderation";
import { call, MAIN, png, upload } from "./helpers";

const row = (key: string) => env.DB.prepare("SELECT * FROM file_index WHERE key = ?").bind(key).first<Record<string, unknown>>();

async function fullPass(now = Date.now(), batch = 1000) {
  const total = { added: 0, updated: 0, removed: 0 };
  for (let i = 0; i < 100; i++) {
    const r = await reindexStep(env, now, batch);
    total.added += r.added;
    total.updated += r.updated;
    total.removed += r.removed;
    if (r.pass_done) return total;
  }
  throw new Error("no full pass");
}

describe("file index", () => {
  it("indexes uploads as they are stored, with name, source and content hash", async () => {
    const f = await upload(png(), "?name=cat.png");
    const r = await row(`f/${f.id}`);
    expect(r).toMatchObject({ size: f.size, type: "image/png", name: "cat.png", expires_at: null });
    expect(r!.source).toMatch(/^[0-9a-f]{64}$/);
    expect(r!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const t = await upload(png(), "?expire=1h");
    expect((await row(`t/${t.id}`))!.expires_at).toBe(Date.parse(t.expires_at!));
  });

  it("drops files that are deleted, taken down or expire", async () => {
    const a = await upload();
    const del = await call(new Request(`${MAIN}/api/files/${a.id}`, { method: "DELETE", headers: { "sugi-token": a.delete_token } }));
    expect(del.status).toBe(200);
    expect(await row(`f/${a.id}`)).toBeNull();

    const b = await upload();
    await takedown(env, b.id, { reason: "test" });
    expect(await row(`f/${b.id}`)).toBeNull();

    const c = await upload(png(), "?expire=1h");
    await sweepExpired(env, Date.now() + 2 * 3600e3);
    expect(await row(`t/${c.id}`)).toBeNull();
  });

  it("the cron brings in files it does not know, repairs changed rows and drops rows of vanished files", async () => {
    const keep = await upload(png(), "?name=keep.png");
    const missing = await upload();
    // A file stored before the index existed.
    await env.DB.prepare("DELETE FROM file_index WHERE key = ?").bind(`f/${missing.id}`).run();
    // A row that drifted.
    await env.DB.prepare("UPDATE file_index SET name = 'wrong', sha256 = NULL WHERE key = ?").bind(`f/${keep.id}`).run();
    // A row whose file is gone, old enough to be dropped, and one too new to be dropped yet.
    const old = Date.now() - 3600e3;
    await env.DB.prepare("INSERT INTO file_index (key, size, created_at) VALUES ('f/zzzzgone', 1, ?), ('f/zzzznew0', 1, ?)").bind(old, Date.now()).run();

    const r = await fullPass(Date.now(), 2);
    expect(r.added).toBeGreaterThanOrEqual(1);
    expect(r.updated).toBeGreaterThanOrEqual(1);
    expect(await row(`f/${missing.id}`)).toMatchObject({ type: "image/png" });
    expect((await row(`f/${keep.id}`))!.name).toBe("keep.png");
    expect(await row("f/zzzzgone")).toBeNull();
    expect(await row("f/zzzznew0")).not.toBeNull();
    // Nothing differs any more: a second pass writes nothing.
    expect(await fullPass(Date.now() + 3600e3, 2)).toEqual({ added: 0, updated: 0, removed: 1 });
    expect(await row("f/zzzznew0")).toBeNull();
    const pass = await env.DB.prepare("SELECT value FROM ops_state WHERE name = 'index_pass'").first<{ value: string }>();
    expect(JSON.parse(pass!.value).at).toMatch(/^\d{4}-/);
  });

  it("leaves tombstone markers and objects that are not files out", async () => {
    const f = await upload();
    await takedown(env, f.id, { reason: "x" });
    await env.BUCKET.put("healthz", "ok");
    await fullPass();
    expect(await row(`f/${f.id}`)).toBeNull();
    expect(await row("healthz")).toBeNull();
  });
});
