export type Lang = "en" | "zh";

export interface PageOptions {
  origin: string;
  lang: Lang;
  maxMiB: number;
  rateLimit: number;
  ratePeriodSeconds: number;
  gated: boolean;
  nonce: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Picks the page language: an explicit ?lang= wins, then the first zh/en entry in Accept-Language, then English.
export function pickLang(query: string | null, acceptLanguage: string | null): Lang {
  if (query === "en" || query === "zh") return query;
  for (const part of (acceptLanguage ?? "").split(",")) {
    const tag = part.split(";")[0].trim().toLowerCase();
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

export function pageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

interface Strings {
  title: string;
  tagline: string;
  gated: string;
  drop: string;
  pick: string;
  pasteHint: string;
  noticeTitle: string;
  notices: string[];
  curlTitle: string;
  curlBody: string;
  abuseTitle: string;
  abuseBody: string;
  switchLabel: string;
  // Messages used by the browser script.
  js: Record<string, string>;
}

function strings(o: PageOptions): Strings {
  const mb = String(o.maxMiB);
  const rate = String(o.rateLimit);
  const period = String(o.ratePeriodSeconds);
  if (o.lang === "zh") {
    return {
      title: "sugi 匿名图床",
      tagline: "免注册的匿名图床。上传图片，拿到直链。",
      gated: "暂未开放匿名上传：服务还在内测，目前只接受带令牌的上传。",
      drop: "把图片拖到这里，或点击选择文件",
      pick: "选择文件",
      pasteHint: "也可以直接 Ctrl+V / ⌘V 粘贴剪贴板里的图片。",
      noticeTitle: "上传前请看",
      notices: [
        "上传的图片<strong>公开</strong>且<strong>永久</strong>保存，任何拿到链接的人都能看到，上传后无法自行删除。",
        "不要上传含个人信息、密码、密钥或令牌的图片。",
        `只接受 PNG、JPEG、WebP、GIF，按文件内容判断类型；单个文件最大 ${mb} MB。`,
        `每个来源每 ${period} 秒最多 ${rate} 次上传，超出会暂时被拒绝。`,
        "相同内容总是得到同一个链接。",
      ],
      curlTitle: "命令行上传",
      curlBody: "返回图片直链（纯文本）；请求头带 <code>Accept: application/json</code> 时返回 JSON。",
      abuseTitle: "滥用举报",
      abuseBody: '发现违法或侵权内容，请把图片链接发到 <a href="mailto:abuse@sugi.moe">abuse@sugi.moe</a>。',
      switchLabel: "English",
      js: {
        uploading: "上传中…",
        copy: "复制",
        copied: "已复制",
        link: "直链",
        markdown: "Markdown",
        gated: "暂未开放匿名上传。",
        tooLarge: `文件太大，单个文件最大 ${mb} MB。`,
        badType: "不支持这种文件，只接受 PNG、JPEG、WebP、GIF。",
        rateLimited: "上传太频繁，请稍等 {s} 秒再试。",
        network: "网络错误，上传没有完成。",
        failed: "上传失败（HTTP {status}）：{msg}",
        noImages: "剪贴板或拖入的内容里没有文件。",
      },
    };
  }
  return {
    title: "sugi image host",
    tagline: "Anonymous image hosting, no account needed. Upload an image, get a direct link.",
    gated: "Anonymous uploads are not open yet: the service is in a closed test and only accepts uploads with a token.",
    drop: "Drop images here, or click to choose files",
    pick: "Choose files",
    pasteHint: "You can also paste an image from the clipboard with Ctrl+V / ⌘V.",
    noticeTitle: "Before you upload",
    notices: [
      "Uploads are <strong>public</strong> and <strong>permanent</strong>: anyone with the link can see them, and you cannot delete them yourself.",
      "Do not upload images containing personal information, passwords, keys or tokens.",
      `Images only: PNG, JPEG, WebP and GIF, detected from the file contents; at most ${mb} MB per file.`,
      `Each client may upload at most ${rate} files per ${period} seconds; beyond that uploads are refused for a while.`,
      "The same content always gets the same link.",
    ],
    curlTitle: "Upload from the command line",
    curlBody: "Returns the direct link as plain text, or JSON when you send <code>Accept: application/json</code>.",
    abuseTitle: "Report abuse",
    abuseBody: 'To report illegal or infringing content, send the image link to <a href="mailto:abuse@sugi.moe">abuse@sugi.moe</a>.',
    switchLabel: "中文",
    js: {
      uploading: "Uploading…",
      copy: "Copy",
      copied: "Copied",
      link: "Link",
      markdown: "Markdown",
      gated: "Anonymous uploads are not open yet.",
      tooLarge: `File too large: the limit is ${mb} MB per file.`,
      badType: "Unsupported file: only PNG, JPEG, WebP and GIF are accepted.",
      rateLimited: "Too many uploads, please wait {s} seconds and try again.",
      network: "Network error, the upload did not complete.",
      failed: "Upload failed (HTTP {status}): {msg}",
      noImages: "There were no files in what you pasted or dropped.",
    },
  };
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #fff; --line: #d2d2d7; --soft: #f5f5f7; --accent: #2f6f4f; --warn-bg: #fff4d6; --warn-fg: #5c4400; --err: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --bg: #161617; --line: #3a3a3c; --soft: #232325; --accent: #7cc39b; --warn-bg: #3d3216; --warn-fg: #f3dd9b; --err: #ff8a80; } }
* { box-sizing: border-box; }
body { font: 16px/1.6 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 46rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; color: var(--fg); background: var(--bg); }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
h1 { font-size: 1.6rem; margin: 0; }
h2 { font-size: 1.1rem; margin: 2rem 0 0.5rem; }
.lang { font-size: 0.9rem; color: var(--muted); }
a { color: var(--accent); }
.tagline { color: var(--muted); margin-top: 0.25rem; }
.gate { padding: 0.6rem 0.8rem; border-radius: 8px; background: var(--warn-bg); color: var(--warn-fg); }
#drop { display: block; width: 100%; margin-top: 1rem; padding: 2.5rem 1rem; border: 2px dashed var(--line); border-radius: 12px; background: var(--soft); color: var(--fg); font: inherit; text-align: center; cursor: pointer; }
#drop:hover, #drop:focus-visible, #drop.over { border-color: var(--accent); outline: none; }
#drop small { display: block; color: var(--muted); margin-top: 0.4rem; }
#file { display: none; }
#results { list-style: none; padding: 0; margin: 1rem 0 0; }
#results li { display: grid; grid-template-columns: 4.5rem 1fr; gap: 0.75rem; align-items: start; padding: 0.75rem 0; border-top: 1px solid var(--line); }
#results img { width: 4.5rem; height: 4.5rem; object-fit: contain; background: var(--soft); border-radius: 6px; }
.name { font-weight: 600; word-break: break-all; }
.row { display: flex; gap: 0.4rem; margin-top: 0.35rem; align-items: center; }
.row label { width: 5.5rem; flex: none; color: var(--muted); font-size: 0.85rem; }
.row input { flex: 1; min-width: 0; font: 0.85rem ui-monospace, SFMono-Regular, Menlo, monospace; padding: 0.3rem 0.4rem; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
.row button { font: inherit; font-size: 0.85rem; padding: 0.3rem 0.7rem; border: 1px solid var(--line); border-radius: 6px; background: var(--soft); color: var(--fg); cursor: pointer; }
.status { color: var(--muted); }
.error { color: var(--err); }
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88em; background: var(--soft); border-radius: 4px; }
code { padding: 0.05rem 0.25rem; }
pre { padding: 0.75rem; overflow-x: auto; }
ul.notes { padding-left: 1.2rem; }
`;

// Runs in the browser. Uploads go to the same origin with no credentials, so the page itself never holds a token.
const SCRIPT = `
(function () {
  var T = JSON.parse(document.getElementById("i18n").textContent);
  var MAX = T.maxBytes;
  var drop = document.getElementById("drop");
  var input = document.getElementById("file");
  var results = document.getElementById("results");
  var queue = Promise.resolve();

  function fmt(s, vars) { return s.replace(/\\{(\\w+)\\}/g, function (_, k) { return vars[k] === undefined ? "" : String(vars[k]); }); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  function copy(text, button) {
    function done() { button.textContent = T.copied; setTimeout(function () { button.textContent = T.copy; }, 1500); }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else { fallback(); }
    function fallback() {
      var ta = el("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } finally { document.body.removeChild(ta); }
    }
  }

  function field(label, value) {
    var row = el("div", "row");
    var lab = el("label", null, label);
    var box = el("input"); box.readOnly = true; box.value = value; box.addEventListener("focus", function () { box.select(); });
    var btn = el("button", null, T.copy); btn.type = "button";
    btn.addEventListener("click", function () { copy(value, btn); });
    row.appendChild(lab); row.appendChild(box); row.appendChild(btn);
    return row;
  }

  function errorText(status, body, retryAfter) {
    if (status === 401) return T.gated;
    if (status === 413) return T.tooLarge;
    if (status === 415) return T.badType;
    if (status === 429) return fmt(T.rateLimited, { s: retryAfter || "60" });
    return fmt(T.failed, { status: status, msg: (body && body.error) || "" });
  }

  function upload(file) {
    var li = el("li");
    var thumb = el("img"); thumb.alt = "";
    var info = el("div");
    var name = el("div", "name", file.name || "clipboard");
    var status = el("div", "status", T.uploading);
    info.appendChild(name); info.appendChild(status);
    li.appendChild(thumb); li.appendChild(info);
    results.insertBefore(li, results.firstChild);

    if (file.size > MAX) { status.className = "error"; status.textContent = T.tooLarge; return Promise.resolve(); }
    return fetch("/upload", { method: "PUT", body: file, headers: { "Accept": "application/json" }, credentials: "omit" })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) {
          if (res.ok && body && body.url) {
            thumb.src = body.url;
            info.removeChild(status);
            info.appendChild(field(T.link, body.url));
            info.appendChild(field(T.markdown, "![](" + body.url + ")"));
            li.setAttribute("data-url", body.url);
          } else {
            status.className = "error";
            status.textContent = errorText(res.status, body, res.headers.get("retry-after"));
            li.setAttribute("data-error", String(res.status));
          }
        });
      }, function () { status.className = "error"; status.textContent = T.network; li.setAttribute("data-error", "network"); });
  }

  function handle(files) {
    var list = Array.prototype.slice.call(files || []).filter(function (f) { return f && f.size !== undefined; });
    if (list.length === 0) { var li = el("li"); li.appendChild(el("span")); li.appendChild(el("div", "error", T.noImages)); results.insertBefore(li, results.firstChild); return; }
    // One at a time keeps a batch inside the rate limit's burst allowance and keeps results in order.
    list.forEach(function (f) { queue = queue.then(function () { return upload(f); }); });
  }

  drop.addEventListener("click", function () { input.click(); });
  input.addEventListener("change", function () { handle(input.files); input.value = ""; });
  ["dragenter", "dragover"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "dragend"].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) { e.preventDefault(); drop.classList.remove("over"); handle(e.dataTransfer && e.dataTransfer.files); });
  document.addEventListener("dragover", function (e) { e.preventDefault(); });
  document.addEventListener("drop", function (e) { if (e.target !== drop && !drop.contains(e.target)) { e.preventDefault(); handle(e.dataTransfer && e.dataTransfer.files); } });
  document.addEventListener("paste", function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    var files = [];
    for (var i = 0; i < items.length; i++) { if (items[i].kind === "file") { var f = items[i].getAsFile(); if (f) files.push(f); } }
    if (files.length) { e.preventDefault(); handle(files); }
  });
})();
`;

// JSON inside a <script> element must not be able to close it.
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function renderIndex(o: PageOptions): string {
  const t = strings(o);
  const origin = escapeHtml(o.origin);
  const nonce = escapeHtml(o.nonce);
  const other: Lang = o.lang === "zh" ? "en" : "zh";
  const gate = o.gated ? `<p class="gate" id="gate">${t.gated}</p>` : "";
  return `<!doctype html>
<html lang="${o.lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${t.title}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<header>
<h1>sugi</h1>
<a class="lang" href="/?lang=${other}" hreflang="${other}">${t.switchLabel}</a>
</header>
<p class="tagline">${t.tagline}</p>
${gate}
<button type="button" id="drop">${t.drop}<small>${t.pasteHint}</small></button>
<input type="file" id="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" aria-label="${t.pick}">
<ul id="results" aria-live="polite"></ul>
<h2>${t.noticeTitle}</h2>
<ul class="notes">
${t.notices.map((n) => `<li>${n}</li>`).join("\n")}
</ul>
<h2>${t.curlTitle}</h2>
<pre>curl -F file=@image.png ${origin}/upload
curl -T image.png ${origin}/upload</pre>
<p>${t.curlBody}</p>
<h2>${t.abuseTitle}</h2>
<p>${t.abuseBody}</p>
<script type="application/json" id="i18n">${jsonForScript({ ...t.js, maxBytes: o.maxMiB * 1024 * 1024 })}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}
