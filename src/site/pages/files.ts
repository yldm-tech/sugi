import { Album, albumUrl } from "../../albums";
import { pageUrl, publicUrl, StoredFile } from "../../files";
import { esc } from "../i18n";
import { brand } from "../../config";
import { Ctx, homeTitle, Page, pageTitle, tr } from "../layout";
import { qrSvg } from "../qr";
import { hamsterFace, peekHamster } from "../svg";

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

// Rendered in UTC on the server; app.ts rewrites <time> elements in the visitor's own time zone.
function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function linkFormats(ctx: Ctx, url: string, name: string, image: boolean): [string, string][] {
  const t = tr(ctx);
  const n = name || url.split("/").pop()!;
  return [
    [t("直链", "Link"), url],
    ["Markdown", image ? `![${n}](${url})` : `[${n}](${url})`],
    ["HTML", image ? `<img src="${url}" alt="${n}">` : `<video src="${url}" controls></video>`],
    ["BBCode", image ? `[img]${url}[/img]` : `[url=${url}]${n}[/url]`],
  ];
}

function expiryBadge(ctx: Ctx, f: StoredFile): string {
  const t = tr(ctx);
  if (f.expires === null) return `<span class="badge perm">${t("永久", "Forever")}</span>`;
  return `<span class="badge tmp" data-expires="${f.expires}">${t("临时", "Temporary")}</span>`;
}

function mediaTag(url: string, f: StoredFile, alt: string): string {
  if (f.type.kind === "video") return `<video src="${esc(url)}" controls playsinline preload="metadata"></video>`;
  return `<img src="${esc(url)}" alt="${esc(alt)}" decoding="async">`;
}

export function filePage(ctx: Ctx, f: StoredFile): Page {
  const t = tr(ctx);
  const url = publicUrl(ctx.env, f);
  const page = pageUrl(ctx.env, f.id);
  const name = f.name ?? `${f.id}.${f.type.ext}`;
  const formats = linkFormats(ctx, url, name, f.type.kind === "image");
  const html = `<section class="filepage" data-file-id="${esc(f.id)}">
<div class="holder">
${peekHamster(120, 110, true)}<div class="paw l"></div><div class="paw r"></div>
<div class="frame"><div class="media">${mediaTag(url, f, name)}</div></div>
</div>
<div class="fileinfo">
<h1>${esc(name)}</h1>
<div class="badges"><span class="badge num">${fmtSize(f.size)}</span><span class="badge"><time datetime="${new Date(f.uploaded).toISOString()}">${fmtDate(f.uploaded)}</time></span>${expiryBadge(ctx, f)}</div>
<div class="row-actions"><a class="btn big" href="${esc(url)}" download="${esc(name)}" target="_blank" rel="noopener">${t("下载原文件", "Download")}</a><button type="button" class="btn big ghost" data-copy="${esc(page)}" data-toast="page">${t("复制这一页", "Copy this page")}</button></div>
${formats.map(([label, text]) => `<div class="fmt"><span class="l">${label}</span><code>${esc(text)}</code><button type="button" data-copy="${esc(text)}">${t("复制", "Copy")}</button></div>`).join("\n")}
<div class="card qrcard">
<div class="qr">${qrSvg(page)}<div class="badge-hamster">${hamsterFace(32, 30, 2.4)}</div></div>
<div><div class="t">${t("扫一扫，手机上看", "Scan to open on your phone")}</div><div class="u">${esc(page)}</div></div>
</div>
<button type="button" class="btn warn" id="file-delete" hidden>${t("删除这个文件", "Delete this file")}</button>
<a class="more" href="/" data-nav>${t("也来屯一个 →", "Stash one too →")}</a>
</div>
</section>`;
  // A permanent public image can preview itself; videos and temporary files use the site image.
  const ogImage = f.type.kind === "image" && f.expires === null ? url : undefined;
  return { id: "file", title: `${name} · ${brand(ctx.env).siteName}`, main: html, noindex: true, ogImage, ogTitle: homeTitle(ctx) };
}

