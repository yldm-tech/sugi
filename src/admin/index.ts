// The admin dashboard: a browser front end for the moderation, reports, operations and backup functions that the admin MCP tools already offer. Served on ADMIN_ORIGIN (a hostname of its own such as admin.sugi.moe, or /_admin on the main host), behind a session opened with an admin token (see auth.ts). Pages are plain HTML forms; every write answers with a redirect back and a one-time message.
import { restoreFromBackup } from "../backup";
import { hmacSha256Hex } from "../crypto";
import { HttpError, methodNotAllowed, randomNonce } from "../http";
import { blockSource, inspect, parseTarget, takedown, takedownBySource, takedownKeys, type TakedownResult, unblockContent, unblockSource } from "../moderation";
import { today } from "../quota";
import { resolveReport } from "../reports";
import { pickLang, readCookie } from "../site/i18n";
import { adminBase, adminCookie, assertAdminOrigin, closeAdminSession, openAdminSession, readAdminSession } from "./auth";
import { parseFileFilter, revokeUserSessions, revokeUserToken, setTokenRole } from "./data";
import type { Rendered } from "./pages/common";
import { albumsPage, filesPage } from "./pages/files";
import { blocksPage, inspectPage, logPage, reportsPage, sourcePage } from "./pages/moderation";
import { overviewPage } from "./pages/overview";
import { searchPage } from "./pages/search";
import { backupPage, loginPage, systemPage } from "./pages/system";
import { userPage, usersPage } from "./pages/users";
import { adminCsp, document, type Flash, href, type Nav, tr, type View } from "./view";

const FLASH_COOKIE = "sugi_admin_flash";
const LANG_COOKIE = "sugi_lang";

/** Where the dashboard is served for this request: the path below ADMIN_ORIGIN, or null when the request is not for the dashboard. A dedicated hostname takes every path on it; an origin with a path (/_admin) is matched on any host, like FILES_ORIGIN, which is how `wrangler dev` works. */
export function matchAdmin(env: Env, url: URL): string | null {
  if (!env.ADMIN_ORIGIN) return null;
  let o: URL;
  try {
    o = new URL(env.ADMIN_ORIGIN);
  } catch {
    return null;
  }
  const prefix = o.pathname.replace(/\/$/, "");
  if (prefix) return url.pathname === prefix || url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) || "/" : null;
  // Never take over the public site, even if ADMIN_ORIGIN is set to the main hostname by mistake.
  if (url.hostname === o.hostname && url.hostname !== new URL(env.MAIN_ORIGIN).hostname) return url.pathname;
  return null;
}

/** A path inside the dashboard to go back to after a write, from a form field; anything else falls back. */
function safeBack(raw: unknown, fallback: string): string {
  return typeof raw === "string" && /^\/[A-Za-z0-9/_?=&%.~:+,@-]*$/.test(raw) && !raw.startsWith("//") ? raw : fallback;
}

function readFlash(request: Request): Flash | null {
  const raw = readCookie(request.headers.get("cookie"), FLASH_COOKIE);
  if (!raw) return null;
  try {
    const f = JSON.parse(decodeURIComponent(raw)) as Flash;
    return typeof f.text === "string" ? { ok: Boolean(f.ok), text: f.text } : null;
  } catch {
    return null;
  }
}

function baseHeaders(): Headers {
  return new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    // Not no-referrer: under it browsers send "Origin: null" with form posts, and every write would fail the origin check. same-origin still tells other sites nothing.
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
  });
}

