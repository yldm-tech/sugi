// The dashboard's views. Every number and list comes from the same functions the admin MCP tools use (moderation.ts, reports.ts, ops.ts, backup.ts), so both behave the same.
import { backupStatus } from "../backup";
import { findFile, publicUrl } from "../files";
import { HttpError } from "../http";
import { LEGACY_KEY_RE } from "../legacy";
import { inspect, listBlocks, listBySource, readLog } from "../moderation";
import { dailyNumbers } from "../ops";
import { quotas, today } from "../quota";
import { listReports } from "../reports";
import { esc } from "../site/i18n";
import { MEDIA_BY_EXT } from "../sniff";
import { badge, fmtBytes, fmtTime, hidden, href, postForm, preview, tr, type View } from "./view";

export interface Rendered {
  title: string;
  main: string;
  status?: number;
}

type T = (zh: string, en: string) => string;

const REASON_LABELS: Record<string, [string, string]> = {
  csam: ["儿童性虐待内容", "CSAM"],
  illegal: ["其他违法内容", "Illegal"],
  copyright: ["侵犯版权", "Copyright"],
  privacy: ["隐私信息", "Privacy"],
  spam: ["垃圾或诈骗", "Spam or fraud"],
  other: ["其他", "Other"],
};

function reasonBadge(t: T, reason: string): string {
  const [zh, en] = REASON_LABELS[reason] ?? [reason, reason];
  return badge(t(zh, en), reason === "csam" ? "bad" : reason === "illegal" ? "warn" : "muted");
}

function statusBadge(t: T, status: string): string {
  const map: Record<string, [string, string, "ok" | "warn" | "bad" | "muted"]> = {
    live: ["在线", "live", "ok"],
    expired: ["已过期", "expired", "muted"],
    taken_down: ["已下架", "taken down", "bad"],
    missing: ["不存在", "missing", "muted"],
  };
  const [zh, en, kind] = map[status] ?? [status, status, "muted"];
  return badge(t(zh, en), kind);
}

function lookupForm(v: View, q = ""): string {
  const t = tr(v);
  return `<form method="get" action="${esc(href(v.env, "/inspect"))}" class="row">
<input type="search" name="q" value="${esc(q)}" placeholder="${esc(t("文件 id、任意链接，或相册链接 /a/<id>", "File id, any link, or an album link /a/<id>"))}" aria-label="${esc(t("查询", "Look up"))}" required>
<button>${t("查询", "Look up")}</button>
</form>`;
}

function inspectLink(v: View, target: string, text = target): string {
  return `<a href="${esc(href(v.env, "/inspect", { q: target }))}">${esc(text)}</a>`;
}

function sourceLink(v: View, source: string): string {
  return `<a class="mono" href="${esc(href(v.env, "/source", { s: source }))}">${esc(`${source.slice(0, 16)}…`)}</a>`;
}

function logTable(v: View, entries: LogEntry[]): string {
  const t = tr(v);
  if (!entries.length) return `<p class="muted">${t("还没有记录。", "Nothing yet.")}</p>`;
  return `<div class="scroll"><table>
<thead><tr><th>${t("时间", "When")}</th><th>${t("操作", "Action")}</th><th>${t("对象", "Target")}</th><th>${t("原因", "Reason")}</th><th>${t("详情", "Detail")}</th></tr></thead>
<tbody>${entries
    .map(
      (e) =>
        `<tr><td>${fmtTime(e.at)}</td><td>${badge(e.action)}</td><td>${e.target ? targetCell(v, e.target) : "–"}</td><td>${e.reason ? esc(e.reason) : "–"}</td><td>${
          e.detail ? `<code>${esc(JSON.stringify(e.detail))}</code>` : "–"
        }</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

/** Audit-log and report targets ("file:<id>", "legacy:<key>", "album:<id>", "source:<hmac>", "sha256:<hex>") as links into the dashboard. */
function targetCell(v: View, target: string): string {
  const i = target.indexOf(":");
  const [kind, id] = [target.slice(0, i), target.slice(i + 1)];
  if (kind === "file" || kind === "legacy") return inspectLink(v, id, target);
  if (kind === "album") return inspectLink(v, `a/${id}`, target);
  if (kind === "source" && /^[0-9a-f]{64}$/.test(id)) return `source:${sourceLink(v, id)}`;
  return `<code>${esc(target)}</code>`;
}

interface LogEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  reason: string | null;
  detail: unknown;
}

