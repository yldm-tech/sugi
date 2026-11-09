// Markup for the admin dashboard: one server-rendered page per view, plain HTML forms, no scripts. Styles are inlined under the page's CSP nonce so the dashboard needs nothing from the main host.
import { brand } from "../config";
import { esc, type Lang } from "../site/i18n";
import { LOGO } from "../site/svg";
import { adminBase } from "./auth";

export type Nav = "overview" | "reports" | "inspect" | "blocks" | "log" | "backup" | "login";

export interface View {
  env: Env;
  lang: Lang;
  nonce: string;
  /** The signed-in session's label; null on the login page. */
  who: string | null;
  /** Open reports, shown as a badge in the navigation. */
  openReports?: number;
  flash?: Flash | null;
  /** Current path below the prefix and its query, for the language switch. */
  here: string;
}

export interface Flash {
  ok: boolean;
  text: string;
}

export function tr(v: { lang: Lang }): (zh: string, en: string) => string {
  return (zh, en) => (v.lang === "zh" ? zh : en);
}

/** A path inside the dashboard, e.g. href(env, "/reports") -> "/_admin/reports" when mounted on the main host. */
export function href(env: Env, path: string, query: Record<string, string | number | null | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, val] of Object.entries(query)) if (val !== null && val !== undefined && val !== "") q.set(k, String(val));
  const s = q.toString();
  return `${adminBase(env).prefix}${path}${s ? `?${s}` : ""}`;
}