function redirect(env: Env, path: string, cookies: string[] = []): Response {
  const headers = baseHeaders();
  // A path, not a URL: the dashboard may be reached under another host in development.
  headers.set("location", `${adminBase(env).prefix}${path}`);
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

function flashCookie(env: Env, flash: Flash): string {
  return adminCookie(env, FLASH_COOKIE, encodeURIComponent(JSON.stringify({ ok: flash.ok, text: flash.text.slice(0, 1200) })), 60);
}

function render(request: Request, v: View, current: Nav, page: Rendered, cookies: string[] = []): Response {
  const headers = baseHeaders();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("content-security-policy", adminCsp(v.env, v.nonce));
  for (const c of cookies) headers.append("set-cookie", c);
  // The message has been shown; drop it.
  if (v.flash) headers.append("set-cookie", adminCookie(v.env, FLASH_COOKIE, "", 0));
  return new Response(request.method === "HEAD" ? null : document(v, current, page.title, page.main), { status: page.status ?? 200, headers });
}

async function form(request: Request): Promise<FormData> {
  const f = await request.formData().catch(() => null);
  if (!f) throw new HttpError(400, "expected a form");
  return f;
}

const str = (f: FormData, name: string): string => {
  const v = f.get(name);
  return typeof v === "string" ? v.trim() : "";
};

function takedownSummary(t: (zh: string, en: string) => string, r: Omit<TakedownResult, "target"> & { target?: string }): string {
  const lines: string[] = [];
  if (r.removed.length) lines.push(`${t("已下架", "Taken down")}: ${r.removed.join(", ")}`);
  if (r.already_removed.length) lines.push(`${t("之前已经下架", "Already removed")}: ${r.already_removed.join(", ")}`);
  if (r.blocked_hashes.length) lines.push(t(`已封禁 ${r.blocked_hashes.length} 个内容哈希`, `${r.blocked_hashes.length} content hash(es) blocked`));
  if (r.not_blocked_too_big?.length)
    lines.push(`${t("超过 20 MB，只下架未封禁内容", "Over 20 MB, taken down but not blocked")}: ${r.not_blocked_too_big.join(", ")}`);
  if (!r.cache_purged) lines.push(t("缓存没有清除成功，CDN 上可能还会保留一会儿。", "The cache purge failed; the CDN may keep serving it for a while."));
  return lines.join("\n") || t("没有需要处理的。", "Nothing to do.");
}

/** Runs one write and turns its outcome into the message shown after the redirect. Only HttpErrors (bad input, not found, conflicts) become messages; anything else is a server error. */
async function act(env: Env, back: string, fn: () => Promise<string>): Promise<Response> {
  try {
    return redirect(env, back, [flashCookie(env, { ok: true, text: await fn() })]);
  } catch (err) {
    if (!(err instanceof HttpError) || err.status >= 500) throw err;
    return redirect(env, back, [flashCookie(env, { ok: false, text: err.message })]);
  }
}

async function handleLogin(request: Request, env: Env, v: View): Promise<Response> {
  const f = await form(request);
  const next = safeBack(str(f, "next"), "/");
  const t = tr(v);
  // Tokens are long random strings, but guesses are still limited per address.
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.UPLOAD_LIMITER.limit({ key: `admin-login:${await hmacSha256Hex(env.IP_HASH_SECRET ?? "admin-login", ip)}` });
  if (!success) return render(request, v, "login", loginPage(v, t("尝试次数太多，一分钟后再试。", "Too many attempts; try again in a minute."), next));
  const cookie = await openAdminSession(env, str(f, "token"));
  if (!cookie) {
    const host = new URL(env.MAIN_ORIGIN).host;
    return render(request, v, "login", loginPage(v, t(`这不是 ${host} 的管理员令牌。`, `That is not an admin token of ${host}.`), next));
  }
  return redirect(env, next, [cookie]);
}

export async function handleAdmin(request: Request, env: Env, sub: string): Promise<Response> {
  const method = request.method;
  const url = new URL(request.url);
  if (sub === "/robots.txt")
    return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" } });
  const isGet = method === "GET" || method === "HEAD";
  if (!isGet && method !== "POST") throw methodNotAllowed("GET, HEAD, POST");
  if (method === "POST") assertAdminOrigin(request, env);

  const q = url.searchParams.get("lang");
  const lang = pickLang(q, readCookie(request.headers.get("cookie"), LANG_COOKIE), request.headers.get("accept-language"));
  const langCookie = q === "en" || q === "zh" ? [adminCookie(env, LANG_COOKIE, q, 31536000)] : [];
  const here = `${sub}${url.search}`;
  const session = await readAdminSession(request, env);
  const v: View = { env, lang, nonce: randomNonce(), who: session?.label ?? null, flash: readFlash(request), here };
  const t = tr(v);

  if (sub === "/login") {
    if (method === "POST") return handleLogin(request, env, { ...v, who: null });
    if (session) return redirect(env, safeBack(url.searchParams.get("next"), "/"), langCookie);
    return render(request, { ...v, who: null }, "login", loginPage(v, null, safeBack(url.searchParams.get("next"), "/")), langCookie);
  }
  if (!session) {
    if (!isGet) throw new HttpError(401, "sign in first");
    return redirect(env, `/login${sub === "/" ? "" : `?next=${encodeURIComponent(here)}`}`, langCookie);
  }

  if (method === "POST") {
    // Signing out needs no form fields, so it must not depend on a body.
    if (sub === "/logout") return redirect(env, "/login", [await closeAdminSession(env, session)]);
    const f = await form(request);
    const reason = str(f, "reason") || null;
    const report = /^\/reports\/(\d{1,12})$/.exec(sub);
    if (report) {
      const action = str(f, "action");
      if (action !== "takedown" && action !== "dismiss") throw new HttpError(400, "action must be takedown or dismiss");
      return act(env, safeBack(str(f, "back"), "/reports"), async () => {
        const r = await resolveReport(env, Number(report[1]), action, { note: str(f, "note") || null, blockContent: f.get("block_content") === "1" });
        const ids = (r.resolved_reports as number[]).map((n) => `#${n}`).join(", ");
        const head = action === "takedown" ? t(`已下架，处理了举报 ${ids}`, `Taken down; resolved ${ids}`) : t(`已驳回举报 ${ids}`, `Dismissed ${ids}`);
        const td = r.takedown as (TakedownResult & { already_gone?: boolean }) | null;
        if (!td) return head;
        if (td.already_gone) return `${head}\n${t("内容之前就不在了。", "It was already gone.")}`;
        return `${head}\n${takedownSummary(t, td)}`;
      });
    }
    if (sub === "/takedown") {
      const target = str(f, "target");
      return act(env, `/inspect?q=${encodeURIComponent(target)}`, async () =>
        takedownSummary(
          t,
          await takedown(env, target, { reason, blockContent: f.get("block_content") === "1", includeFiles: f.get("include_files") === "1", via: "web" }),
        ),
      );
    }
    if (sub === "/source/takedown") {
      const source = str(f, "source");
      return act(env, `/source?s=${encodeURIComponent(source)}`, async () => {
        if (!str(f, "confirm")) throw new HttpError(400, t("请先勾选确认。", "Tick the confirmation first."));
        const r = await takedownBySource(env, source, { dryRun: false, reason, blockContent: f.get("block_content") === "1", via: "web" });
        return t(
          `已下架 ${r.files} 个文件、${r.albums} 个相册${r.cache_purged ? "" : "；缓存没有清除成功"}`,
          `Took down ${r.files} file(s) and ${r.albums} album(s)${r.cache_purged ? "" : "; the cache purge failed"}`,
        );
      });
    }
    if (sub === "/source/block") {
      const source = str(f, "source");
      const hours = str(f, "hours") ? Number(str(f, "hours")) : null;
      return act(env, safeBack(str(f, "back"), "/blocks"), async () => {
        if (hours !== null && !(Number.isFinite(hours) && hours > 0 && hours <= 24 * 365))
          throw new HttpError(400, t("小时数要在 1 到 8760 之间。", "Hours must be between 1 and 8760."));
        const r = await blockSource(env, source, reason, hours);
        return r.expires_at
          ? t(`已禁止这个来源上传，到 ${r.expires_at}`, `Blocked until ${r.expires_at}`)
          : t("已禁止这个来源上传，直到解除", "Blocked until lifted");
      });
    }
    if (sub === "/source/unblock") {
      return act(env, safeBack(str(f, "back"), "/blocks"), async () =>
        (await unblockSource(env, str(f, "source"), reason)).unblocked
          ? t("已解除封禁", "Unblocked")
          : t("这个来源本来就没有被封禁", "That source was not blocked"),
      );
    }
    if (sub === "/content/unblock") {
      return act(env, safeBack(str(f, "back"), "/blocks"), async () =>
        (await unblockContent(env, str(f, "sha256"), reason)).unblocked
          ? t("已解除内容封禁", "Content unblocked")
          : t("这段内容本来就没有被封禁", "That content was not blocked"),
      );
    }
    if (sub === "/files/takedown") {
      const keys = [...new Set(f.getAll("key").filter((k): k is string => typeof k === "string" && FILE_KEY_RE.test(k)))];
      return act(env, safeBack(str(f, "back"), "/files"), async () => {
        if (!keys.length) throw new HttpError(400, t("先勾选要下架的文件。", "Select some files first."));
        if (keys.length > 200) throw new HttpError(400, t("一次最多 200 个。", "At most 200 at a time."));
        const target =
          keys.length === 1
            ? keys[0].startsWith("f/") || keys[0].startsWith("t/")
              ? `file:${keys[0].slice(2)}`
              : `legacy:${keys[0]}`
            : `files:${keys.length}`;
        return takedownSummary(t, await takedownKeys(env, keys, { reason, blockContent: f.get("block_content") === "1", via: "web" }, "takedown", target));
      });
    }
    const user = /^\/users\/([A-Za-z0-9_-]{1,64})\/(sessions\/revoke|takedown|tokens\/([A-Za-z0-9_-]{1,64})\/(revoke|role))$/.exec(sub);
    if (user) {
      const [, uid, what, tokenId, tokenAction] = user;
      const back = `/users/${uid}`;
      if (what === "sessions/revoke")
        return act(env, back, async () =>
          t(`已让 ${await revokeUserSessions(env, uid, session.label)} 个会话下线。`, `Ended ${await revokeUserSessions(env, uid, session.label)} session(s).`),
        );
      if (what === "takedown")
        return act(env, back, async () => {
          if (!str(f, "confirm")) throw new HttpError(400, t("请先勾选确认。", "Tick the confirmation first."));
          return takedownUser(env, t, uid, { reason, blockContent: f.get("block_content") === "1" });
        });
      return act(env, back, async () => {
        const token = await env.DB.prepare("SELECT token_hash FROM api_tokens WHERE id = ? AND user_id = ?").bind(tokenId, uid).first<{ token_hash: string }>();
        if (!token) throw new HttpError(404, t("没有这个令牌。", "No such token."));
        if (token.token_hash === session.tokenHash)
          throw new HttpError(400, t("不能修改当前登录所用的令牌。", "That is the token this session signed in with."));
        if (tokenAction === "revoke")
          return (await revokeUserToken(env, uid, tokenId, session.label)) ? t("已撤销令牌。", "Token revoked.") : t("没有这个令牌。", "No such token.");
        const role = str(f, "role");
        if (role !== "admin" && role !== "user") throw new HttpError(400, "role must be admin or user");
        await setTokenRole(env, uid, tokenId, role, session.label);
        return role === "admin" ? t("令牌已设为管理员。", "The token is now an admin token.") : t("令牌已降为普通令牌。", "The token is now a user token.");
      });
    }
    if (sub === "/sessions/end") {
      const id = str(f, "session");
      return act(env, "/system", async () => {
        if (id === session.idHash) throw new HttpError(400, t("要结束当前会话，请点退出。", "Use Sign out to end this session."));
        const r = await env.DB.prepare("DELETE FROM admin_sessions WHERE id_hash = ?").bind(id).run();
        return r.meta.changes ? t("已结束这个会话。", "Session ended.") : t("这个会话已经不在了。", "That session was already gone.");
      });
    }
    if (sub === "/backup/restore") {
      const raw = str(f, "keys");
      const keys = [
        ...new Set(
          raw
            .split(/\s+/)
            .map((k) => k.trim())
            .filter(Boolean),
        ),
      ];
      if (!keys.length || keys.length > 1000) throw new HttpError(400, "give between 1 and 1000 keys");
      const result = await restoreFromBackup(env, { keys, dryRun: f.get("dry_run") === "1", limit: keys.length });
      return render(request, { ...v, openReports: await openReports(env) }, "backup", await backupPage(v, { keys: keys.join("\n"), result }));
    }
    throw new HttpError(404, "not found");
  }

  const view = { ...v, openReports: await openReports(env) };
  const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
  let page: Rendered;
  let nav: Nav;
  const p = url.searchParams;
  const userMatch = /^\/users\/([A-Za-z0-9_-]{1,64})$/.exec(sub);
  if (userMatch) [page, nav] = [await userPage(view, userMatch[1], session.tokenHash), "users"];
  else
    switch (sub) {
      case "/": {
        const dayParam = p.get("day") ?? "";
        [page, nav] = [await overviewPage(view, /^\d{4}-\d{2}-\d{2}$/.test(dayParam) && dayParam <= today() ? dayParam : null), "overview"];
        break;
      }
      case "/files":
        [page, nav] = [await filesPage(view, parseFileFilter(p), offset), "files"];
        break;
      case "/albums":
        [page, nav] = [await albumsPage(view, (p.get("q") ?? "").trim().slice(0, 200), offset), "albums"];
        break;
      case "/users": {
        const sort = p.get("sort");
        [page, nav] = [await usersPage(view, (p.get("q") ?? "").trim().slice(0, 200), sort === "files" || sort === "bytes" ? sort : "new", offset), "users"];
        break;
      }
      case "/search": {
        const q = (p.get("q") ?? "").trim().slice(0, 300);
        // A link or id of a file or album that exists (or was taken down) opens its page.
        if (q && !/\s/.test(q) && (await namesSomething(env, q))) return redirect(env, `/inspect?q=${encodeURIComponent(q)}`, langCookie);
        [page, nav] = [await searchPage(view, q), "search"];
        break;
      }
      case "/reports": {
        const s = p.get("status");
        [page, nav] = [await reportsPage(view, s === "resolved" || s === "all" ? s : "open", offset), "reports"];
        break;
      }
      case "/inspect":
        [page, nav] = [await inspectPage(view, (p.get("q") ?? "").trim()), "files"];
        break;
      case "/source":
        [page, nav] = [await sourcePage(view, (p.get("s") ?? "").trim(), offset), "files"];
        break;
      case "/blocks":
        [page, nav] = [await blocksPage(view), "blocks"];
        break;
      case "/log": {
        const before = Number(p.get("before"));
        [page, nav] = [
          await logPage(view, {
            action: (p.get("action") ?? "").slice(0, 64),
            q: (p.get("q") ?? "").trim().slice(0, 200),
            before: Number.isSafeInteger(before) && before > 0 ? before : null,
          }),
          "log",
        ];
        break;
      }
      case "/system":
        [page, nav] = [await systemPage(view, session.idHash), "system"];
        break;
      case "/backup":
        [page, nav] = [await backupPage(view, null), "backup"];
        break;
      default:
        [page, nav] = [
          { title: "404", main: `<h1>404</h1><p><a href="${href(env, "/")}">${t("回到概览", "Back to the overview")}</a></p>`, status: 404 },
          "overview",
        ];
    }
  return render(request, view, nav, page, langCookie);
}

async function openReports(env: Env): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE resolved_at IS NULL").first<{ n: number }>())?.n ?? 0;
}