// ---- overview ----

export async function overviewPage(v: View, day: string, storage: boolean): Promise<Rendered> {
  const t = tr(v);
  const n = await dailyNumbers(v.env, day, { storage });
  const cap = quotas(v.env).global;
  const log = (await readLog(v.env, 10)).entries as LogEntry[];
  const stat = (value: string, label: string, link?: string) =>
    `<div class="stat">${link ? `<a href="${esc(link)}">` : ""}<b>${value}</b><span>${label}</span>${link ? "</a>" : ""}</div>`;
  const num = (x: number | null) => (x === null ? "–" : String(x));
  const isToday = day === today();
  return {
    title: t("概览", "Overview"),
    main: `<h1>${t("概览", "Overview")}</h1>
<div class="card">${lookupForm(v)}</div>
<form method="get" action="${esc(href(v.env, "/"))}" class="row">
<label>${t("日期（UTC）", "Day (UTC)")} <input type="date" name="day" value="${esc(day)}" max="${today()}"></label>
<button class="ghost">${t("查看", "Show")}</button>
${isToday ? `<span class="muted">${t("今天到目前为止", "Today so far")}</span>` : ""}
</form>
<h2>${esc(day)}</h2>
<div class="grid">
${stat(num(n.uploads), t("上传", "Uploads"))}
${stat(fmtBytes(n.upload_bytes), cap ? t(`上传量（每日上限 ${fmtBytes(cap)}）`, `Uploaded (daily cap ${fmtBytes(cap)})`) : t("上传量", "Uploaded"))}
${stat(num(n.quota_rejections), t("超额拒绝", "Quota rejections"))}
${stat(num(n.server_errors), t("服务器错误（5xx）", "Server errors (5xx)"))}
${stat(num(n.cache_origin_errors), t("缓存回源错误", "Cache origin errors"))}
${stat(num(n.takedowns), t("下架", "Takedowns"))}
${stat(num(n.new_reports), t("新举报", "New reports"))}
${stat(num(n.open_reports), t("待处理举报", "Open reports"), href(v.env, "/reports"))}
${stat(num(n.login_emails), t("登录邮件", "Login emails"))}
${
  storage
    ? stat(`${num(n.storage_objects)} · ${fmtBytes(n.storage_bytes)}`, t("存储（对象 · 大小）", "Storage (objects · size)"))
    : `<div class="stat"><form method="get" action="${esc(href(v.env, "/"))}">${hidden("day", day)}${hidden("storage", 1)}<button class="ghost">${t("统计存储", "Count storage")}</button></form><span>${t("要列出整个存储桶，较慢", "Lists the whole bucket; slow")}</span></div>`
}
</div>
<h2>${t("最近的管理操作", "Recent admin actions")}</h2>
<div class="card">${logTable(v, log)}<p><a href="${esc(href(v.env, "/log"))}">${t("全部记录", "Whole log")} →</a></p></div>`,
  };
}

// ---- reports ----

interface ReportItem {
  id: number;
  target: string;
  link: string;
  reason: string;
  details: string | null;
  contact: string | null;
  created_at: string;
  emailed_at: string | null;
  open_reports_on_target: number;
  resolved_at: string | null;
  resolution: string | null;
  note: string | null;
}

