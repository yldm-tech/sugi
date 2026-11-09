// Moderation views: reports, the detail page of one file or album, everything from one source, blocks and the audit log. Every action calls the same functions as the admin MCP tools (moderation.ts, reports.ts).
import { findFile, publicUrl } from "../../files";
import { HttpError, isSourceBlocked } from "../../http";
import { LEGACY_KEY_RE } from "../../legacy";
import { inspect, isHashBlocked, listBlocks } from "../../moderation";
import { listReports } from "../../reports";
import { esc } from "../../site/i18n";
import { MEDIA_BY_EXT } from "../../sniff";
import { albumOwnerOf, indexRows, listFiles, ownerOf, parseFileFilter, queryLog } from "../data";
import { badge, empty, fmtAgo, fmtBytes, fmtNum, fmtTime, hidden, href, ICONS, postForm, preview, revealSwitch, select, tr, type View } from "../view";
import { actionBadge, fileTile, keyTarget, type Rendered, reasonBadge, sourceLink, statusBadge, targetCell, userLink } from "./common";

const site = (v: View) => new URL(v.env.MAIN_ORIGIN).host;

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
              ? `<span class="muted small">${t(`会一并处理这个链接的 ${r.open_reports_on_target} 条举报`, `Settles all ${r.open_reports_on_target} open reports on this link`)}</span>`
              : ""
          }</div>`,
        );
    const where = r.target.startsWith("album:") ? `a/${r.target.slice(6)}` : r.target.slice(r.target.indexOf(":") + 1);
    return `<article class="card report">
<div>
<div class="head"><b>#${r.id}</b>${reasonBadge(t, r.reason)}<span class="muted small">${fmtAgo(t, r.created_at)}</span>${
      r.emailed_at ? "" : `<span class="muted small">· ${t("还没发邮件", "not emailed yet")}</span>`
    }</div>
<p><a href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">${esc(r.link)} ${ICONS.external}</a> · <a href="${esc(href(v.env, "/inspect", { q: where }))}">${t("查看详情", "Inspect")}</a></p>
${r.details ? `<div class="details">${esc(r.details)}</div>` : ""}
${r.contact ? `<p class="muted small">${t("联系方式", "Contact")}: ${esc(r.contact)}</p>` : ""}
${resolved}
</div>
<div>${p ? preview(v, p.url, p.type) : r.reason === "csam" && !r.resolved_at ? `<p class="muted small">${t("CSAM 举报不预览", "No preview for CSAM reports")}</p>` : ""}</div>
</article>`;
  });
  const pager = [
    offset > 0
      ? `<a class="btn ghost small" href="${esc(href(v.env, "/reports", { status: status === "open" ? null : status, offset: Math.max(0, offset - limit) || null }))}">← ${t("上一页", "Newer")}</a>`
      : "",
    offset + limit < data.total
      ? `<a class="btn ghost small" href="${esc(href(v.env, "/reports", { status: status === "open" ? null : status, offset: offset + limit }))}">${t("下一页", "Older")} →</a>`
      : "",
  ].join("");
  return {
    title: t("举报", "Reports"),
    main: `<h1>${t("举报", "Reports")}</h1>