/** R2 keys a bulk takedown may name: f/<id>, t/<id> or a legacy key. */
const FILE_KEY_RE = /^(?:[ft]\/[A-Za-z0-9]{4,32}|[0-9a-f]{16}\.(?:png|jpg|webp|gif))$/;

/** The search box was given the link or id of a file or album this site has, or had. */
async function namesSomething(env: Env, q: string): Promise<boolean> {
  try {
    parseTarget(q);
  } catch {
    return false;
  }
  return (await inspect(env, q).catch(() => null))?.status !== "missing";
}

/** Takes down every file and album of an account, up to 1000 files per click. */
async function takedownUser(
  env: Env,
  t: (zh: string, en: string) => string,
  userId: string,
  opts: { reason: string | null; blockContent: boolean },
): Promise<string> {
  // Files already taken down stay in user_files; skip them so a second click continues where the first stopped.
  const files = (
    await env.DB.prepare(
      "SELECT file_key FROM user_files uf WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM tombstones WHERE target = 'file:' || substr(uf.file_key, 3)) LIMIT 1001",
    )
      .bind(userId)
      .all<{ file_key: string }>()
  ).results.map((r) => r.file_key);
  const more = files.length > 1000;
  const keys = files.slice(0, 1000);
  const done = keys.length ? await takedownKeys(env, keys, { ...opts, via: "web" }, "takedown_user", `user:${userId}`) : null;
  const albums = (await env.DB.prepare("SELECT album_id FROM user_albums WHERE user_id = ?").bind(userId).all<{ album_id: string }>()).results;
  let albumsDone = 0;
  for (const a of albums) {
    const r = await takedown(env, `a/${a.album_id}`, { ...opts, via: "web" }).catch((err) => {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    });
    if (r?.removed.length) albumsDone++;
  }
  const head = t(
    `已下架 ${done?.removed.length ?? 0} 个文件、${albumsDone} 个相册。`,
    `Took down ${done?.removed.length ?? 0} file(s) and ${albumsDone} album(s).`,
  );
  return [
    head,
    more ? t("还有更多文件，再点一次继续。", "There are more files; click again to continue.") : "",
    done && !done.cache_purged ? t("缓存没有清除成功。", "The cache purge failed.") : "",
  ]
    .filter(Boolean)
    .join("\n");
}