/** The direct file link and type of a reported target, for the preview; null for albums, missing files and CSAM reports (never shown, not even blurred). */
async function reportPreview(env: Env, r: ReportItem): Promise<{ url: string; type: string } | null> {
  if (r.reason === "csam" || r.resolved_at) return null;
  const [kind, id] = [r.target.slice(0, r.target.indexOf(":")), r.target.slice(r.target.indexOf(":") + 1)];
  if (kind === "file") {
    const found = await findFile(env, id);
    return found ? { url: publicUrl(env, found.file), type: found.file.type.mime } : null;
  }
  if (kind === "legacy" && LEGACY_KEY_RE.test(id)) {
    const obj = await env.BUCKET.head(id);
    const type = MEDIA_BY_EXT[id.slice(id.lastIndexOf(".") + 1)];
    return obj && obj.size > 0 && type ? { url: `${env.MAIN_ORIGIN}/${id}`, type: type.mime } : null;
  }
  return null;
}

export async function reportsPage(v: View, status: "open" | "resolved" | "all", offset: number): Promise<Rendered> {
  const t = tr(v);
  const limit = 25;
  const data = (await listReports(v.env, status, offset, limit)) as { total: number; reports: ReportItem[] };
  const previews = await Promise.all(data.reports.map((r) => reportPreview(v.env, r)));
  const tab = (s: string, label: string) =>
    `<a href="${esc(href(v.env, "/reports", { status: s === "open" ? null : s }))}"${s === status ? ' class="on" aria-current="page"' : ""}>${label}</a>`;
  const back = `/reports${status === "open" ? "" : `?status=${status}`}`;
  const items = data.reports.map((r, i) => {
    const p = previews[i];
    const resolved = r.resolved_at
      ? `<p>${badge(r.resolution === "removed" ? t("已下架", "removed") : t("已驳回", "dismissed"), r.resolution === "removed" ? "bad" : "muted")} ${fmtTime(r.resolved_at)}${r.note ? ` · ${esc(r.note)}` : ""}</p>`
      : postForm(
          v.env,
          `/reports/${r.id}`,
          `${hidden("back", back)}<div class="row"><input class="reason" type="text" name="note" maxlength="500" placeholder="${esc(t("备注（会记录到操作记录）", "Note (goes into the audit log)"))}">
<label class="check"><input type="checkbox" name="block_content" value="1"${r.reason === "csam" ? " checked" : ""}> ${t("同时封禁相同内容", "Also block the same bytes")}</label></div>
<div class="row"><button class="danger" name="action" value="takedown">${t("下架", "Take down")}</button><button class="ghost" name="action" value="dismiss">${t("驳回", "Dismiss")}</button>${
            r.open_reports_on_target > 1
              ? `<span class="muted">${t(`会一并处理这个链接的 ${r.open_reports_on_target} 条举报`, `Settles all ${r.open_reports_on_target} open reports on this link`)}</span>`
              : ""
          }</div>`,
        );
    const where = r.target.startsWith("album:") ? `a/${r.target.slice(6)}` : r.target.slice(r.target.indexOf(":") + 1);
    return `<article class="card report">
<div>
<div class="head"><b>#${r.id}</b>${reasonBadge(t, r.reason)}<span class="muted">${fmtTime(r.created_at)}</span>${
      r.emailed_at ? "" : `<span class="muted">· ${t("还没发邮件", "not emailed yet")}</span>`
    }</div>
<p><a href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">${esc(r.link)}</a> · ${inspectLink(v, where, t("查看详情", "Inspect"))}</p>
${r.details ? `<div class="details">${esc(r.details)}</div>` : ""}
${r.contact ? `<p class="muted">${t("联系方式", "Contact")}: ${esc(r.contact)}</p>` : ""}
${resolved}
</div>
<div>${p ? preview(v, p.url, p.type) : r.reason === "csam" && !r.resolved_at ? `<p class="muted">${t("CSAM 举报不预览", "No preview for CSAM reports")}</p>` : ""}</div>
</article>`;
  });
  const pager = [
    offset > 0
      ? `<a href="${esc(href(v.env, "/reports", { status: status === "open" ? null : status, offset: Math.max(0, offset - limit) || null }))}">← ${t("上一页", "Newer")}</a>`
      : "",
    offset + limit < data.total
      ? `<a href="${esc(href(v.env, "/reports", { status: status === "open" ? null : status, offset: offset + limit }))}">${t("下一页", "Older")} →</a>`
      : "",
  ].join("");
  return {
    title: t("举报", "Reports"),
    main: `<h1>${t("举报", "Reports")}</h1>
<nav class="tabs">${tab("open", t("待处理", "Open"))}${tab("resolved", t("已处理", "Resolved"))}${tab("all", t("全部", "All"))}</nav>
<p class="muted">${t(`共 ${data.total} 条。CSAM 举报不显示预览，默认勾选封禁相同内容。`, `${data.total} in total. CSAM reports are never previewed and block the same bytes by default.`)}</p>
${items.length ? items.join("\n") : `<p class="card muted">${status === "open" ? t("没有待处理的举报。", "No open reports.") : t("没有举报。", "No reports.")}</p>`}
<div class="pager">${pager}</div>`,
  };
}

