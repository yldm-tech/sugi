// Files and albums: every stored file from the file index, with filters, blurred previews and bulk takedown; and the albums.
import { lastIndexPass } from "../../fileindex";
import { esc } from "../../site/i18n";
import { type FileFilter, fileUrl, indexRows, listAlbums, listFiles } from "../data";
import { badge, empty, fmtAgo, fmtBytes, fmtNum, hidden, href, pager, postForm, revealSwitch, select, thumb, tr, type View } from "../view";
import { fileTile, type Rendered, sourceLink, userLink } from "./common";

export const FILES_PER_PAGE = 48;

function filterQuery(f: FileFilter): Record<string, string> {
  return { q: f.q, kind: f.kind, life: f.life, owner: f.owner, user: f.user, source: f.source, sort: f.sort === "new" ? "" : f.sort };
}

export async function filesPage(v: View, f: FileFilter, offset: number): Promise<Rendered> {
  const t = tr(v);
  const [data, pass] = await Promise.all([listFiles(v.env, f, offset, FILES_PER_PAGE), lastIndexPass(v.env)]);
  const reveal = revealSwitch(t);
  const query = filterQuery(f);
  const back = href(v.env, "/files", { ...query, offset: offset || null }).slice(href(v.env, "").length) || "/files";
  const scope = [
    f.user ? `<span class="badge info">${t("账号", "Account")}: ${esc(f.user)}</span>` : "",
    f.source ? `<span class="badge info">${t("来源", "Source")}: ${esc(f.source.slice(0, 12))}…</span>` : "",
  ].join(" ");
  const filters = `<form method="get" action="${esc(href(v.env, "/files"))}" class="filters">
<label class="field grow"><span>${t("搜索", "Search")}</span><input type="search" name="q" value="${esc(f.q)}" placeholder="${esc(t("文件名、id、链接、来源或 SHA-256", "Name, id, link, source or SHA-256"))}"></label>
${select(
  "kind",
  f.kind,
  [
    ["", t("全部类型", "All types")],
    ["image", t("图片", "Images")],
    ["video", t("视频", "Videos")],
  ],
  t("类型", "Type"),
)}
${select(
  "life",
  f.life,
  [
    ["", t("全部", "All")],
    ["permanent", t("永久", "Permanent")],
    ["temporary", t("临时", "Temporary")],
    ["legacy", t("旧接口", "Legacy")],
  ],
  t("期限", "Lifetime"),
)}
${select(
  "owner",
  f.owner,
  [
    ["", t("全部", "All")],
    ["account", t("有账号", "Account")],
    ["anonymous", t("匿名", "Anonymous")],
  ],
  t("上传者", "Uploader"),
)}
${select(
  "sort",
  f.sort,
  [
    ["new", t("最新", "Newest")],
    ["old", t("最早", "Oldest")],
    ["big", t("最大", "Largest")],
  ],
  t("排序", "Sort"),
)}
${f.user ? hidden("user", f.user) : ""}${f.source ? hidden("source", f.source) : ""}
<button>${t("筛选", "Filter")}</button>${
    f.q || f.kind || f.life || f.owner || f.user || f.source || f.sort !== "new"
      ? `<a class="btn ghost" href="${esc(href(v.env, "/files"))}">${t("清除", "Clear")}</a>`
      : ""
  }
</form>`;
  const bulk = postForm(
    v.env,
    "/files/takedown",
    `${hidden("back", back)}<b>${t("选中的文件", "Selected files")}</b>
<input class="reason" type="text" name="reason" maxlength="500" placeholder="${esc(t("下架原因（会记录到操作记录）", "Reason (goes into the audit log)"))}">
<label class="check"><input type="checkbox" name="block_content" value="1"> ${t("同时封禁相同内容", "Also block the same bytes")}</label>
<button class="danger">${t("下架选中", "Take down selected")}</button>`,
    "bulk",
    "bulk",
  );
  return {
    title: t("文件", "Files"),
    main: `<h1>${t("文件", "Files")}</h1>
<p class="lede">${t(`共 ${fmtNum(data.total)} 个，${fmtBytes(data.bytes)}。`, `${fmtNum(data.total)} files, ${fmtBytes(data.bytes)}.`)} ${scope}</p>
${pass ? "" : `<p class="note">${t("文件索引还在建立，列表可能还不全。", "The file index is still being built; the list may be incomplete.")}</p>`}
${filters}
${reveal.input}
<div class="section"><span class="muted small">${t("预览默认模糊；点文件看详情和操作。", "Previews are blurred; open a file for details and actions.")}</span>${reveal.label}</div>
<div>${data.files.length ? `<div class="grid">${data.files.map((x) => fileTile(v, x, { pick: "bulk" })).join("")}</div>` : `<div class="card">${empty(t("没有符合条件的文件。", "No files match."))}</div>`}</div>
${data.files.length ? bulk : ""}
${pager(v, "/files", query, offset, FILES_PER_PAGE, data.total)}`,
  };
}

