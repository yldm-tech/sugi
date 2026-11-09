// Markup for the admin dashboard: one server-rendered page per view, plain HTML forms, no scripts. Styles are inlined under the page's CSP nonce so the dashboard needs nothing from the main host; charts are inline SVG.
import { brand } from "../config";
import { esc, type Lang } from "../site/i18n";
import { LOGO } from "../site/svg";
import { adminBase } from "./auth";

export type Nav = "overview" | "files" | "albums" | "users" | "reports" | "inspect" | "blocks" | "log" | "system" | "backup" | "search" | "login";

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

export type T = (zh: string, en: string) => string;

export function tr(v: { lang: Lang }): T {
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
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(2)} TB`;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  return n.toLocaleString("en-US");
}

/** ISO time or epoch milliseconds as "2026-11-09 08:15 UTC"; a dash for none. */
export function fmtTime(when: string | number | null | undefined): string {
  if (when === null || when === undefined || when === "") return "–";
  const iso = typeof when === "number" ? new Date(when).toISOString() : when;
  return `<time datetime="${esc(iso)}">${esc(iso.slice(0, 16).replace("T", " "))}</time>`;
}

/** "3 分钟前" / "3 min ago", with the exact time as a tooltip. */
export function fmtAgo(t: T, when: string | number | null | undefined, now = Date.now()): string {
  if (when === null || when === undefined || when === "") return "–";
  const ms = typeof when === "number" ? when : Date.parse(when);
  const iso = new Date(ms).toISOString();
  const d = Math.round((now - ms) / 1000);
  const future = d < 0;
  const a = Math.abs(d);
  const [n, zh, en] =
    a < 60
      ? [a, "秒", "s"]
      : a < 3600
        ? [Math.round(a / 60), "分钟", "min"]
        : a < 86400
          ? [Math.round(a / 3600), "小时", "h"]
          : [Math.round(a / 86400), "天", "d"];
  const text = future ? t(`${n} ${zh}后`, `in ${n} ${en}`) : t(`${n} ${zh}前`, `${n} ${en} ago`);
  return `<time datetime="${esc(iso)}" title="${esc(iso.slice(0, 16).replace("T", " "))} UTC">${esc(text)}</time>`;
}

export function badge(text: string, kind: "ok" | "warn" | "bad" | "muted" | "info" = "muted"): string {
  return `<span class="badge ${kind}">${esc(text)}</span>`;
}

/** A form that posts to one of the dashboard's own paths. */
export function postForm(env: Env, path: string, inner: string, cls = "", id = ""): string {
  return `<form method="post" action="${esc(href(env, path))}"${cls ? ` class="${cls}"` : ""}${id ? ` id="${id}"` : ""}>${inner}</form>`;
}

export function hidden(name: string, value: string | number): string {
  return `<input type="hidden" name="${esc(name)}" value="${esc(String(value))}">`;
}

export function select(name: string, value: string, options: [string, string][], label: string): string {
  return `<label class="field"><span>${esc(label)}</span><select name="${esc(name)}">${options
    .map(([v, text]) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(text)}</option>`)
    .join("")}</select></label>`;
}

/** An image or video that stays blurred until clicked (no script: a checkbox inside the label). Uploaded content can be anything, so nothing is shown sharp by default. */
export function preview(v: View, url: string, type: string | null, cls = ""): string {
  const t = tr(v);
  const media = type?.startsWith("video/")
    ? `<video src="${esc(url)}#t=0.1" preload="metadata" muted playsinline controls></video>`
    : type?.startsWith("image/")
      ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : "";
  if (!media) return "";
  return `<label class="pv ${cls}"><input type="checkbox">${media}<span class="pv-hint">${t("点击显示", "Click to reveal")}</span></label>`;
}