// ---- inspect ----

interface Inspected {
  kind: "file" | "legacy" | "album";
  id: string;
  key?: string | null;
  status: string;
  type?: string | null;
  size?: number | null;
  name?: string | null;
  title?: string | null;
  created_at: string | null;
  expires_at?: string | null;
  url?: string | null;
  source: string | null;
  source_blocked: boolean;
  sha256?: string | null;
  content_blocked?: boolean;
  albums?: string[];
  files?: string[];
  takedown: { reason: string | null; sha256: string | null; at: string | null } | null;
}

export async function inspectPage(v: View, q: string): Promise<Rendered> {
  const t = tr(v);
  const title = t("查询", "Look up");
  const head = `<h1>${title}</h1><div class="card">${lookupForm(v, q)}</div>`;
  if (!q) return { title, main: head };
  let info: Inspected;
  try {
    info = (await inspect(v.env, q)) as unknown as Inspected;
  } catch (err) {
    if (!(err instanceof HttpError) || err.status >= 500) throw err;
    return { title, main: `${head}<p class="flash bad">${esc(err.message)}</p>`, status: err.status };
  }
  const row = (k: string, val: string) => `<tr><th>${k}</th><td>${val}</td></tr>`;
  const rows = [
    row(t("类型", "Kind"), `${esc(info.kind)} <code>${esc(info.kind === "album" ? `a/${info.id}` : (info.key ?? info.id))}</code>`),
    row(t("状态", "Status"), statusBadge(t, info.status)),
    ...(info.kind === "album" ? [row(t("标题", "Title"), info.title ? esc(info.title) : "–")] : []),
    ...(info.kind !== "album"
      ? [
          row(t("格式", "Type"), info.type ? esc(info.type) : "–"),
          row(t("大小", "Size"), fmtBytes(info.size)),
          row(t("文件名", "Name"), info.name ? esc(info.name) : "–"),
        ]
      : []),
    row(t("上传时间", "Created"), fmtTime(info.created_at)),
    ...(info.kind !== "album" ? [row(t("过期时间", "Expires"), info.expires_at ? fmtTime(info.expires_at) : t("永久", "never"))] : []),
    ...(info.url ? [row(t("链接", "Link"), `<a href="${esc(info.url)}" target="_blank" rel="noopener noreferrer">${esc(info.url)}</a>`)] : []),
    ...(info.kind === "album" && info.status === "live"
      ? [
          row(
            t("链接", "Link"),
            `<a href="${esc(`${v.env.MAIN_ORIGIN}/a/${info.id}`)}" target="_blank" rel="noopener noreferrer">${esc(`${v.env.MAIN_ORIGIN}/a/${info.id}`)}</a>`,
          ),
        ]
      : []),
    row(
      t("来源", "Source"),
      info.source
        ? `${sourceLink(v, info.source)} ${info.source_blocked ? badge(t("已封禁", "blocked"), "bad") : ""}`
        : `<span class="muted">${t("没有记录", "not recorded")}</span>`,
    ),
    ...(info.sha256
      ? [row("SHA-256", `<code>${esc(info.sha256)}</code> ${info.content_blocked ? badge(t("内容已封禁", "content blocked"), "bad") : ""}`)]
      : []),
    ...(info.albums?.length ? [row(t("所在相册", "In albums"), info.albums.map((a) => inspectLink(v, `a/${a}`, a)).join(", "))] : []),
    ...(info.files ? [row(t("文件", "Files"), info.files.length ? info.files.map((f) => inspectLink(v, f)).join("<br>") : "–")] : []),
    ...(info.takedown ? [row(t("下架记录", "Takedown"), `${fmtTime(info.takedown.at)}${info.takedown.reason ? ` · ${esc(info.takedown.reason)}` : ""}`)] : []),
  ];
  const live = info.status === "live" || info.status === "expired";
  const actions = live
    ? `<h2>${t("下架", "Take down")}</h2><div class="card">${postForm(
        v.env,
        "/takedown",
        `${hidden("target", info.kind === "album" ? `a/${info.id}` : info.id)}
<div class="row"><input class="reason" type="text" name="reason" maxlength="500" placeholder="${esc(t("原因（会记录到操作记录）", "Reason (goes into the audit log)"))}"></div>
<div class="row"><label class="check"><input type="checkbox" name="block_content" value="1"> ${t("同时封禁相同内容（不超过 20 MB 的文件）", "Also block the same bytes (files up to 20 MB)")}</label>
${info.kind === "album" ? `<label class="check"><input type="checkbox" name="include_files" value="1"> ${t("连同相册里的文件一起下架", "Take down the files in it too")}</label>` : ""}</div>
<div class="row"><button class="danger">${t("下架", "Take down")}</button><span class="muted">${t("链接之后返回 451，id 不会再被使用。", "The link answers 451 from then on and the id is never reused.")}</span></div>`,
      )}</div>`
    : "";
  const unblock =
    info.sha256 && info.content_blocked
      ? `<h2>${t("解除内容封禁", "Unblock content")}</h2><div class="card">${postForm(
          v.env,
          "/content/unblock",
          `${hidden("sha256", info.sha256)}${hidden("back", `/inspect?q=${encodeURIComponent(q)}`)}<div class="row"><input class="reason" type="text" name="reason" maxlength="500" placeholder="${esc(t("原因", "Reason"))}"><button class="ghost">${t("解除", "Unblock")}</button></div>`,
        )}</div>`
      : "";
  const pv = info.status === "live" && info.url && info.type ? `<div>${preview(v, info.url, info.type)}</div>` : "";
  return {
    title,
    main: `${head}
<div class="card report"><div class="scroll"><table class="kv"><tbody>${rows.join("")}</tbody></table></div>${pv}</div>
${info.source ? `<p><a href="${esc(href(v.env, "/source", { s: info.source }))}">${t("同一来源的其他上传", "Everything from the same source")} →</a></p>` : ""}
${actions}${unblock}`,
  };
}