<p class="lede">${t(`共 ${data.total} 条。CSAM 举报不显示预览，默认勾选封禁相同内容。`, `${data.total} in total. CSAM reports are never previewed and block the same bytes by default.`)}</p>
<nav class="tabs">${tab("open", t("待处理", "Open"))}${tab("resolved", t("已处理", "Resolved"))}${tab("all", t("全部", "All"))}</nav>
${items.length ? items.join("\n") : `<div class="card">${empty(status === "open" ? t("没有待处理的举报。", "No open reports.") : t("没有举报。", "No reports."))}</div>`}
<div class="pager"><span></span><span class="pager-btns">${pager}</span></div>`,
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
  const title = t("详情", "Details");
  const form = `<form method="get" action="${esc(href(v.env, "/inspect"))}" class="filters"><label class="field grow"><span>${t("文件或相册", "File or album")}</span><input type="search" name="q" value="${esc(q)}" placeholder="${esc(t("文件 id、任意链接，或相册链接 /a/<id>", "File id, any link, or an album link /a/<id>"))}" required></label><button>${t("查看", "Look up")}</button></form>`;
  if (!q) return { title, main: `<h1>${title}</h1>${form}` };
  let info: Inspected;
  try {
    info = (await inspect(v.env, q)) as unknown as Inspected;
  } catch (err) {
    if (!(err instanceof HttpError) || err.status >= 500) throw err;
    return {
      title,
      status: err.status,
      main: `<h1>${title}</h1>${form}<div class="card">${empty(`${t("这不是文件或相册的链接、id。", "That is not a file or album link or id.")} <a href="${esc(href(v.env, "/search", { q }))}">${t("用全局搜索找", "Search everything")} →</a>`)}</div>`,
    };
  }
  if (info.status === "missing")
    return {
      title,
      status: 404,
      main: `<h1>${title}</h1>${form}<div class="card">${empty(
        t(
          `${site(v)} 上没有这个${info.kind === "album" ? "相册" : "文件"}，也没有下架记录。测试站和正式站的数据是分开的。`,
          `There is no such ${info.kind} on ${site(v)}, and no takedown record. Test and production sites have separate data.`,
        ),
      )}</div>`,
    };

  const key = info.kind === "album" ? null : (info.key ?? info.id);
  const owner = info.kind === "album" ? await albumOwnerOf(v.env, info.id) : key ? await ownerOf(v.env, key) : null;
  // New-API files keep their content hash only in the file index, not in their R2 metadata.
  if (!info.sha256 && key) {
    const sha = (await v.env.DB.prepare("SELECT sha256 FROM file_index WHERE key = ?").bind(key).first<{ sha256: string | null }>())?.sha256 ?? null;
    if (sha) Object.assign(info, { sha256: sha, content_blocked: await isHashBlocked(v.env, sha) });
  }
  const reportTarget = info.kind === "album" ? `album:${info.id}` : info.kind === "legacy" ? `legacy:${info.id}` : `file:${info.id}`;
  const reports = (
    await v.env.DB.prepare("SELECT id, reason, created_at, resolved_at, resolution FROM reports WHERE target = ? ORDER BY id DESC LIMIT 20")
      .bind(reportTarget)
      .all<{ id: number; reason: string; created_at: number; resolved_at: number | null; resolution: string | null }>()
  ).results;
  const row = (k: string, val: string) => `<tr><th>${k}</th><td>${val}</td></tr>`;
  const link = info.kind === "album" ? (info.status === "live" ? `${v.env.MAIN_ORIGIN}/a/${info.id}` : null) : (info.url ?? null);
  const rows = [
    row(t("状态", "Status"), statusBadge(t, info.status)),
    row(
      t("类型", "Kind"),
      `${esc(info.kind === "album" ? t("相册", "album") : info.kind === "legacy" ? t("旧接口文件", "legacy file") : key?.startsWith("t/") ? t("临时文件", "temporary file") : t("文件", "file"))} <code>${esc(info.kind === "album" ? `a/${info.id}` : (key ?? ""))}</code>`,
    ),
    ...(info.kind === "album" ? [row(t("标题", "Title"), info.title ? esc(info.title) : "–")] : []),
    ...(info.kind !== "album"
      ? [
          row(t("格式", "Type"), info.type ? esc(info.type) : "–"),
          row(t("大小", "Size"), fmtBytes(info.size)),
          row(t("文件名", "Name"), info.name ? esc(info.name) : "–"),
        ]
      : []),
    row(t("上传时间", "Created"), info.created_at ? `${fmtTime(info.created_at)} · ${fmtAgo(t, info.created_at)}` : "–"),
    ...(info.kind !== "album"
      ? [row(t("过期时间", "Expires"), info.expires_at ? `${fmtTime(info.expires_at)} · ${fmtAgo(t, info.expires_at)}` : t("永久", "never"))]
      : []),
    ...(link ? [row(t("链接", "Link"), `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(link)} ${ICONS.external}</a>`)] : []),
    row(t("账号", "Account"), owner ? userLink(v, owner) : `<span class="muted">${t("匿名上传", "anonymous")}</span>`),
    row(
      t("来源", "Source"),
      info.source
        ? `${sourceLink(v, info.source, 16)} ${info.source_blocked ? badge(t("已封禁", "blocked"), "bad") : ""}`
        : `<span class="muted">${t("没有记录", "not recorded")}</span>`,
    ),
    ...(info.sha256
      ? [row("SHA-256", `<code>${esc(info.sha256)}</code> ${info.content_blocked ? badge(t("内容已封禁", "content blocked"), "bad") : ""}`)]
      : []),
    ...(info.albums?.length
      ? [row(t("所在相册", "In albums"), info.albums.map((a) => `<a href="${esc(href(v.env, "/inspect", { q: `a/${a}` }))}">a/${esc(a)}</a>`).join(", "))]
      : []),
    ...(reports.length
      ? [
          row(
            t("举报", "Reports"),
            reports
              .map(
                (r) =>
                  `<a href="${esc(href(v.env, "/reports", { status: r.resolved_at ? "all" : null }))}">#${r.id}</a> ${reasonBadge(t, r.reason)} ${
                    r.resolved_at ? badge(r.resolution === "removed" ? t("已下架", "removed") : t("已驳回", "dismissed")) : badge(t("待处理", "open"), "bad")
                  } <span class="muted small">${fmtAgo(t, r.created_at)}</span>`,
              )
              .join("<br>"),
          ),
        ]
      : []),
    ...(info.takedown ? [row(t("下架记录", "Takedown"), `${fmtTime(info.takedown.at)}${info.takedown.reason ? ` · ${esc(info.takedown.reason)}` : ""}`)] : []),
  ];

  let albumFiles = "";
  if (info.kind === "album" && info.files?.length) {
    const files = await indexRows(v.env, info.files);
    const known = new Set(files.map((f) => f.key));
    const missing = info.files.filter((k) => !known.has(k));
    const reveal = revealSwitch(t);
    albumFiles = `${reveal.input}<div class="section"><h2>${t(`相册里的文件（${info.files.length}）`, `Files in the album (${info.files.length})`)}</h2>${reveal.label}</div>
