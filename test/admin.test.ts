import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, freshIp, MAIN, upload } from "./helpers";

const ADMIN_HOST = "https://admin.sugi.moe";
const DEDICATED = { ADMIN_ORIGIN: ADMIN_HOST };
const TOKEN = "test-admin-token";

const get = (path: string, cookie = "", overrides: Partial<Env> = DEDICATED) =>
  call(new Request(`${ADMIN_HOST}${path}`, { headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } }), overrides);

const post = (path: string, fields: Record<string, string>, cookie = "", overrides: Partial<Env> = DEDICATED, origin: string | null = ADMIN_HOST) =>
  call(
    new Request(`${ADMIN_HOST}${path}`, {
      method: "POST",
      body: new URLSearchParams(fields),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": freshIp(),
        ...(origin ? { origin } : {}),
        ...(cookie ? { cookie } : {}),
      },
    }),
    overrides,
  );

/** Signs in and returns the session cookie ("sugi_admin=..."). */
async function signIn(token = TOKEN, overrides: Partial<Env> = DEDICATED): Promise<string> {
  const res = await post("/login", { token, next: "/" }, "", overrides);
  expect(res.status).toBe(303);
  const set = res.headers.get("set-cookie") ?? "";
  const m = /sugi_admin=([^;]+)/.exec(set);
  expect(m).not.toBeNull();
  return `sugi_admin=${m![1]}`;
}

/** The one-time message a write left for the next page. */
function flashOf(res: Response): { ok: boolean; text: string } {
  const m = /sugi_admin_flash=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  expect(m).not.toBeNull();
  return JSON.parse(decodeURIComponent(m![1]));
}