// ---- source ----

interface SourceItem {
  kind: "file" | "legacy" | "album";
  key: string;
  created_at: string | null;
  size: number | null;
  expires_at: string | null;
  name: string | null;
}

export async function sourcePage(v: View, s: string, offset: number): Promise<Rendered> {
  const t = tr(v);
  const title = t("来源", "Source");
  if (!s) return { title, main: `<h1>${title}</h1><p class="muted">${t("从查询结果进入。", "Open a source from a look-up.")}</p>` };
  let data: { source: string; source_blocked: boolean; total: number; already_taken_down: number; items: SourceItem[]; next_offset: number | null };
  try {
    data = (await listBySource(v.env, s, offset, 100)) as typeof data;
  } catch (err) {
    if (!(err instanceof HttpError) || err.status >= 500) throw err;
    return { title, main: `<h1>${title}</h1><p class="flash bad">${esc(err.message)}</p>`, status: err.status };
  }
  const back = `/source?s=${data.source}`;
  const items = data.items
    .map(
      (i) =>
        `<tr><td>${esc(i.kind)}</td><td>${inspectLink(v, i.key)}</td><td>${i.name ? esc(i.name) : "–"}</td><td>${fmtBytes(i.size)}</td><td>${fmtTime(i.created_at)}</td><td>${
          i.expires_at ? fmtTime(i.expires_at) : "–"
        }</td></tr>`,
    )
    .join("");
  const block = data.source_blocked
    ? postForm(
        v.env,
        "/source/unblock",
        `${hidden("source", data.source)}${hidden("back", back)}<div class="row">${badge(t("已封禁", "blocked"), "bad")}<input class="reason" type="text" name="reason" maxlength="500" placeholder="${esc(t("原因", "Reason"))}"><button class="ghost">${t("解除封禁", "Unblock")}</button></div>`,
      )
    : postForm(
        v.env,
        "/source/block",
        `${hidden("source", data.source)}${hidden("back", back)}<div class="row"><input class="reason" type="text" name="reason" maxlength="500" placeholder="${esc(t("原因", "Reason"))}">
<label>${t("小时数", "Hours")} <input type="number" name="hours" min="1" max="8760" placeholder="${esc(t("留空为永久", "empty: until lifted"))}"></label>
<button class="danger">${t("禁止这个来源上传", "Block uploads from this source")}</button></div>`,
      );
  const takedownAll = data.total
    ? postForm(
        v.env,
        "/source/takedown",
        `${hidden("source", data.source)}<div class="row"><input class="reason" type="text" name="reason" maxlength="500" placeholder="${esc(t("原因（会记录到操作记录）", "Reason (goes into the audit log)"))}">
<label class="check"><input type="checkbox" name="block_content" value="1"> ${t("同时封禁相同内容", "Also block the same bytes")}</label></div>
<div class="row"><label class="check"><input type="checkbox" name="confirm" value="${data.total}" required> ${t(`我已经看过下面这 ${data.total} 项`, `I have checked the ${data.total} items below`)}</label>
<button class="danger">${t(`全部下架（${data.total} 项）`, `Take down all ${data.total}`)}</button></div>`,
      )
    : "";
  const pager = [
    offset > 0 ? `<a href="${esc(href(v.env, "/source", { s: data.source, offset: Math.max(0, offset - 100) || null }))}">← ${t("上一页", "Newer")}</a>` : "",
    data.next_offset !== null ? `<a href="${esc(href(v.env, "/source", { s: data.source, offset: data.next_offset }))}">${t("下一页", "Older")} →</a>` : "",
  ].join("");
  return {
    title,
    main: `<h1>${title}</h1>
<div class="card"><p><code>${esc(data.source)}</code></p><p class="muted">${t(
      `来源是上传者 IP 的 HMAC，不能还原成 IP。共 ${data.total} 项在线，${data.already_taken_down} 项已下架。`,
      `A source is an HMAC of the uploader's IP and cannot be turned back into one. ${data.total} items up, ${data.already_taken_down} already taken down.`,
    )}</p>${block}</div>