export async function albumsPage(v: View, q: string, offset: number): Promise<Rendered> {
  const t = tr(v);
  const limit = 30;
  const data = await listAlbums(v.env, q, offset, limit);
  const covers = await indexRows(
    v.env,
    data.albums.flatMap((a) => (a.cover ? [a.cover] : [])),
  );
  const coverOf = new Map(covers.map((c) => [c.key, c]));
  const reveal = revealSwitch(t);
  const rows = data.albums
    .map((a) => {
      const c = a.cover ? coverOf.get(a.cover) : undefined;
      return `<tr><td><span class="mini">${thumb(c ? fileUrl(v.env, c.key, c.type) : null, c?.type ?? null)}</span></td>
<td><a href="${esc(href(v.env, "/inspect", { q: `a/${a.id}` }))}">${esc(a.title || t("（无标题）", "(untitled)"))}</a><br><code class="muted">a/${esc(a.id)}</code></td>
<td class="num">${fmtNum(a.n)}</td>
<td>${a.user_id ? userLink(v, { id: a.user_id, email: a.user_email }) : `<span class="muted">${t("匿名", "anonymous")}</span>`}</td>
<td>${sourceLink(v, a.source)}</td>
<td>${fmtAgo(t, a.created_at)}</td>
<td><a href="${esc(`${v.env.MAIN_ORIGIN}/a/${a.id}`)}" target="_blank" rel="noopener noreferrer">${t("打开", "Open")}</a></td></tr>`;
    })
    .join("");
  return {
    title: t("相册", "Albums"),
    main: `<h1>${t("相册", "Albums")}</h1>
<p class="lede">${t(`共 ${fmtNum(data.total)} 个。`, `${fmtNum(data.total)} albums.`)}</p>
<form method="get" action="${esc(href(v.env, "/albums"))}" class="filters">
<label class="field grow"><span>${t("搜索", "Search")}</span><input type="search" name="q" value="${esc(q)}" placeholder="${esc(t("标题或相册 id", "Title or album id"))}"></label>
<button>${t("搜索", "Search")}</button>${q ? `<a class="btn ghost" href="${esc(href(v.env, "/albums"))}">${t("清除", "Clear")}</a>` : ""}
</form>
${reveal.input}
<div class="section"><span></span>${reveal.label}</div>
<div class="card flush scroll">${
      rows
        ? `<table><thead><tr><th></th><th>${t("相册", "Album")}</th><th class="num">${t("文件", "Files")}</th><th>${t("账号", "Account")}</th><th>${t("来源", "Source")}</th><th>${t("创建", "Created")}</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : empty(t("没有相册。", "No albums."))
    }</div>
${pager(v, "/albums", { q }, offset, limit, data.total)}
<p class="muted small">${badge(t("提示", "Tip"), "info")} ${t("相册里的文件在详情页里逐个列出，可以整本下架，也可以连同文件一起下架。", "Open an album to see its files; it can be taken down alone or together with its files.")}</p>`,
  };
}