export function albumPage(ctx: Ctx, a: Album): Page {
  const t = tr(ctx);
  const url = albumUrl(ctx.env, a.id);
  const title = a.title || t("未命名合集", "Untitled album");
  const items = a.files
    .map((f) => {
      const u = publicUrl(ctx.env, f);
      const inner = f.type.kind === "video" ? `<video src="${esc(u)}" muted playsinline preload="metadata"></video>` : `<img src="${esc(u)}" alt="${esc(f.name ?? f.id)}" loading="lazy" decoding="async">`;
      return `<a href="${esc(pageUrl(ctx.env, f.id))}" data-nav title="${esc(f.name ?? f.id)}">${inner}</a>`;
    })
    .join("\n");
  const html = `<section class="stack" data-album-id="${esc(a.id)}">
<a class="more" href="/mine" data-nav>← ${t("我的文件", "My files")}</a>
<div class="album-head">
<div class="stack8"><h1>${esc(title)}</h1><div class="small"><strong>${t(`${a.files.length} 个文件`, `${a.files.length} files`)}</strong> · <time datetime="${new Date(a.created_at).toISOString()}" data-date-only>${fmtDate(a.created_at).slice(0, 10)}</time></div></div>
<div class="linkbox"><span>${esc(url)}</span><button type="button" data-copy="${esc(url)}" data-toast="link">${t("复制", "Copy")}</button></div>
</div>
${a.files.length ? `<div class="grid gallery">${items}</div>` : `<div class="empty"><div class="kao sm">(・_・;)</div><div class="cute">${t("里面的文件都被删掉啦", "Every file in here has been deleted")}</div></div>`}
<button type="button" class="btn warn" id="album-delete" hidden>${t("删除这个打包链接", "Delete this album link")}</button>
</section>`;
  return { id: "album", title: `${title} · ${brand(ctx.env).siteName}`, main: html, noindex: true, ogTitle: homeTitle(ctx) };
}

// Everything on this page comes from localStorage, so the server only renders the frame and the empty state; app.ts fills it in.
export function minePage(ctx: Ctx): Page {
  const t = tr(ctx);
  const html = `<section class="stack8">
<h1 class="h1">${t("我的文件", "My files")}</h1>
<p class="lead">${t("没登录时，记录和删除凭证只存在当前浏览器里，换设备或清理浏览器就看不到了。", "Without an account, your history and delete tokens live only in this browser. Switch devices or clear the browser and they are gone.")}</p>
</section>
<div class="mine-bar">
<div class="seg mid" id="mine-tabs"><button type="button" data-tab="files" class="on">${t("文件", "Files")} <span id="file-count">0</span></button><button type="button" data-tab="albums">${t("打包链接", "Albums")} <span id="album-count">0</span></button></div>
<div class="row-actions"><button type="button" class="mini" id="import-history">${t("导入记录", "Import")}</button><button type="button" class="mini" id="export-history" hidden>${t("导出记录", "Export")}</button></div>
<input type="file" id="import-file" accept="application/json,.json" hidden>
</div>
<section class="stack" id="mine-files">
<div class="selbar" id="selbar" hidden><span class="count" id="sel-count"></span><input id="album-title" maxlength="80" placeholder="${t("起个标题（可以不填）", "Title (optional)")}"><button type="button" class="mk" id="sel-album">${t("打包成链接", "Make a link")}</button><button type="button" class="rm" id="sel-delete">${t("删除", "Delete")}</button><button type="button" class="cx" id="sel-clear">${t("取消", "Cancel")}</button></div>
<div class="stack" id="mine-tools" hidden>
<div class="filters"><div class="search"><span aria-hidden="true">⌕</span><input id="mine-q" placeholder="${t("按文件名找找", "Search by file name")}" aria-label="${t("按文件名找找", "Search by file name")}"></div>
<div class="seg" id="mine-filter"><button type="button" data-filter="all" class="on">${t("全部", "All")}</button><button type="button" data-filter="perm">${t("永久", "Forever")}</button><button type="button" data-filter="tmp">${t("临时", "Temporary")}</button><button type="button" data-filter="gone">${t("已过期", "Expired")}</button></div></div>
<div class="fmtrow"><span>${t("复制成", "Copy as")}</span><div class="seg" data-fmt-seg></div></div>
</div>
<div class="empty" id="mine-nomatch" hidden><div class="kao sm">(・_・;)</div><div class="cute">${t("没找到符合的文件", "Nothing matches")}</div></div>
<div class="empty" id="mine-empty"><div class="kao">(｡･ω･｡)</div><div class="cute h2">${t("仓库还空空的", "Nothing stashed yet")}</div><a class="btn" href="/" data-nav>${t("去传第一个", "Upload the first one")}</a></div>
<div class="grid" id="mine-grid"></div>
</section>
<section class="stack" id="mine-albums" hidden>
<div class="empty" id="albums-empty"><div class="kao">(・ω・)ノ</div><div class="cute h2">${t("还没有打包链接", "No album links yet")}</div><div class="lead">${t("在「文件」里点选几张，就能打包成一个匿名分享链接，打开就是一页图。", "Pick a few under “Files” to bundle them into one anonymous share link that opens as a page of pictures.")}</div></div>
<div class="albums" id="albums-grid"></div>
</section>`;
  return { id: "mine", title: pageTitle(ctx, "我的文件", "My files"), main: html, noindex: true };
}