${takedownAll ? `<h2>${t("全部下架", "Take down everything")}</h2><div class="card">${takedownAll}</div>` : ""}
<h2>${t("上传", "Uploads")}</h2>
<div class="card scroll"><table><thead><tr><th>${t("类型", "Kind")}</th><th>${t("键", "Key")}</th><th>${t("文件名", "Name")}</th><th>${t("大小", "Size")}</th><th>${t("上传时间", "Created")}</th><th>${t("过期", "Expires")}</th></tr></thead><tbody>${
      items || `<tr><td colspan="6" class="muted">${t("没有在线的上传。", "Nothing up.")}</td></tr>`
    }</tbody></table><div class="pager">${pager}</div></div>`,
  };
}

// ---- blocks ----

export async function blocksPage(v: View): Promise<Rendered> {
  const t = tr(v);
  const data = (await listBlocks(v.env, 500)) as {
    sources: { source: string; reason: string | null; expires_at: string | null; active: boolean; created_at: string }[];
    content: { sha256: string; target: string | null; reason: string | null; created_at: string }[];
  };
  const reasonInput = `<input class="reason" type="text" name="reason" maxlength="500" placeholder="${esc(t("原因", "Reason"))}">`;
  const sources = data.sources
    .map(
      (s) =>
        `<tr><td>${sourceLink(v, s.source)}</td><td>${s.reason ? esc(s.reason) : "–"}</td><td>${fmtTime(s.created_at)}</td><td>${
          s.expires_at ? fmtTime(s.expires_at) : t("永久", "until lifted")
        } ${s.active ? "" : badge(t("已过期", "expired"))}</td><td>${postForm(
          v.env,
          "/source/unblock",
          `${hidden("source", s.source)}${hidden("back", "/blocks")}<div class="row">${reasonInput}<button class="ghost">${t("解除", "Unblock")}</button></div>`,
        )}</td></tr>`,
    )
    .join("");
  const content = data.content
    .map(
      (c) =>
        `<tr><td><code>${esc(c.sha256)}</code></td><td>${c.target ? targetCell(v, c.target) : "–"}</td><td>${c.reason ? esc(c.reason) : "–"}</td><td>${fmtTime(c.created_at)}</td><td>${postForm(
          v.env,
          "/content/unblock",
          `${hidden("sha256", c.sha256)}${hidden("back", "/blocks")}<div class="row">${reasonInput}<button class="ghost">${t("解除", "Unblock")}</button></div>`,
        )}</td></tr>`,
    )
    .join("");
  const empty = (n: number) => `<tr><td colspan="${n}" class="muted">${t("没有。", "None.")}</td></tr>`;
  return {
    title: t("封禁", "Blocks"),
    main: `<h1>${t("封禁", "Blocks")}</h1>