/** A small thumbnail for grids and tables; blurred unless the page's "show previews" switch is on. */
export function thumb(url: string | null, type: string | null): string {
  if (!url) return `<span class="th none">${ICONS.file}</span>`;
  if (type?.startsWith("video/"))
    return `<span class="th"><video src="${esc(url)}#t=0.1" preload="metadata" muted playsinline></video><i class="play">${ICONS.play}</i></span>`;
  return `<span class="th"><img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
}

/** The switch that unblurs every thumbnail on a page; put it before the elements it controls, as their sibling. */
export function revealSwitch(t: T): { input: string; label: string } {
  return {
    input: `<input type="checkbox" id="reveal" class="reveal-all">`,
    label: `<label for="reveal" class="btn ghost small reveal-label"><span class="off">${t("显示预览", "Show previews")}</span><span class="on">${t("模糊预览", "Blur previews")}</span></label>`,
  };
}

export function stat(value: string, label: string, opts: { link?: string; sub?: string; tone?: "warn" | "bad" | "ok" } = {}): string {
  const inner = `<span class="stat-label">${label}</span><b>${value}</b>${opts.sub ? `<span class="stat-sub">${opts.sub}</span>` : ""}`;
  return opts.link
    ? `<a class="stat${opts.tone ? ` ${opts.tone}` : ""}" href="${esc(opts.link)}">${inner}</a>`
    : `<div class="stat${opts.tone ? ` ${opts.tone}` : ""}">${inner}</div>`;
}

/** A bar chart as inline SVG; each bar has its value as a tooltip. Labels under the chart show the first, middle and last point. */
export function barChart(points: { label: string; value: number; tip: string }[], fmt: (n: number) => string, tone = ""): string {
  const max = Math.max(1, ...points.map((p) => p.value));
  const w = 10;
  const gap = 3;
  const h = 100;
  const bars = points
    .map((p, i) => {
      const bh = p.value > 0 ? Math.max(1.5, (p.value / max) * h) : 0;
      return `<g><rect class="hit" x="${i * (w + gap)}" y="0" width="${w + gap}" height="${h}"></rect><rect class="bar${tone ? ` ${tone}` : ""}" x="${i * (w + gap)}" y="${(h - bh).toFixed(2)}" width="${w}" height="${bh.toFixed(2)}" rx="2"></rect><title>${esc(p.tip)}</title></g>`;
    })
    .join("");
  const mid = points[Math.floor(points.length / 2)];
  return `<div class="chart"><span class="chart-max">${esc(fmt(max))}</span><svg viewBox="0 0 ${points.length * (w + gap) - gap} ${h}" preserveAspectRatio="none" role="img">${bars}<line class="base" x1="0" y1="${h}" x2="${points.length * (w + gap)}" y2="${h}"></line></svg><div class="chart-x"><span>${esc(points[0]?.label ?? "")}</span><span>${esc(mid?.label ?? "")}</span><span>${esc(points.at(-1)?.label ?? "")}</span></div></div>`;
}

/** A horizontal share bar, e.g. images vs videos. */
export function shareBar(parts: { label: string; value: number; tone: string }[], fmt: (n: number) => string): string {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const segs = parts
    .filter((p) => p.value > 0)
    .map(
      (p) =>
        `<rect class="seg ${p.tone}" x="${((parts.slice(0, parts.indexOf(p)).reduce((a, q) => a + q.value, 0) / total) * 100).toFixed(3)}" y="0" width="${((p.value / total) * 100).toFixed(3)}" height="10"><title>${esc(p.label)}</title></rect>`,
    )
    .join("");
  const legend = parts
    .map(
      (p) =>
        `<li><i class="dot ${p.tone}"></i>${esc(p.label)} <b>${esc(fmt(p.value))}</b>${total ? ` <span class="muted">${Math.round((p.value / total) * 100)}%</span>` : ""}</li>`,
    )
    .join("");
  return `<div class="share">${total ? `<svg viewBox="0 0 100 10" preserveAspectRatio="none">${segs}</svg>` : `<div class="share-empty"></div>`}<ul>${legend}</ul></div>`;
}

/** Previous / next links for an offset-paged list. */
export function pager(v: View, path: string, query: Record<string, string | number | null | undefined>, offset: number, limit: number, total: number): string {
  const t = tr(v);
  if (total <= limit && offset === 0) return "";
  const from = total ? offset + 1 : 0;
  const to = Math.min(total, offset + limit);
  const prev =
    offset > 0
      ? `<a class="btn ghost small" href="${esc(href(v.env, path, { ...query, offset: Math.max(0, offset - limit) || null }))}">← ${t("上一页", "Previous")}</a>`
      : "";
  const next =
    offset + limit < total
      ? `<a class="btn ghost small" href="${esc(href(v.env, path, { ...query, offset: offset + limit }))}">${t("下一页", "Next")} →</a>`
      : "";
  return `<div class="pager"><span class="muted">${t(`第 ${from}–${to} 项，共 ${fmtNum(total)} 项`, `${from}–${to} of ${fmtNum(total)}`)}</span><span class="pager-btns">${prev}${next}</span></div>`;
}

export function empty(text: string): string {
  return `<div class="empty">${ICONS.empty}<p>${text}</p></div>`;
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

const svg = (body: string, size = 18) =>
  `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  overview: svg(
    '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  ),
  files: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M4 17l5-4.5 3.5 3 3-2.5L20 17"/>'),
  albums: svg('<rect x="6.5" y="7.5" width="14" height="12" rx="2"/><path d="M3.5 15.5v-9a2 2 0 0 1 2-2h11"/>'),
  users: svg(
    '<circle cx="9" cy="8.5" r="3.5"/><path d="M3 19.5c.8-3.2 3.2-5 6-5s5.2 1.8 6 5"/><path d="M16 5.5a3.2 3.2 0 0 1 0 6.2M18.5 14.8c1.3.8 2.2 2.4 2.5 4.7"/>',
  ),
  reports: svg('<path d="M5 20.5V4.5"/><path d="M5 4.5h11.5l-2 4 2 4H5"/>'),
  blocks: svg('<circle cx="12" cy="12" r="8.5"/><path d="M6 18L18 6"/>'),
  log: svg(
    '<path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11"/><circle cx="4.5" cy="6.5" r=".8"/><circle cx="4.5" cy="12" r=".8"/><circle cx="4.5" cy="17.5" r=".8"/>',
  ),
  system: svg(
    '<rect x="3.5" y="4" width="17" height="6.5" rx="1.8"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="1.8"/><path d="M7 7.2h.01M7 16.7h.01M11 7.2h6M11 16.7h6"/>',
  ),
  backup: svg(
    '<ellipse cx="12" cy="6" rx="7.5" ry="2.5"/><path d="M4.5 6v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V6"/><path d="M4.5 12v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6"/>',
  ),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>', 16),
  logout: svg('<path d="M14 4.5h4a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-4"/><path d="M10 16.5L5.5 12 10 7.5M5.5 12H15"/>', 16),
  file: svg('<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4"/>', 22),
  play: svg('<path d="M9 7.5v9l7.5-4.5z" fill="currentColor"/>', 16),
  external: svg('<path d="M14 4.5h5.5V10M19.5 4.5L11 13M17 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7H10"/>', 14),
  empty: svg('<rect x="3.5" y="6.5" width="17" height="13" rx="2.5"/><path d="M3.5 11.5h5l1.5 2h4l1.5-2h5"/><path d="M8 3.5l1 2M16 3.5l-1 2M12 2.5v3"/>', 28),
};

function navLink(v: View, path: string, id: Nav, current: Nav, icon: string, label: string, extra = ""): string {
  return `<a href="${esc(href(v.env, path))}"${id === current ? ' class="on" aria-current="page"' : ""}>${icon}<span>${label}</span>${extra}</a>`;
}

export function document(v: View, current: Nav, title: string, main: string): string {
  const t = tr(v);
  const b = brand(v.env);
  const other: Lang = v.lang === "zh" ? "en" : "zh";
  const [path, query = ""] = v.here.split("?");
  const q = new URLSearchParams(query);
  q.set("lang", other);
  const host = new URL(v.env.MAIN_ORIGIN).host;
  const testSite = v.env.NOINDEX === "1";
  const site = `<span class="site${testSite ? " test" : ""}" title="${esc(t("这里看到和改动的都是这个站点的数据", "Everything here is this site's data"))}"><i></i>${esc(host)}${testSite ? ` · ${t("测试站", "test site")}` : ""}</span>`;
  const lang = `<a class="lang" href="${esc(`${href(v.env, path)}?${q.toString()}`)}" hreflang="${other}">${other === "zh" ? "中文" : "English"}</a>`;
  const shell = v.who
    ? `<aside class="side">
<a class="brand" href="${esc(href(v.env, "/"))}">${LOGO}<span>${esc(b.siteName)}</span><span class="tag">admin</span></a>
${site}
<nav class="nav" aria-label="${esc(t("后台导航", "Dashboard"))}">
${navLink(v, "/", "overview", current, ICONS.overview, t("概览", "Overview"))}
<span class="group">${t("内容", "Content")}</span>
${navLink(v, "/files", "files", current, ICONS.files, t("文件", "Files"))}
${navLink(v, "/albums", "albums", current, ICONS.albums, t("相册", "Albums"))}
${navLink(v, "/users", "users", current, ICONS.users, t("用户", "Accounts"))}
<span class="group">${t("审核", "Moderation")}</span>
${navLink(v, "/reports", "reports", current, ICONS.reports, t("举报", "Reports"), v.openReports ? `<span class="count">${v.openReports}</span>` : "")}
${navLink(v, "/blocks", "blocks", current, ICONS.blocks, t("封禁", "Blocks"))}
${navLink(v, "/log", "log", current, ICONS.log, t("操作记录", "Audit log"))}
<span class="group">${t("系统", "System")}</span>
${navLink(v, "/system", "system", current, ICONS.system, t("状态", "Status"))}
${navLink(v, "/backup", "backup", current, ICONS.backup, t("备份", "Backup"))}
</nav>
<div class="me"><span class="who" title="${esc(t("当前登录所用的令牌", "Signed in with"))}">${esc(v.who)}</span>
<div class="me-row">${lang}${postForm(v.env, "/logout", `<button class="link">${ICONS.logout}${t("退出", "Sign out")}</button>`)}</div></div>
</aside>`
    : "";
  const top = v.who
    ? `<div class="topbar"><form method="get" action="${esc(href(v.env, "/search"))}" class="search" role="search">${ICONS.search}<input type="search" name="q" placeholder="${esc(
        t("搜索链接、id、文件名、邮箱、来源或 SHA-256", "Search links, ids, file names, emails, sources or SHA-256"),
      )}" aria-label="${esc(t("搜索", "Search"))}" value="${esc(current === "search" ? (q.get("q") ?? "") : "")}"></form></div>`
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
<body class="${v.who ? "app" : "bare"}">
${shell}
<div class="content">
${top}
<main>
${v.who ? "" : `<div class="bare-top">${site}${lang}</div>`}
${flash}
${main}
</main>
</div>
</body>
</html>
`;
}

const CSS = `
:root{--bg:#f5f4ee;--side:#fbfaf6;--card:#fff;--ink:#2f3a2d;--muted:#6d7868;--faint:#98a292;--line:#e4e8dc;--pale:#edf4e8;--pale2:#f4f7f0;--green:#5e9e6e;--green-dk:#47805a;--link:#3c7650;--danger:#b4534a;--danger-bg:#fbebe8;--warn:#94661a;--warn-bg:#fbf1dc;--info:#3d6f99;--info-bg:#e8f1f9;--violet:#7a62b0;--shadow:0 1px 2px rgba(40,50,35,.05),0 2px 10px rgba(40,50,35,.04);--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#181b17;--side:#1d211c;--card:#222721;--ink:#e3e8dc;--muted:#a3ad9c;--faint:#7c8676;--line:#353d32;--pale:#2b3529;--pale2:#262d24;--green:#5e9e6e;--green-dk:#78b886;--link:#9dd3a5;--danger:#e08a80;--danger-bg:#3d2522;--warn:#e3b66b;--warn-bg:#3a3020;--info:#8ab8e0;--info-bg:#1f2d3a;--violet:#b4a0e0;--shadow:none;color-scheme:dark}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink)}
body{font:14.5px/1.55 -apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif}
a{color:var(--link)}
code,.mono{font-family:var(--mono);font-size:12.5px;word-break:break-all}
.ic{flex:none;vertical-align:middle}
.app{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;overflow:auto;display:flex;flex-direction:column;gap:14px;padding:18px 14px;background:var(--side);border-right:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;color:var(--ink);text-decoration:none;font-weight:700;padding:0 6px}
.brand .logo{width:32px;height:29px}
.tag{font-size:11px;font-weight:700;color:#fff;background:var(--green-dk);border-radius:999px;padding:1px 8px;letter-spacing:.02em}
.site{display:flex;align-items:center;gap:7px;margin:0 6px;padding:5px 10px;border-radius:9px;background:var(--pale2);border:1px solid var(--line);font-size:12px;color:var(--muted);word-break:break-all}
.site i{flex:none;width:7px;height:7px;border-radius:50%;background:var(--green)}
.site.test{background:var(--warn-bg);border-color:transparent;color:var(--warn);font-weight:600}
.site.test i{background:var(--warn)}
.nav{display:flex;flex-direction:column;gap:2px}
.nav .group{margin:12px 10px 4px;font-size:11.5px;font-weight:600;color:var(--faint);letter-spacing:.04em}
.nav a{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:9px;color:var(--ink);text-decoration:none}
.nav a .ic{color:var(--muted)}
.nav a:hover{background:var(--pale2)}
.nav a.on{background:var(--pale);font-weight:600}
.nav a.on .ic{color:var(--green-dk)}
.count{margin-left:auto;min-width:20px;padding:0 6px;border-radius:999px;background:var(--danger);color:#fff;font-size:11.5px;font-weight:700;text-align:center}
.me{margin-top:auto;padding:12px 8px 0;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
.who{display:block;font-weight:600;color:var(--ink);word-break:break-all;margin-bottom:6px}
.me-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.me form{margin:0}
.content{min-width:0}
.topbar{position:sticky;top:0;z-index:5;padding:12px 28px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.search{display:flex;align-items:center;gap:8px;max-width:640px;padding:0 12px;border:1px solid var(--line);border-radius:11px;background:var(--card);color:var(--muted)}
.search input{flex:1;border:0;background:none;padding:9px 0;font:inherit;color:var(--ink);outline:none}
.search:focus-within{border-color:var(--green)}
main{max-width:1280px;padding:24px 28px 60px}
.bare main{max-width:none;padding:24px}
.bare-top{display:flex;justify-content:space-between;align-items:center;max-width:440px;margin:40px auto 0}
.bare-top .site{margin:0}
h1{font-size:22px;margin:0 0 4px}
.lede{color:var(--muted);margin:0 0 20px}
h2{font-size:15.5px;margin:0 0 12px}
.section{margin:26px 0 12px;display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.section h2{margin:0}
.muted{color:var(--muted)}
.small{font-size:12.5px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:0 0 14px;box-shadow:var(--shadow)}
.card>h2:first-child{margin-top:0}
.cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.cols3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.cols>.card,.cols3>.card{margin:0}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:12px;margin:0 0 14px}
.stat{display:flex;flex-direction:column;gap:2px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:13px 16px;color:inherit;text-decoration:none;box-shadow:var(--shadow)}
a.stat:hover{border-color:var(--green)}
.stat b{font-size:23px;line-height:1.25;font-variant-numeric:tabular-nums;font-weight:700}
.stat-label{color:var(--muted);font-size:12.5px}
.stat-sub{color:var(--faint);font-size:12px}
.stat.warn{background:var(--warn-bg);border-color:transparent}
.stat.warn b{color:var(--warn)}
.stat.bad{background:var(--danger-bg);border-color:transparent}
.stat.bad b{color:var(--danger)}
.flash{padding:10px 14px;border-radius:10px;margin:0 0 16px;white-space:pre-wrap}
.flash.ok{background:var(--pale)}
.flash.bad{background:var(--danger-bg);color:var(--danger)}
.note{padding:10px 14px;border-radius:10px;background:var(--info-bg);color:var(--info);margin:0 0 14px;font-size:13.5px}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11.5px;font-weight:600;background:var(--pale2);color:var(--muted);white-space:nowrap;border:1px solid var(--line)}
.badge.ok{background:var(--pale);color:var(--green-dk);border-color:transparent}
.badge.warn{background:var(--warn-bg);color:var(--warn);border-color:transparent}
.badge.bad{background:var(--danger-bg);color:var(--danger);border-color:transparent}
.badge.info{background:var(--info-bg);color:var(--info);border-color:transparent}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
thead th{color:var(--muted);font-weight:600;font-size:12.5px;white-space:nowrap;background:var(--pale2)}
thead th:first-child{border-top-left-radius:9px}
thead th:last-child{border-top-right-radius:9px}
tbody tr:hover{background:var(--pale2)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.kv th{width:150px;background:none;color:var(--muted);font-weight:500;font-size:13px}
.kv tbody tr:hover{background:none}
.scroll{overflow-x:auto}
.card.flush{padding:0;overflow:hidden}
.card.flush table th:first-child,.card.flush table td:first-child{padding-left:18px}
.card.flush table th:last-child,.card.flush table td:last-child{padding-right:18px}
form{margin:0}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}
.row+.row{margin-top:10px}
.filters{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px;margin:0 0 14px}
.field{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted)}
.field.grow{flex:1 1 260px}
input[type=text],input[type=search],input[type=password],input[type=number],input[type=date],select,textarea{font:inherit;font-size:14px;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:9px;padding:7px 10px;min-width:0}
input:focus,select:focus,textarea:focus{outline:2px solid color-mix(in srgb,var(--green) 40%,transparent);border-color:var(--green)}
input[type=password]{flex:1 1 280px}
input.reason{flex:1 1 240px}
input[type=number]{width:140px}
textarea{width:100%;min-height:110px;font-family:var(--mono);font-size:13px}
label.check{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:13.5px}
button,.btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13.5px;font-weight:600;border:0;border-radius:9px;padding:7px 14px;cursor:pointer;background:var(--green);color:#fff;text-decoration:none;white-space:nowrap}
button:hover,.btn:hover{background:var(--green-dk)}
button.danger,.btn.danger{background:var(--danger)}
button.danger:hover{filter:brightness(.93)}
button.ghost,.btn.ghost{background:var(--card);color:var(--ink);border:1px solid var(--line)}
button.ghost:hover,.btn.ghost:hover{background:var(--pale2)}
.small.btn,button.small{padding:4px 10px;font-size:12.5px}
button.link{background:none;color:var(--link);padding:0;font-weight:500;gap:4px}
button.link:hover{background:none;text-decoration:underline}
.pager{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;flex-wrap:wrap}
.pager-btns{display:flex;gap:8px}
.tabs{display:flex;gap:4px;margin:0 0 14px;padding:3px;background:var(--pale2);border:1px solid var(--line);border-radius:11px;width:max-content;max-width:100%;overflow:auto}
.tabs a{padding:5px 14px;border-radius:8px;text-decoration:none;color:var(--muted);white-space:nowrap}
.tabs a.on{background:var(--card);color:var(--ink);font-weight:600;box-shadow:var(--shadow)}
.empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:34px 10px;color:var(--faint);text-align:center}
.empty p{margin:0}
.report{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px}
.report .head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.details{white-space:pre-wrap;background:var(--pale2);border-radius:10px;padding:8px 12px;margin:8px 0}
.pv{position:relative;display:block;width:200px;height:156px;border-radius:12px;overflow:hidden;background:var(--pale2);cursor:pointer;border:1px solid var(--line)}
.pv.big{width:320px;height:250px}
.pv input{position:absolute;opacity:0;pointer-events:none}
.pv img,.pv video{width:100%;height:100%;object-fit:contain;filter:blur(18px);transition:filter .15s}
.pv input:checked~img,.pv input:checked~video{filter:none}
.pv-hint{position:absolute;inset:auto 0 0 0;padding:3px;font-size:12px;text-align:center;background:rgba(0,0,0,.45);color:#fff}
.pv input:checked~.pv-hint{display:none}
.pv input:focus-visible~.pv-hint{outline:2px solid var(--green)}
.th{position:relative;display:flex;align-items:center;justify-content:center;width:100%;aspect-ratio:1;border-radius:10px;overflow:hidden;background:var(--pale2);color:var(--faint)}
.th img,.th video{width:100%;height:100%;object-fit:cover;filter:blur(14px) saturate(.8);transform:scale(1.08);transition:filter .15s}
.th .play{position:absolute;right:6px;bottom:6px;display:flex;padding:3px;border-radius:50%;background:rgba(0,0,0,.55);color:#fff}
.reveal-all{position:absolute;opacity:0;pointer-events:none}
.reveal-all:checked~* .th img,.reveal-all:checked~* .th video{filter:none;transform:none}
.reveal-label .on{display:none}
.reveal-all:checked~* .reveal-label .on{display:inline}
.reveal-all:checked~* .reveal-label .off{display:none}
.reveal-all:focus-visible~* .reveal-label{outline:2px solid var(--green)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(156px,1fr));gap:12px}
.tile{position:relative;display:flex;flex-direction:column;gap:6px;background:var(--card);border:1px solid var(--line);border-radius:13px;padding:7px 7px 9px;box-shadow:var(--shadow);min-width:0}
.tile:has(.pick:checked){outline:2px solid var(--danger);border-color:transparent}
.tile a.cover{display:block;text-decoration:none}
.tile .pick{position:absolute;top:12px;left:12px;z-index:2;width:17px;height:17px;accent-color:var(--danger)}
.tile .meta{display:flex;flex-direction:column;gap:2px;padding:0 3px;font-size:12px;color:var(--muted);min-width:0}
.tile .name{font-size:13px;color:var(--ink);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tile .line{display:flex;justify-content:space-between;gap:6px;white-space:nowrap}
.tile .tags{display:flex;flex-wrap:wrap;gap:4px;position:absolute;top:12px;right:12px;z-index:2}
.tile .tags .badge{background:rgba(255,255,255,.9);border-color:transparent}
.thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px}
.thumbs a{display:block}
.mini{display:inline-block;width:40px;vertical-align:middle}
.mini .th{border-radius:7px}
.bulk{position:sticky;bottom:12px;z-index:4;display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;margin-top:16px;padding:10px 14px;background:var(--card);border:1px solid var(--line);border-radius:13px;box-shadow:0 6px 24px rgba(40,50,35,.12)}
.chart{position:relative;padding-top:18px}
.chart svg{display:block;width:100%;height:130px;overflow:visible}
.chart .bar{fill:var(--green)}
.chart .bar.info{fill:var(--info)}
.chart .bar.bad{fill:var(--danger)}
.chart .bar.violet{fill:var(--violet)}
.chart .hit{fill:transparent}
.chart g:hover .bar{opacity:.75}
.chart .base{stroke:var(--line);stroke-width:1}
.chart-max{position:absolute;top:0;left:0;font-size:11.5px;color:var(--faint)}
.chart-x{display:flex;justify-content:space-between;font-size:11.5px;color:var(--faint);margin-top:6px}
.share svg{display:block;width:100%;height:12px;border-radius:6px;overflow:hidden;background:var(--pale2)}
.share-empty{height:12px;border-radius:6px;background:var(--pale2)}
.share ul{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px}
.seg.green,.dot.green{fill:var(--green);background:var(--green)}
.seg.info,.dot.info{fill:var(--info);background:var(--info)}
.seg.warn,.dot.warn{fill:var(--warn);background:var(--warn)}
.seg.violet,.dot.violet{fill:var(--violet);background:var(--violet)}
.dot{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px}
.list{list-style:none;margin:0;padding:0}
.list li{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)}
.list li:last-child{border-bottom:0}
.list .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.health{display:inline-flex;align-items:center;gap:6px}
.health i{width:8px;height:8px;border-radius:50%;background:var(--green)}
.health.bad i{background:var(--danger)}
.danger-zone{border-color:color-mix(in srgb,var(--danger) 35%,var(--line))}
.danger-zone h2{color:var(--danger)}
.profile{display:flex;align-items:center;gap:14px}
.avatar{display:flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:50%;background:var(--pale);color:var(--green-dk);font-size:22px;font-weight:700;flex:none}
a.profile{color:inherit;text-decoration:none}
a.profile:hover b{color:var(--link)}
.avatar.small-avatar{width:34px;height:34px;font-size:15px}
.stat b.small-b{font-size:15px;font-weight:600;line-height:1.6}
h2 .ic{color:var(--muted)}
.login{max-width:440px;margin:16px auto}
.login p{color:var(--muted)}
.results h2{display:flex;align-items:center;gap:8px}
.gap{height:16px}
.card .section:first-child{margin-top:0}
@media (max-width:1000px){.cols,.cols3{grid-template-columns:1fr}}
@media (max-width:820px){.app{display:block}.side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;padding:10px 14px;border-right:0;border-bottom:1px solid var(--line)}.nav{flex-direction:row;flex-wrap:nowrap;overflow-x:auto;width:100%;order:3}.nav .group{display:none}.nav a{white-space:nowrap}.site{margin:0}.me{margin:0 0 0 auto;padding:0;border:0;display:flex;align-items:center;gap:12px}.who{display:none}.topbar{position:static;padding:10px 14px}main{padding:16px 14px 40px}.report{grid-template-columns:1fr}.kv th{width:100px}.grid{grid-template-columns:repeat(auto-fill,minmax(130px,1fr))}}
`;
