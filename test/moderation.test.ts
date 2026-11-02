import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN, call, freshIp, hmacHex, MAIN, png, TRUSTED, upload, UPLOAD_AUTH } from "./helpers";

const CLI_ON = { FEATURE_CLI: "1" };
const MiB = 1024 * 1024;

afterEach(() => {
  vi.restoreAllMocks();
});

let rpcId = 0;
async function rpc(method: string, params: unknown, headers: Record<string, string>): Promise<any> {
  const res = await call(
    new Request(`${MAIN}/mcp`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        "cf-connecting-ip": freshIp(),
        ...headers,
      },
    }),
    CLI_ON,
  );
  expect(res.status).toBe(200);
  return (await res.json<any>()).result ?? null;
}

async function admin(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await rpc("tools/call", { name, arguments: args }, ADMIN);
  const text = result.content[0].text as string;
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

const sha256 = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const put = (body: Uint8Array, headers: Record<string, string> = {}, query = "") =>
  call(new Request(`${MAIN}/api/upload${query}`, { method: "PUT", body, headers: { "cf-connecting-ip": freshIp(), accept: "application/json", ...headers } }));
const html = { accept: "text/html" };

describe("admin MCP tools", () => {
  it("are listed only for the admin token, and refused for everyone else", async () => {
    const names = async (headers: Record<string, string>) => ((await rpc("tools/list", {}, headers)).tools as { name: string }[]).map((t) => t.name);
    const adminTools = [
      "block_source",
      "inspect",
      "list_blocks",
      "list_by_source",
      "read_test_inbox",
      "takedown",
      "takedown_by_source",
      "takedown_log",
      "unblock_content",
      "unblock_source",
    ];
    for (const t of adminTools) expect(await names(ADMIN)).toContain(t);
    for (const headers of [{}, TRUSTED]) for (const t of adminTools) expect(await names(headers)).not.toContain(t);
    const refused = await rpc("tools/call", { name: "takedown", arguments: { target: "abcdefgh" } }, TRUSTED);
    expect(refused === null || refused.isError).toBe(true);
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }, ADMIN);
    expect(init.instructions).toContain("Handling an abuse report");
  });

  it("the admin token is never rate limited", async () => {
    const ip = freshIp();
    for (let i = 0; i < 15; i++) expect((await put(png(), { ...ADMIN, "cf-connecting-ip": ip })).status).toBe(201);
  });

  it("inspect, takedown with block_content, and every upload path refusing the same bytes", async () => {
    const bytes = png(800);
    const hash = await sha256(bytes);
    const ip = freshIp();
    const up = await (await put(bytes, { ...TRUSTED, "cf-connecting-ip": ip })).json<{ id: string; url: string; page: string }>();
    const album = await (
      await call(
        new Request(`${MAIN}/api/albums`, {
          method: "POST",
          body: JSON.stringify({ files: [up.id] }),
          headers: { "content-type": "application/json", accept: "application/json", "cf-connecting-ip": ip, ...TRUSTED },
        }),
      )
    ).json<{ id: string }>();

    const before = await admin("inspect", { target: up.url });
    expect(before).toMatchObject({
      kind: "file",
      id: up.id,
      status: "live",
      type: "image/png",
      size: 800,
      source: await hmacHex("test-ip-hash-secret", ip),
      albums: [album.id],
      takedown: null,
    });

    const done = await admin("takedown", { target: up.page, reason: "report #1", block_content: true });
    expect(done).toMatchObject({ target: `file:${up.id}`, removed: [`f/${up.id}`], blocked_hashes: [hash] });

    // 451 on the file host (a small page for browsers), the share page and the API, never indexed.
    const page = await call(new Request(up.url, { headers: html }));
    expect(page.status).toBe(451);
    expect(page.headers.get("x-robots-tag")).toBe("noindex");
    expect(page.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(await page.text()).toContain("removed after a report");
    expect((await call(new Request(up.page, { headers: html }))).status).toBe(451);
    expect((await call(new Request(`${MAIN}/api/files/${up.id}`))).status).toBe(451);
    await expect((await call(new Request(`${MAIN}/api/albums/${album.id}`))).json()).resolves.toMatchObject({ files: [] });

    const after = await admin("inspect", { target: up.id });
    expect(after).toMatchObject({ status: "taken_down", sha256: hash, content_blocked: true, takedown: { reason: "report #1" } });

    // The same bytes are refused everywhere: PUT, multipart POST, link import, upload links and the legacy endpoint.
    expect((await put(bytes, TRUSTED)).status).toBe(451);
    const form = new FormData();
    form.append("file", new File([bytes], "again.png"));
    expect((await call(new Request(`${MAIN}/api/upload`, { method: "POST", body: form, headers: { "cf-connecting-ip": freshIp(), ...TRUSTED } }))).status).toBe(
      451,
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(bytes, { headers: { "content-length": String(bytes.length) } }));
    const imported = new FormData();
    imported.append("url", "https://example.com/copy.png");
    expect(
      (await call(new Request(`${MAIN}/api/upload`, { method: "POST", body: imported, headers: { "cf-connecting-ip": freshIp(), ...TRUSTED } }))).status,
    ).toBe(451);
    vi.restoreAllMocks();
    const links = await (async () => {
      const r = await rpc("tools/call", { name: "create_upload", arguments: { count: 1 } }, ADMIN);
      return JSON.parse(r.content[0].text).links as { upload_url: string }[];
    })();
    expect((await call(new Request(links[0].upload_url.replace("https://sugi.moe", MAIN), { method: "PUT", body: bytes }))).status).toBe(451);
    expect((await call(new Request(`${MAIN}/upload`, { method: "PUT", body: bytes, headers: { "cf-connecting-ip": freshIp(), ...TRUSTED } }))).status).toBe(
      451,
    );

    // Lifting the block lets the bytes back in, under a new id.
    expect(await admin("unblock_content", { sha256: hash, reason: "test cleanup" })).toEqual({ sha256: hash, unblocked: true });
    const again = await (await put(bytes, TRUSTED)).json<{ id: string }>();
    expect(again.id).not.toBe(up.id);
  });

  it("files over the hashing cap are taken down without a content block", async () => {
    // Hashing a whole big file exceeds the Worker CPU limit in production, so the blocklist covers files up to 20 MB only.
    const big = png(21 * MiB);
    const up = await (await put(big, TRUSTED)).json<{ id: string; url: string }>();
    const r = await admin("takedown", { target: up.id, block_content: true });
    expect(r).toMatchObject({ removed: [`f/${up.id}`], blocked_hashes: [], not_blocked_too_big: [`f/${up.id}`] });
    expect((await call(new Request(up.url))).status).toBe(451);
    expect((await put(big, TRUSTED)).status).toBe(201);
  });

  it("takes albums down, optionally with their files", async () => {
    const a = await upload(png());
    const b = await upload(png());
    const make = async () =>
      (
        await (
          await call(
            new Request(`${MAIN}/api/albums`, {
              method: "POST",
              body: JSON.stringify({ files: [a.id, b.id] }),
              headers: { "content-type": "application/json", accept: "application/json", "cf-connecting-ip": freshIp(), ...TRUSTED },
            }),
          )
        ).json<{ id: string }>()
      ).id;
    const keep = await make();
    await admin("takedown", { target: `${MAIN}/a/${keep}` });
    expect((await call(new Request(`${MAIN}/a/${keep}`, { headers: html }))).status).toBe(451);
    expect((await call(new Request(`${MAIN}/api/albums/${keep}`))).status).toBe(451);
    expect((await call(new Request(a.url))).status).toBe(200);
    expect(await admin("inspect", { target: keep })).toMatchObject({ kind: "album", status: "taken_down" });

    const all = await make();
    const r = await admin("takedown", { target: `a/${all}`, include_files: true, reason: "spam album" });
    expect(r.removed.sort()).toEqual([`album:${all}`, `f/${a.id}`, `f/${b.id}`].sort());
    expect((await call(new Request(a.url))).status).toBe(451);
  });

  it("lists, takes down and blocks by source", async () => {
    const ip = freshIp();
    const mine = [await upload(png(), "", { "cf-connecting-ip": ip }), await upload(png(), "?expire=1h", { "cf-connecting-ip": ip })];
    const other = await upload(png());
    const source = await hmacHex("test-ip-hash-secret", ip);

    const listed = await admin("list_by_source", { source: mine[0].url, limit: 1 });
    expect(listed).toMatchObject({ source, total: 2, offset: 0, next_offset: 1 });
    expect(listed.items).toHaveLength(1);

    const dry = await admin("takedown_by_source", { source });
    expect(dry).toMatchObject({ dry_run: true, files: 2 });
    expect((await call(new Request(mine[0].url))).status).toBe(200);
    const real = await admin("takedown_by_source", { source, dry_run: false, reason: "spammer" });
    expect(real).toMatchObject({ dry_run: false, files: 2 });
    for (const m of mine) expect((await call(new Request(m.url))).status).toBe(451);
    expect((await call(new Request(other.url))).status).toBe(200);

    expect(await admin("block_source", { source, reason: "spammer", expires_in_hours: 1 })).toMatchObject({ source, blocked: true });
    const blocked = await put(png(), { ...UPLOAD_AUTH, "cf-connecting-ip": ip });
    expect(blocked.status).toBe(403);
    expect(await blocked.text()).toContain("not accepted from this network");
    expect((await put(png(), { ...TRUSTED, "cf-connecting-ip": ip })).status).toBe(201);
    expect((await admin("list_blocks", {})).sources).toContainEqual(expect.objectContaining({ source, active: true }));
    // Blocks with an expiry lapse on their own.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 3600 * 1000);
    expect((await put(png(), { ...UPLOAD_AUTH, "cf-connecting-ip": ip })).status).toBe(201);
    vi.restoreAllMocks();
    expect(await admin("unblock_source", { source })).toEqual({ source, unblocked: true });
    expect((await put(png(), { ...UPLOAD_AUTH, "cf-connecting-ip": ip })).status).toBe(201);
  });

  it("the HTTP admin DELETE is a takedown too, and everything lands in the audit log", async () => {
    const r = await upload(png());
    const res = await call(new Request(`${MAIN}/api/files/${r.id}?reason=http%20report`, { method: "DELETE", headers: ADMIN }));
    expect(res.status).toBe(200);
    expect((await call(new Request(r.url))).status).toBe(451);
    const log = await admin("takedown_log", { limit: 5 });
    expect(log.entries[0]).toMatchObject({ actor: "admin", action: "takedown", target: `file:${r.id}`, reason: "http report", detail: { via: "http" } });
    // A taken-down id is never handed out again: the marker keeps the key occupied.
    expect((await env.BUCKET.head(`f/${r.id}`))?.customMetadata?.tomb).toBe("1");
    // The owner's delete token no longer does anything.
    expect((await call(new Request(`${MAIN}/api/files/${r.id}`, { method: "DELETE", headers: { "sugi-token": r.delete_token } }))).status).toBe(404);
  });
});