export function fmtBytes(b: number | null | undefined): string {
  if (b === null || b === undefined) return "–";
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

/** ISO time as "2026-11-09 08:15 UTC"; a dash for none. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  return `<time datetime="${esc(iso)}">${esc(iso.slice(0, 16).replace("T", " "))} UTC</time>`;
}

export function badge(text: string, kind: "ok" | "warn" | "bad" | "muted" = "muted"): string {
  return `<span class="badge ${kind}">${esc(text)}</span>`;
}

/** A form that posts to one of the dashboard's own paths. */
export function postForm(env: Env, path: string, inner: string, cls = ""): string {
  return `<form method="post" action="${esc(href(env, path))}"${cls ? ` class="${cls}"` : ""}>${inner}</form>`;
}

export function hidden(name: string, value: string | number): string {
  return `<input type="hidden" name="${esc(name)}" value="${esc(String(value))}">`;
}

/** An image preview that stays blurred until clicked (no script: a checkbox inside the label). Reported content can be anything, so nothing is shown sharp by default. */
export function preview(v: View, url: string, type: string | null): string {
  const t = tr(v);
  if (type?.startsWith("video/"))
    return `<label class="pv"><input type="checkbox"><video src="${esc(url)}" preload="metadata" muted playsinline controls></video><span class="pv-hint">${t("点击显示", "Click to reveal")}</span></label>`;
  if (type?.startsWith("image/"))
    return `<label class="pv"><input type="checkbox"><img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="pv-hint">${t("点击显示", "Click to reveal")}</span></label>`;
  return "";
}

export function adminCsp(env: Env, nonce: string): string {
  const media = [env.FILES_ORIGIN, env.TMP_ORIGIN, env.MAIN_ORIGIN].map((o) => new URL(o).origin).join(" ");
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `img-src 'self' ${media}`,
    `media-src ${media}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function navLink(v: View, path: string, id: Nav, current: Nav, label: string, extra = ""): string {
  return `<a href="${esc(href(v.env, path))}"${id === current ? ' class="on" aria-current="page"' : ""}>${label}${extra}</a>`;
}

export function document(v: View, current: Nav, title: string, main: string): string {
  const t = tr(v);
  const b = brand(v.env);
  const other: Lang = v.lang === "zh" ? "en" : "zh";
  const [path, query = ""] = v.here.split("?");
  const q = new URLSearchParams(query);
  q.set("lang", other);
  const nav = v.who
    ? `<nav class="nav">
${navLink(v, "/", "overview", current, t("概览", "Overview"))}
${navLink(v, "/reports", "reports", current, t("举报", "Reports"), v.openReports ? ` <span class="count">${v.openReports}</span>` : "")}
${navLink(v, "/inspect", "inspect", current, t("查询", "Look up"))}
${navLink(v, "/blocks", "blocks", current, t("封禁", "Blocks"))}
${navLink(v, "/log", "log", current, t("操作记录", "Audit log"))}
${navLink(v, "/backup", "backup", current, t("备份", "Backup"))}
</nav>`
    : "";
  const session = v.who
    ? `<div class="who"><span title="${esc(t("当前登录所用的令牌", "Signed in with"))}">${esc(v.who)}</span>${postForm(v.env, "/logout", `<button class="link">${t("退出", "Sign out")}</button>`)}</div>`
    : "";
  const flash = v.flash ? `<p class="flash ${v.flash.ok ? "ok" : "bad"}" role="status">${esc(v.flash.text)}</p>` : "";
  return `<!doctype html>
<html lang="${v.lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · ${esc(b.siteName)} admin</title>
<style nonce="${v.nonce}">${CSS}</style>
</head>
<body>
<header class="top">
<a class="brand" href="${esc(href(v.env, "/"))}">${LOGO}<span>${esc(b.siteName)}</span><span class="tag">admin</span></a>
${nav}
<div class="side">${session}<a class="lang" href="${esc(`${href(v.env, path)}?${q.toString()}`)}" hreflang="${other}">${other === "zh" ? "中文" : "English"}</a></div>
</header>
<main>
${flash}
${main}
</main>
</body>
</html>
`;
}

const CSS = `
:root{--bg:#f6f4ea;--card:#fff;--ink:#3f4a3c;--muted:#6f7a69;--line:#e1e8d5;--pale:#eaf3e3;--green:#5e9e6e;--green-dk:#4a845a;--link:#3f7a50;--danger:#b4534a;--danger-bg:#fbeae7;--warn:#9a6a1c;--warn-bg:#fbf1dc;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#1d211c;--card:#262b25;--ink:#e3e8dc;--muted:#a3ad9c;--line:#3a4237;--pale:#2f382d;--green:#5e9e6e;--green-dk:#6fb07f;--link:#9dd3a5;--danger:#e08a80;--danger-bg:#3d2522;--warn:#e3b66b;--warn-bg:#3a3020;color-scheme:dark}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink)}
body{font:15px/1.55 -apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif}
a{color:var(--link)}
code,.mono{font-family:var(--mono);font-size:13px;word-break:break-all}
.top{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;padding:12px 24px;border-bottom:1px solid var(--line);background:var(--card)}
.brand{display:flex;align-items:center;gap:8px;color:var(--ink);text-decoration:none;font-weight:700}
.brand .logo{width:34px;height:31px}
.tag{font-size:12px;font-weight:600;color:var(--card);background:var(--green-dk);border-radius:999px;padding:1px 8px}
.nav{display:flex;flex-wrap:wrap;gap:4px}
.nav a{padding:6px 12px;border-radius:999px;color:var(--ink);text-decoration:none}
.nav a:hover{background:var(--pale)}
.nav a.on{background:var(--pale);font-weight:600}
.count{display:inline-block;min-width:20px;padding:0 6px;border-radius:999px;background:var(--danger);color:#fff;font-size:12px;text-align:center}
.side{margin-left:auto;display:flex;align-items:center;gap:14px;font-size:14px;color:var(--muted)}
.who{display:flex;align-items:center;gap:8px}
.who form{margin:0}
main{max-width:1180px;margin:0 auto;padding:24px}
h1{font-size:22px;margin:0 0 16px}
h2{font-size:17px;margin:28px 0 12px}
.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:0 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin:0 0 14px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.stat b{display:block;font-size:24px;line-height:1.2;font-variant-numeric:tabular-nums}
.stat span{color:var(--muted);font-size:13px}
.stat a{text-decoration:none;color:inherit}
.flash{padding:10px 14px;border-radius:10px;margin:0 0 16px;white-space:pre-wrap}
.flash.ok{background:var(--pale)}
.flash.bad{background:var(--danger-bg);color:var(--danger)}
.badge{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:600;background:var(--pale);color:var(--ink);white-space:nowrap}
.badge.ok{background:var(--pale);color:var(--green-dk)}
.badge.warn{background:var(--warn-bg);color:var(--warn)}
.badge.bad{background:var(--danger-bg);color:var(--danger)}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;white-space:nowrap}
.kv th{width:170px}
.scroll{overflow-x:auto}
form{margin:0}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.row+.row{margin-top:10px}
input[type=text],input[type=search],input[type=password],input[type=number],input[type=date],textarea{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:7px 11px;min-width:0}
input[type=search],input[type=password]{flex:1 1 320px}
input.reason{flex:1 1 260px}
input[type=number]{width:150px}
textarea{width:100%;min-height:110px;font-family:var(--mono);font-size:13px}
label.check{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
button{font:inherit;font-weight:600;border:0;border-radius:999px;padding:7px 16px;cursor:pointer;background:var(--green);color:#fff}
button:hover{background:var(--green-dk)}
button.danger{background:var(--danger)}
button.ghost{background:var(--pale);color:var(--ink)}
button.link{background:none;color:var(--link);padding:0;font-weight:400;text-decoration:underline}
.pager{display:flex;gap:12px;margin-top:12px}
.tabs{display:flex;gap:6px;margin:0 0 14px}
.tabs a{padding:5px 14px;border-radius:999px;text-decoration:none;color:var(--ink);border:1px solid var(--line)}
.tabs a.on{background:var(--pale);font-weight:600}
.report{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px}
.report .head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.details{white-space:pre-wrap;background:var(--bg);border-radius:10px;padding:8px 12px;margin:8px 0}
.pv{position:relative;display:block;width:180px;height:140px;border-radius:10px;overflow:hidden;background:var(--bg);cursor:pointer}
.pv input{position:absolute;opacity:0;pointer-events:none}
.pv img,.pv video{width:100%;height:100%;object-fit:contain;filter:blur(18px);transition:filter .15s}
.pv input:checked~img,.pv input:checked~video{filter:none}
.pv-hint{position:absolute;inset:auto 0 0 0;padding:3px;font-size:12px;text-align:center;background:rgba(0,0,0,.45);color:#fff}
.pv input:checked~.pv-hint{display:none}
.pv input:focus-visible~.pv-hint{outline:2px solid var(--green)}
.login{max-width:440px;margin:60px auto}
.login p{color:var(--muted)}
@media (max-width:640px){main{padding:16px}.top{padding:10px 16px}.side{margin-left:0}.report{grid-template-columns:1fr}.kv th{width:110px}}
`;