<div>${files.length ? `<div class="grid">${files.map((f) => fileTile(v, { ...f, user_id: null, user_email: null, user_name: null })).join("")}</div>` : ""}${
      missing.length ? `<p class="muted small">${t("已不在的文件", "No longer there")}: ${missing.map((k) => `<code>${esc(k)}</code>`).join(" ")}</p>` : ""
    }</div>`;
  }

  const live = info.status === "live" || info.status === "expired";
  const actions = live
    ? `<div class="card danger-zone"><h2>${t("下架", "Take down")}</h2>${postForm(
        v.env,
        "/takedown",
        `${hidden("target", info.kind === "album" ? `a/${info.id}` : info.id)}
<div class="row"><input class="reason" type="text" name="reason" maxlength="500" placeholder="${esc(t("原因（会记录到操作记录）", "Reason (goes into the audit log)"))}"></div>
<div class="row"><label class="check"><input type="checkbox" name="block_content" value="1"> ${t("同时封禁相同内容（不超过 20 MB 的文件）", "Also block the same bytes (files up to 20 MB)")}</label>
${info.kind === "album" ? `<label class="check"><input type="checkbox" name="include_files" value="1"> ${t("连同相册里的文件一起下架", "Take down the files in it too")}</label>` : ""}</div>
<div class="row"><button class="danger">${t("下架", "Take down")}</button><span class="muted small">${t("链接之后返回 451，id 不会再被使用。", "The link answers 451 from then on and the id is never reused.")}</span></div>`,
      )}</div>`
    : "";
  const unblock =
    info.sha256 && info.content_blocked
      ? `<div class="card"><h2>${t("解除内容封禁", "Unblock content")}</h2>${postForm(
          v.env,
          "/content/unblock",
          `${hidden("sha256", info.sha256)}${hidden("back", `/inspect?q=${encodeURIComponent(q)}`)}<div class="row"><input class="reason" type="text" name="reason" maxlength="500" placeholder="${esc(t("原因", "Reason"))}"><button class="ghost">${t("解除", "Unblock")}</button></div>`,
        )}</div>`
      : "";
  const pv = info.status === "live" && info.url && info.type ? `<div>${preview(v, info.url, info.type, "big")}</div>` : "";
  const heading = info.kind === "album" ? info.title || `a/${info.id}` : info.name || keyTarget(key ?? info.id);
  return {
    title: heading,
    main: `<h1>${esc(heading)}</h1>