describe("retention", () => {
  it("erases source fingerprints from takedown records and the log after 2 years, and drops expired source blocks", async () => {
    const { eraseOldFingerprints, SOURCE_RETENTION_MS } = await import("../src/moderation");
    const now = Date.now();
    const old = now - SOURCE_RETENTION_MS - 1000;
    const src = "a".repeat(64);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tombstones (target, reason, sha256, source, created_at) VALUES (?, ?, NULL, ?, ?)").bind(
        "file:oldoldol",
        "old report",
        src,
        old,
      ),
      env.DB.prepare("INSERT INTO tombstones (target, reason, sha256, source, created_at) VALUES (?, ?, NULL, ?, ?)").bind(
        "file:newnewne",
        "new report",
        src,
        now,
      ),
      env.DB.prepare("INSERT INTO admin_log (at, actor, action, target, reason, detail) VALUES (?, 'admin', 'block_source', ?, 'old', NULL)").bind(
        old,
        `source:${src}`,
      ),
      env.DB.prepare("INSERT INTO admin_log (at, actor, action, target, reason, detail) VALUES (?, 'admin', 'block_source', ?, 'new', NULL)").bind(
        now,
        `source:${src}`,
      ),
      env.DB.prepare("INSERT INTO blocked_sources (source, reason, expires_at, created_at) VALUES (?, 'lapsed', ?, ?)").bind("b".repeat(64), now - 1000, old),
      env.DB.prepare("INSERT INTO blocked_sources (source, reason, expires_at, created_at) VALUES (?, 'forever', NULL, ?)").bind("c".repeat(64), old),
    ]);
    const r = await eraseOldFingerprints(env, now);
    expect(r).toMatchObject({ tombstones: 1, log: 1, expired_blocks: 1 });
    const rows = (
      await env.DB.prepare("SELECT target, reason, source FROM tombstones WHERE target IN ('file:oldoldol', 'file:newnewne') ORDER BY target").all()
    ).results;
    expect(rows).toEqual([
      { target: "file:newnewne", reason: "new report", source: src },
      { target: "file:oldoldol", reason: "old report", source: null },
    ]);
    const log = (await env.DB.prepare("SELECT reason, target FROM admin_log WHERE reason IN ('old', 'new') ORDER BY reason").all()).results;
    expect(log).toEqual([
      { reason: "new", target: `source:${src}` },
      { reason: "old", target: "source:(erased)" },
    ]);
    const blocks = (await env.DB.prepare("SELECT reason FROM blocked_sources WHERE source IN (?, ?)").bind("b".repeat(64), "c".repeat(64)).all()).results;
    expect(blocks).toEqual([{ reason: "forever" }]);
    expect((await eraseOldFingerprints(env, now)).tombstones).toBe(0);
  });
});