<h2>${t("禁止上传的来源", "Sources blocked from uploading")}</h2>
<div class="card scroll"><table><thead><tr><th>${t("来源", "Source")}</th><th>${t("原因", "Reason")}</th><th>${t("时间", "Since")}</th><th>${t("到期", "Until")}</th><th></th></tr></thead><tbody>${sources || empty(5)}</tbody></table></div>
<h2>${t("封禁的内容（SHA-256）", "Blocked content (SHA-256)")}</h2>
<div class="card scroll"><table><thead><tr><th>SHA-256</th><th>${t("来自", "From")}</th><th>${t("原因", "Reason")}</th><th>${t("时间", "Since")}</th><th></th></tr></thead><tbody>${content || empty(5)}</tbody></table></div>`,
  };
}

// ---- log ----

export async function logPage(v: View, limit: number): Promise<Rendered> {
  const t = tr(v);
  const entries = (await readLog(v.env, limit)).entries as LogEntry[];
  return {
    title: t("操作记录", "Audit log"),
    main: `<h1>${t("操作记录", "Audit log")}</h1>
<p class="muted">${t(`最近 ${entries.length} 条管理操作，新的在前。网页、MCP 和 HTTP 接口的操作都记在这里。`, `The latest ${entries.length} admin actions, newest first, from the dashboard, MCP and the HTTP endpoints alike.`)}</p>
<div class="card">${logTable(v, entries)}</div>
${entries.length === limit && limit < 500 ? `<p><a href="${esc(href(v.env, "/log", { limit: Math.min(500, limit * 2) }))}">${t("显示更多", "Show more")} →</a></p>` : ""}`,
  };
}

// ---- backup ----

export async function backupPage(v: View, restore: { keys: string; result: Record<string, unknown> } | null): Promise<Rendered> {
  const t = tr(v);
  const title = t("备份", "Backup");
  const s = (await backupStatus(v.env)) as {
    enabled: boolean;
    objects?: number;
    bytes?: number;
    deleted_waiting?: number;
    oldest_deleted_since?: string | null;
    grace_days?: number;
  };
  if (!s.enabled)
    return {
      title,
      main: `<h1>${title}</h1><p class="card muted">${t("没有配置备份存储桶（BACKUP 绑定）。", "No backup bucket is configured (the BACKUP binding).")}</p>`,
    };
  const r = restore?.result as
    | { dry_run: boolean; would_restore?: string[]; restored?: string[]; skipped: { key: string; why: string }[]; present: number }
    | undefined;
  const list = (keys: string[]) => (keys.length ? keys.map((k) => `<code>${esc(k)}</code>`).join("<br>") : "–");
  const result = r
    ? `<div class="card"><h2>${r.dry_run ? t("预演结果", "Dry run") : t("已恢复", "Restored")}</h2>