<p class="lede">${info.source ? `<a href="${esc(href(v.env, "/source", { s: info.source }))}">${t("同一来源的全部上传", "Everything from the same source")} →</a>` : ""}${
      owner ? ` · <a href="${esc(href(v.env, "/files", { user: owner.id }))}">${t("这个账号的全部文件", "All files of this account")} →</a>` : ""
    }</p>
<div class="card report"><div class="scroll"><table class="kv"><tbody>${rows.join("")}</tbody></table></div>${pv}</div>
${albumFiles}
${actions}${unblock}`,
  };
}

// ---- source ----

export async function sourcePage(v: View, s: string, offset: number): Promise<Rendered> {
  const t = tr(v);
  const title = t("来源", "Source");
  const limit = 48;
  if (!s) return { title, main: `<h1>${title}</h1><div class="card">${empty(t("从文件详情进入来源。", "Open a source from a file's details."))}</div>` };
  let source = s.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(source)) {
    try {
      const info = await inspect(v.env, s);
      if (typeof info.source !== "string") throw new HttpError(404, t("这个链接没有记录来源。", "No source is recorded for that link."));
      source = info.source;
    } catch (err) {
      if (!(err instanceof HttpError) || err.status >= 500) throw err;
      return { title, status: err.status, main: `<h1>${title}</h1><p class="flash bad">${esc(err.message)}</p>` };
    }
  }
  const [files, blocked, removed, albums] = await Promise.all([
    listFiles(v.env, { ...parseFileFilter(new URLSearchParams()), source }, offset, limit),
    isSourceBlocked(v.env, source),
    v.env.DB.prepare("SELECT COUNT(*) AS n FROM tombstones WHERE source = ?").bind(source).first<{ n: number }>(),
    v.env.DB.prepare("SELECT id, title, created_at FROM albums WHERE source = ? ORDER BY created_at DESC LIMIT 100")
      .bind(source)
      .all<{ id: string; title: string; created_at: number }>(),
  ]);
  const back = `/source?s=${source}`;
  const reveal = revealSwitch(t);
  const block = blocked
    ? postForm(
        v.env,
        "/source/unblock",
        `${hidden("source", source)}${hidden("back", back)}<div class="row">${badge(t("已封禁", "blocked"), "bad")}<input class="reason" type="text" name="reason" maxlength="500" placeholder="${esc(t("原因", "Reason"))}"><button class="ghost">${t("解除封禁", "Unblock")}</button></div>`,
      )
    : postForm(
        v.env,
        "/source/block",
        `${hidden("source", source)}${hidden("back", back)}<div class="row"><input class="reason" type="text" name="reason" maxlength="500" placeholder="${esc(t("原因", "Reason"))}">
<label class="field"><span>${t("小时数（留空为永久）", "Hours (empty: until lifted)")}</span><input type="number" name="hours" min="1" max="8760"></label>
<button class="danger">${t("禁止这个来源上传", "Block uploads from this source")}</button></div>`,
      );
  const total = files.total + albums.results.length;
  const takedownAll = total
    ? `<div class="card danger-zone"><h2>${t("全部下架", "Take down everything")}</h2>${postForm(
        v.env,
        "/source/takedown",
        `${hidden("source", source)}<div class="row"><input class="reason" type="text" name="reason" maxlength="500" placeholder="${esc(t("原因（会记录到操作记录）", "Reason (goes into the audit log)"))}">
<label class="check"><input type="checkbox" name="block_content" value="1"> ${t("同时封禁相同内容", "Also block the same bytes")}</label></div>
<div class="row"><label class="check"><input type="checkbox" name="confirm" value="${total}" required> ${t(`我已经看过这 ${total} 项`, `I have checked these ${total} items`)}</label>
<button class="danger">${t(`全部下架（${files.total} 个文件、${albums.results.length} 个相册）`, `Take down all (${files.total} files, ${albums.results.length} albums)`)}</button></div>`,
      )}</div>`
    : "";
  return {
    title,
    main: `<h1>${title}</h1>