describe("admin dashboard", () => {
  it("asks for a token before anything else, and keeps out of search engines", async () => {
    const home = await get("/");
    expect(home.status).toBe(303);
    expect(home.headers.get("location")).toBe("/login");
    const deep = await get("/reports?status=all");
    expect(deep.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/reports?status=all")}`);
    const login = await get("/login");
    expect(login.status).toBe(200);
    expect(login.headers.get("x-robots-tag")).toContain("noindex");
    expect(login.headers.get("x-frame-options")).toBe("DENY");
    // no-referrer would make browsers post forms with "Origin: null", which the origin check refuses.
    expect(login.headers.get("referrer-policy")).toBe("same-origin");
    expect(login.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(login.headers.get("content-security-policy")).not.toContain("script-src");
    const html = await login.text();
    expect(html).toContain('type="password" name="token"');
    expect(html).not.toContain("<script");
    expect(await (await get("/robots.txt")).text()).toContain("Disallow: /");
  });

  it("signs in with ADMIN_TOKEN only, with a strict host-only cookie", async () => {
    const wrong = await post("/login", { token: "nope" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie") ?? "").not.toContain("sugi_admin=");
    const trusted = await post("/login", { token: "test-trusted-token" });
    expect(trusted.status).toBe(401);
    const ok = await post("/login", { token: TOKEN, next: "/blocks" });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/blocks");
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^sugi_admin=[A-Za-z0-9_-]{30,}; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict$/);
    expect(cookie).not.toContain("Domain");
    // Only the hash of the session id is stored.
    const id = /sugi_admin=([^;]+)/.exec(cookie)![1];
    expect(await env.DB.prepare("SELECT 1 FROM admin_sessions WHERE id_hash = ?").bind(id).first()).toBeNull();
    // An outside redirect target is ignored.
    const evil = await post("/login", { token: TOKEN, next: "//evil.example/" });
    expect(evil.headers.get("location")).toBe("/");
  });

  it("refuses writes from other sites", async () => {
    const cookie = await signIn();
    for (const origin of [null, "https://evil.example", MAIN]) {
      const res = await post("/source/block", { source: "a".repeat(64) }, cookie, DEDICATED, origin);
      expect(res.status).toBe(403);
    }
    expect(await env.DB.prepare("SELECT 1 FROM blocked_sources WHERE source = ?").bind("a".repeat(64)).first()).toBeNull();
    // Signed out, a write is refused rather than redirected.
    expect((await post("/source/block", { source: "a".repeat(64) })).status).toBe(401);
  });

  it("shows the overview and every page once signed in", async () => {
    const cookie = await signIn();
    const home = await get("/", cookie);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain("Overview");
    expect(html).toContain("ADMIN_TOKEN");
    expect(html).not.toContain("<script");
    for (const path of ["/reports", "/reports?status=all", "/inspect", "/blocks", "/log", "/backup", "/?storage=1"]) {
      const res = await get(path, cookie);
      expect(res.status, path).toBe(200);
    }
    expect((await get("/nope", cookie)).status).toBe(404);
    const zh = await call(new Request(`${ADMIN_HOST}/?lang=zh`, { headers: { cookie } }), DEDICATED);
    expect(await zh.text()).toContain("概览");
  });

  it("looks up a file and takes it down", async () => {
    const cookie = await signIn();
    const f = await upload();
    const page = await (await get(`/inspect?q=${encodeURIComponent(f.url)}`, cookie)).text();
    expect(page).toContain(f.url);
    expect(page).toContain("live");
    expect(page).toContain('action="/takedown"');
    const res = await post("/takedown", { target: f.id, reason: "spam from the dashboard", block_content: "1" }, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/inspect?q=${f.id}`);
    const flash = flashOf(res);
    expect(flash.ok).toBe(true);
    expect(flash.text).toContain(`f/${f.id}`);
    expect((await call(new Request(f.url))).status).toBe(451);
    const log = await env.DB.prepare("SELECT reason, detail FROM admin_log WHERE target = ? ORDER BY id DESC")
      .bind(`file:${f.id}`)
      .first<{ reason: string; detail: string }>();
    expect(log?.reason).toBe("spam from the dashboard");
    expect(JSON.parse(log!.detail).via).toBe("web");
    // The next page shows the message once and clears it.
    const after = await get(`/inspect?q=${f.id}`, `${cookie}; ${/sugi_admin_flash=[^;]+/.exec(res.headers.get("set-cookie")!)![0]}`);
    const text = await after.text();
    expect(text).toContain('class="flash ok"');
    expect(text).toContain("taken down");
    expect(after.headers.get("set-cookie")).toContain("sugi_admin_flash=; Path=/; Max-Age=0");
    // A second takedown is reported as a message, not an error page.
    const again = flashOf(await post("/takedown", { target: f.id }, cookie));
    expect(again.text).toContain("Already removed");
    const missing = flashOf(await post("/takedown", { target: "zzzzzzzz" }, cookie));
    expect(missing.ok).toBe(false);
  });

  it("resolves reports", async () => {
    const cookie = await signIn();
    const f = await upload();
    const sent = await call(
      new Request(`${MAIN}/api/reports`, {
        method: "POST",
        body: JSON.stringify({ target: f.page, reason: "spam", details: "<b>ads</b>" }),
        headers: { "content-type": "application/json", "cf-connecting-ip": freshIp() },
      }),
    );
    expect(sent.status).toBe(202);
    const row = await env.DB.prepare("SELECT id FROM reports WHERE target = ?").bind(`file:${f.id}`).first<{ id: number }>();
    const list = await (await get("/reports", cookie)).text();
    expect(list).toContain(`#${row!.id}`);
    expect(list).toContain("&#60;b&#62;ads&#60;/b&#62;");
    expect(list).not.toContain("<b>ads</b>");
    expect(list).toContain(`action="/reports/${row!.id}"`);
    // The reported image is previewed, blurred.
    expect(list).toContain(`<img src="${f.url}"`);
    const res = await post(`/reports/${row!.id}`, { action: "dismiss", note: "fine", back: "/reports" }, cookie);
    expect(res.status).toBe(303);
    expect(flashOf(res).text).toContain(`#${row!.id}`);
    const after = await env.DB.prepare("SELECT resolution, note FROM reports WHERE id = ?").bind(row!.id).first<{ resolution: string; note: string }>();
    expect(after).toEqual({ resolution: "dismissed", note: "fine" });
    expect((await call(new Request(f.url))).status).toBe(200);
    const twice = flashOf(await post(`/reports/${row!.id}`, { action: "dismiss" }, cookie));
    expect(twice.ok).toBe(false);
  });

  it("never previews content reported as CSAM", async () => {
    const cookie = await signIn();
    const f = await upload();
    await call(
      new Request(`${MAIN}/api/reports`, {
        method: "POST",
        body: JSON.stringify({ target: f.page, reason: "csam" }),
        headers: { "content-type": "application/json", "cf-connecting-ip": freshIp() },
      }),
    );
    const list = await (await get("/reports", cookie)).text();
    expect(list).not.toContain(f.url);
    expect(list).toContain("No preview for CSAM reports");
  });

  it("blocks and unblocks a source", async () => {
    const cookie = await signIn();
    const source = "b".repeat(64);
    const blocked = await post("/source/block", { source, reason: "flood", hours: "2", back: `/source?s=${source}` }, cookie);
    expect(blocked.headers.get("location")).toBe(`/source?s=${source}`);
    expect(flashOf(blocked).ok).toBe(true);
    const row = await env.DB.prepare("SELECT reason, expires_at FROM blocked_sources WHERE source = ?")
      .bind(source)
      .first<{ reason: string; expires_at: number }>();
    expect(row?.reason).toBe("flood");
    expect(row!.expires_at - Date.now()).toBeGreaterThan(3600e3);
    expect(await (await get("/blocks", cookie)).text()).toContain(`/source?s=${source}`);
    const bad = flashOf(await post("/source/block", { source, hours: "-1" }, cookie));
    expect(bad.ok).toBe(false);
    const un = await post("/source/unblock", { source, back: "/blocks" }, cookie);
    expect(un.headers.get("location")).toBe("/blocks");
    expect(await env.DB.prepare("SELECT 1 FROM blocked_sources WHERE source = ?").bind(source).first()).toBeNull();
  });

  it("takes down everything from a source only after the confirmation", async () => {
    const cookie = await signIn();
    const ip = freshIp();
    const uploads = [];
    for (let i = 0; i < 2; i++) {
      const res = await call(
        new Request(`${MAIN}/api/upload`, {
          method: "PUT",
          body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...crypto.getRandomValues(new Uint8Array(32))]),
          headers: { "cf-connecting-ip": ip, accept: "application/json" },
        }),
        { UPLOAD_TOKEN: "" },
      );
      expect(res.status).toBe(201);
      uploads.push(await res.json<{ id: string; url: string }>());
    }
    const source = (await env.BUCKET.head(`f/${uploads[0].id}`))!.customMetadata!.source;
    const page = await (await get(`/source?s=${source}`, cookie)).text();
    for (const u of uploads) expect(page).toContain(`f/${u.id}`);
    const unconfirmed = flashOf(await post("/source/takedown", { source }, cookie));
    expect(unconfirmed.ok).toBe(false);
    expect((await call(new Request(uploads[0].url))).status).toBe(200);
    const done = flashOf(await post("/source/takedown", { source, confirm: "2", reason: "spam run" }, cookie));
    expect(done.text).toContain("Took down 2 file(s)");
    for (const u of uploads) expect((await call(new Request(u.url))).status).toBe(451);
  });

  it("ends sessions when the token they were opened with stops being an admin token", async () => {
    const cookie = await signIn();
    expect((await get("/", cookie)).status).toBe(200);
    const rotated = await get("/", cookie, { ...DEDICATED, ADMIN_TOKEN: "a-new-admin-token" });
    expect(rotated.status).toBe(303);
    expect(rotated.headers.get("location")).toBe("/login");
    // The session row is gone, so it does not come back with the old token either.
    expect((await get("/", cookie)).status).toBe(303);
  });

  it("signs in with a personal token whose role is admin", async () => {
    const accounts = { ...DEDICATED, FEATURE_ACCOUNTS: "1", ACCOUNT_FEATURES: "email,tokens" };
    const userId = `u${crypto.randomUUID().slice(0, 11)}`;
    const token = `sugi_${crypto.randomUUID().replaceAll("-", "")}`;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, NULL, ?)").bind(userId, `${userId}@example.org`, Date.now()),
      env.DB.prepare("INSERT INTO api_tokens (id, user_id, token_hash, role, prefix, created_at) VALUES (?, ?, ?, 'user', ?, ?)").bind(
        userId.slice(0, 10),
        userId,
        hash,
        token.slice(0, 9),
        Date.now(),
      ),
    ]);
    expect((await post("/login", { token }, "", accounts)).status).toBe(401);
    await env.DB.prepare("UPDATE api_tokens SET role = 'admin' WHERE token_hash = ?").bind(hash).run();
    const cookie = await signIn(token, accounts);
    expect(await (await get("/", cookie, accounts)).text()).toContain(`${userId}@example.org`);
    // Revoking the token's role ends the session.
    await env.DB.prepare("UPDATE api_tokens SET role = 'user' WHERE token_hash = ?").bind(hash).run();
    expect((await get("/", cookie, accounts)).status).toBe(303);
  });

  it("signs out", async () => {
    const cookie = await signIn();
    const out = await post("/logout", {}, cookie);
    expect(out.status).toBe(303);
    expect(out.headers.get("set-cookie")).toContain("sugi_admin=; Path=/; Max-Age=0");
    expect((await get("/", cookie)).status).toBe(303);
  });

  it("lives only on its own host, and never takes over the public site", async () => {
    // On the admin host, public pages and the API do not exist.
    expect((await get("/faq")).headers.get("location")).toContain("/login");
    // On the main host, the dashboard is not reachable when it has a host of its own.
    expect((await call(new Request(`${MAIN}/_admin/login`, { headers: { accept: "text/html" } }), DEDICATED)).status).toBe(404);
    // ADMIN_ORIGIN set to the main host by mistake is ignored.
    const home = await call(new Request("https://sugi.moe/", { headers: { accept: "text/html" } }), { ADMIN_ORIGIN: "https://sugi.moe" });
    expect(home.status).toBe(200);
    expect(await home.text()).not.toContain('name="token"');
  });

  it("is served from /_admin on the main host without a host of its own", async () => {
    const res = await call(new Request(`${MAIN}/_admin`, { headers: { accept: "text/html" } }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/_admin/login");
    const login = await call(
      new Request(`${MAIN}/_admin/login`, {
        method: "POST",
        body: new URLSearchParams({ token: TOKEN }),
        headers: { "content-type": "application/x-www-form-urlencoded", origin: MAIN, "cf-connecting-ip": freshIp() },
      }),
    );
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/_admin/");
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toContain("Path=/_admin;");
    const home = await call(new Request(`${MAIN}/_admin/`, { headers: { cookie: /sugi_admin=[^;]+/.exec(cookie)![0] } }));
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('href="/_admin/reports"');
  });
});