<table class="kv"><tbody>
<tr><th>${r.dry_run ? t("会恢复", "Would restore") : t("已恢复", "Restored")}</th><td>${list((r.dry_run ? r.would_restore : r.restored) ?? [])}</td></tr>
<tr><th>${t("跳过", "Skipped")}</th><td>${r.skipped.length ? r.skipped.map((x) => `<code>${esc(x.key)}</code> ${badge(x.why)}`).join("<br>") : "–"}</td></tr>
<tr><th>${t("仍然存在", "Still there")}</th><td>${r.present}</td></tr>
</tbody></table>
${
  r.dry_run && (r.would_restore?.length ?? 0) > 0
    ? postForm(
        v.env,
        "/backup/restore",
        `<textarea name="keys" hidden>${esc(restore!.keys)}</textarea><div class="row"><button>${t("确认恢复", "Restore them")}</button></div>`,
      )
    : ""
}</div>`
    : "";
  return {
    title,
    main: `<h1>${title}</h1>
<div class="grid">
<div class="stat"><b>${s.objects ?? 0}</b><span>${t("备份对象", "Objects in the backup")}</span></div>
<div class="stat"><b>${fmtBytes(s.bytes)}</b><span>${t("备份大小", "Backup size")}</span></div>
<div class="stat"><b>${s.deleted_waiting ?? 0}</b><span>${t(`已删除、保留 ${s.grace_days} 天的副本`, `Copies of deleted files kept for ${s.grace_days} days`)}</span></div>
<div class="stat"><b>${s.oldest_deleted_since ? fmtTime(s.oldest_deleted_since) : "–"}</b><span>${t("最早的已删除副本", "Oldest deleted copy")}</span></div>
</div>
${result}
<h2>${t("从备份恢复", "Restore from the backup")}</h2>
<div class="card">${postForm(
      v.env,
      "/backup/restore",
      `<p class="muted">${t(
        "每行一个键：f/<id> 或旧链接的 <16 位十六进制>.<扩展名>。先预演，确认后再恢复。已下架的文件不会恢复，已存在的文件不会被覆盖。",
        "One key per line: f/<id>, or a legacy <16 hex>.<ext>. This is a dry run first; you confirm the restore after it. Taken-down files are never restored and nothing that exists is overwritten.",
      )}</p>
<textarea name="keys" required placeholder="f/k3x9qa2m">${esc(restore?.keys ?? "")}</textarea>
${hidden("dry_run", 1)}
<div class="row"><button class="ghost">${t("预演", "Dry run")}</button></div>`,
    )}</div>`,
  };
}

// ---- login ----

export function loginPage(v: View, error: string | null, next: string): Rendered {
  const t = tr(v);
  const configured = Boolean(v.env.ADMIN_TOKEN) || v.env.FEATURE_ACCOUNTS === "1";
  return {
    title: t("登录", "Sign in"),
    status: error ? 401 : 200,
    main: `<div class="login card">
<h1>${t("管理后台", "Admin")}</h1>
${
  configured
    ? `<p>${t("用 ADMIN_TOKEN，或者角色为 admin 的个人 API 令牌登录。登录 12 小时内有效。", "Sign in with ADMIN_TOKEN, or with a personal API token whose role is admin. A session lasts 12 hours.")}</p>
${error ? `<p class="flash bad">${esc(error)}</p>` : ""}
${postForm(
  v.env,
  "/login",
  `${hidden("next", next)}<div class="row"><input type="password" name="token" autocomplete="current-password" required aria-label="${esc(t("令牌", "Token"))}" placeholder="${esc(t("令牌", "Token"))}"><button>${t("登录", "Sign in")}</button></div>`,
)}`
    : `<p>${t("这个站点没有设置 ADMIN_TOKEN，管理后台没有开启。", "This site has no ADMIN_TOKEN, so the dashboard is off.")}</p>`
}
</div>`,
  };
}