<div class="card"><p><code>${esc(source)}</code></p><p class="muted">${t(
      `来源是上传者 IP 的 HMAC，不能还原成 IP。${fmtNum(files.total)} 个文件（${fmtBytes(files.bytes)}）和 ${albums.results.length} 个相册在线，${removed?.n ?? 0} 项已下架。`,
      `A source is an HMAC of the uploader's IP and cannot be turned back into one. ${fmtNum(files.total)} files (${fmtBytes(files.bytes)}) and ${albums.results.length} albums are up; ${removed?.n ?? 0} were taken down.`,
    )}</p>${block}</div>
${reveal.input}
<div class="section"><h2>${t("文件", "Files")}</h2>${reveal.label}</div>
<div>${files.files.length ? `<div class="grid">${files.files.map((f) => fileTile(v, f)).join("")}</div>` : `<div class="card">${empty(t("没有在线的文件。", "No files up."))}</div>`}
${files.total > limit ? `<p><a href="${esc(href(v.env, "/files", { source }))}">${t(`在文件库里看全部 ${fmtNum(files.total)} 个`, `See all ${fmtNum(files.total)} in Files`)} →</a></p>` : ""}</div>
${
  albums.results.length
    ? `<div class="section"><h2>${t("相册", "Albums")}</h2></div><div class="card"><ul class="list">${albums.results
        .map(
          (a) =>
            `<li><a class="grow" href="${esc(href(v.env, "/inspect", { q: `a/${a.id}` }))}">${esc(a.title || `a/${a.id}`)}</a><span class="muted small">${fmtAgo(t, a.created_at)}</span></li>`,
        )
        .join("")}</ul></div>`
    : ""
}
${takedownAll}`,
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
        `<tr><td>${sourceLink(v, s.source, 16)}</td><td>${s.reason ? esc(s.reason) : "–"}</td><td>${fmtAgo(t, s.created_at)}</td><td>${
          s.expires_at ? fmtTime(s.expires_at) : t("永久", "until lifted")
        } ${s.active ? "" : badge(t("已过期", "expired"))}</td><td>${postForm(
          v.env,
          "/source/unblock",
          `${hidden("source", s.source)}${hidden("back", "/blocks")}<div class="row">${reasonInput}<button class="ghost small">${t("解除", "Unblock")}</button></div>`,
        )}</td></tr>`,
    )
    .join("");
  const content = data.content
    .map(
      (c) =>
        `<tr><td><code title="${esc(c.sha256)}">${esc(c.sha256.slice(0, 16))}…</code></td><td>${c.target ? targetCell(v, c.target) : "–"}</td><td>${c.reason ? esc(c.reason) : "–"}</td><td>${fmtAgo(t, c.created_at)}</td><td>${postForm(
          v.env,
          "/content/unblock",
          `${hidden("sha256", c.sha256)}${hidden("back", "/blocks")}<div class="row">${reasonInput}<button class="ghost small">${t("解除", "Unblock")}</button></div>`,
        )}</td></tr>`,
    )
    .join("");
  return {
    title: t("封禁", "Blocks"),
    main: `<h1>${t("封禁", "Blocks")}</h1>
<p class="lede">${t("被封禁的来源不能再上传；被封禁的内容（按 SHA-256）不能再被任何人上传。", "A blocked source cannot upload; blocked content (by SHA-256) cannot be uploaded by anyone.")}</p>
<div class="card"><h2>${t("封禁一个来源", "Block a source")}</h2>${postForm(
      v.env,
      "/source/block",
      `${hidden("back", "/blocks")}<div class="row"><input class="reason" type="text" name="source" required placeholder="${esc(t("来源哈希，或那个来源上传的任意文件链接", "A source hash, or a link to any file from that source"))}"></div>
<div class="row">${reasonInput}<label class="field"><span>${t("小时数（留空为永久）", "Hours (empty: until lifted)")}</span><input type="number" name="hours" min="1" max="8760"></label><button class="danger">${t("封禁", "Block")}</button></div>`,
    )}</div>
<div class="section"><h2>${t("禁止上传的来源", "Sources blocked from uploading")}</h2><span class="muted small">${data.sources.length}</span></div>
<div class="card flush scroll">${
      sources
        ? `<table><thead><tr><th>${t("来源", "Source")}</th><th>${t("原因", "Reason")}</th><th>${t("时间", "Since")}</th><th>${t("到期", "Until")}</th><th></th></tr></thead><tbody>${sources}</tbody></table>`
        : empty(t("没有封禁的来源。", "No blocked sources."))
    }</div>
<div class="section"><h2>${t("封禁的内容", "Blocked content")}</h2><span class="muted small">${data.content.length}</span></div>
<div class="card flush scroll">${
      content
        ? `<table><thead><tr><th>SHA-256</th><th>${t("来自", "From")}</th><th>${t("原因", "Reason")}</th><th>${t("时间", "Since")}</th><th></th></tr></thead><tbody>${content}</tbody></table>`
        : empty(t("没有封禁的内容。", "No blocked content."))
    }</div>`,
  };
}

// ---- log ----

export async function logPage(v: View, opts: { action: string; q: string; before: number | null }): Promise<Rendered> {
  const t = tr(v);
  const limit = 100;
  const { entries, actions } = await queryLog(v.env, { ...opts, limit });
  const rows = entries
    .map((e) => {
      let detail = "–";
      if (e.detail) {
        try {
          const d = JSON.parse(e.detail) as Record<string, unknown>;
          detail = Object.entries(d)
            .filter(([, val]) => val !== null && !(Array.isArray(val) && val.length === 0))
            .map(([k, val]) => `<span class="muted">${esc(k)}</span> ${esc(typeof val === "string" ? val : JSON.stringify(val))}`)
            .join("<br>");
        } catch {
          detail = `<code>${esc(e.detail)}</code>`;
        }
      }
      return `<tr><td>${fmtTime(e.at)}<br><span class="muted small">${fmtAgo(t, e.at)}</span></td><td>${actionBadge(t, e.action)}</td><td>${e.target ? targetCell(v, e.target) : "–"}</td><td>${e.reason ? esc(e.reason) : "–"}</td><td class="small">${detail}</td></tr>`;
    })
    .join("");
  const last = entries.at(-1);
  return {
    title: t("操作记录", "Audit log"),
    main: `<h1>${t("操作记录", "Audit log")}</h1>
<p class="lede">${t("网页、MCP 和 HTTP 接口的管理操作都记在这里，新的在前，只增不改。", "Every admin action from the dashboard, MCP and the HTTP endpoints, newest first; never edited.")}</p>
<form method="get" action="${esc(href(v.env, "/log"))}" class="filters">
${select("action", opts.action, [["", t("全部操作", "All actions")], ...actions.map((a) => [a, a] as [string, string])], t("操作", "Action"))}
<label class="field grow"><span>${t("搜索", "Search")}</span><input type="search" name="q" value="${esc(opts.q)}" placeholder="${esc(t("对象、原因或详情里的文字", "Text in the target, reason or detail"))}"></label>
<button>${t("筛选", "Filter")}</button>${opts.action || opts.q || opts.before ? `<a class="btn ghost" href="${esc(href(v.env, "/log"))}">${t("清除", "Clear")}</a>` : ""}
</form>
<div class="card flush scroll">${
      rows
        ? `<table><thead><tr><th>${t("时间", "When")}</th><th>${t("操作", "Action")}</th><th>${t("对象", "Target")}</th><th>${t("原因", "Reason")}</th><th>${t("详情", "Detail")}</th></tr></thead><tbody>${rows}</tbody></table>`
        : empty(t("没有记录。", "Nothing here."))
    }</div>
<div class="pager"><span></span><span class="pager-btns">${
      opts.before ? `<a class="btn ghost small" href="${esc(href(v.env, "/log", { action: opts.action, q: opts.q }))}">${t("最新", "Newest")}</a>` : ""
    }${entries.length === limit && last ? `<a class="btn ghost small" href="${esc(href(v.env, "/log", { action: opts.action, q: opts.q, before: last.id }))}">${t("更早", "Older")} →</a>` : ""}</span></div>`,
  };
}
