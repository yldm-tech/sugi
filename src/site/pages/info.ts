import { MCP_MAX_BYTES } from "../../mcp";
import { ALBUM_MAX_FILES, MAX_FILE_BYTES, RATE_LIMIT, RATE_LIMIT_PERIOD_SECONDS, SINGLE_REQUEST_MAX_BYTES, UPLOAD_LINK_MAX, UPLOAD_LINK_TTL_SECONDS, WAF_LIMIT, WAF_PERIOD_SECONDS } from "../../limits";
import { esc } from "../i18n";
import { brand } from "../../config";
import { Ctx, mailLink, Page, pageTitle, tr } from "../layout";
import { LOST_HAMSTER, peekHamster } from "../svg";

const MiB = 1024 * 1024;

interface Line {
  kind: "cmd" | "out" | "comment" | "json";
  text: string;
  indent?: number;
  gap?: boolean;
}

function codeBlock(ctx: Ctx, lines: Line[]): string {
  const t = tr(ctx);
  const body = lines
    .map((l) => {
      const cls = [l.gap ? "mt10" : "", l.indent ? `i${l.indent}` : ""].filter(Boolean).join(" ");
      const c = cls ? ` class="${cls}"` : "";
      if (l.kind === "cmd") return `<div${c} data-l data-c><span class="ps">$ </span><span data-t>${esc(l.text)}</span></div>`;
      if (l.kind === "out") return `<div class="s${cls ? " " + cls : ""}" data-l>${esc(l.text)}</div>`;
      if (l.kind === "comment") return `<div class="cm${cls ? " " + cls : ""}" data-l>${esc(l.text)}</div>`;
      return `<div${c} data-l data-i="${l.indent ?? 0}">${l.text}</div>`;
    })
    .join("\n");
  return `<div class="code" data-code><div class="bar2"><div class="dots"><i></i><i></i><i></i></div><button type="button" class="copy" data-copy-code>${t("复制", "Copy")}</button></div><div class="lines">
${body}
</div></div>`;
}

function jsonLine(key: string, value: string, indent: number, last = false): Line {
  return { kind: "json", indent, text: `<span class="k">"${key}"</span>: ${value}${last ? "" : ","}` };
}
const str = (s: string) => `<span class="s">"${esc(s)}"</span>`;

export function devPage(ctx: Ctx): Page {
  const t = tr(ctx);
  const main = ctx.env.MAIN_ORIGIN;
  const api = `${main}/api/upload`;
  const maxMb = MAX_FILE_BYTES / MiB;
  const singleMb = SINGLE_REQUEST_MAX_BYTES / MiB;
  const rows: [string, string][] = [
    ["POST /api/upload", t(`上传：multipart 字段 file（文件）或 url（链接），可选 expire（1h、12h、72h，不填就是永久）、style（random 或 cute）、name（显示用的文件名）。单个请求最多 ${singleMb} MB`, `Upload: multipart field file, or url to import a link; optional expire (1h, 12h, 72h; omit for forever), style (random or cute), name (display name). Up to ${singleMb} MB per request`)],
    ["PUT /api/upload", t("同上，但请求体就是文件本身，选项放在查询参数里（?expire=1h&style=cute&name=a.png）", "Same, with the raw file as the body and the options in the query string (?expire=1h&style=cute&name=a.png)")],
    ["POST /api/uploads?size=…", t(`分片上传（${singleMb} MB 以上、最多 ${maxMb} MB）：请求体是第一片（5 到 ${singleMb} MB），返回 upload 会话、片大小和片数`, `Chunked upload for files over ${singleMb} MB (up to ${maxMb} MB): the body is part 1 (5 to ${singleMb} MB); returns an upload session, the part size and the part count`)],
    ["PUT /api/uploads/:n", t("上传第 n 片，请求头 Sugi-Upload: 会话；返回这一片的 etag", "Upload part n with the header Sugi-Upload: <session>; returns the part's etag")],
    ["POST /api/uploads/complete", t('结束分片上传，请求头带会话，JSON {"etags": [...]}；返回和 /api/upload 一样的结果。DELETE /api/uploads 放弃', 'Finish a chunked upload with the session header and JSON {"etags": [...]}; returns the same as /api/upload. DELETE /api/uploads aborts')],
    ["PUT /api/upload/<link>", t(`上传到 MCP 工具 create_upload 给的一次性链接：请求体就是文件（也可以用 multipart 的 file 字段），${UPLOAD_LINK_TTL_SECONDS / 60} 分钟内有效，只能用一次，返回和 /api/upload 一样的 JSON`, `Upload to a one-time link from the MCP tool create_upload: the body is the file (or a multipart "file" field), valid for ${UPLOAD_LINK_TTL_SECONDS / 60} minutes and only once; returns the same JSON as /api/upload`)],
    ["GET /api/files/:id", t("读取文件信息（链接、大小、类型、过期时间）", "File info (link, size, type, expiry)")],
    ["DELETE /api/files/:id", t("删除文件，需要请求头 Sugi-Token: delete_token", "Delete a file; needs the header Sugi-Token: <delete_token>")],
    ["POST /api/albums", t(`用 files=id1,id2（最多 ${ALBUM_MAX_FILES} 个）和可选 title 打包成一个分享链接，返回链接和删除凭证`, `Make one share link from files=id1,id2 (up to ${ALBUM_MAX_FILES}) and an optional title; returns the link and a delete token`)],
    ["GET /api/albums/:id", t("读取打包链接里的文件列表", "List the files in an album")],
    ["DELETE /api/albums/:id", t("删除打包链接（不会删除里面的文件），需要 Sugi-Token", "Delete an album (its files stay); needs Sugi-Token")],
  ];
  const html = `<section class="stack8">
<h1 class="h1">${t("给开发者的仓仓", "The hamster for developers")}</h1>
<p class="lead">${t(`HTTP API 和网页用的是同一套规则：不登录也能直接用，单个文件最大 ${maxMb} MB，只收图片和短视频（PNG、JPEG、WebP、GIF、AVIF、MP4、WebM，按内容识别格式）。`, `The HTTP API follows the same rules as the website: no account needed, up to ${maxMb} MB per file, images and short videos only (PNG, JPEG, WebP, GIF, AVIF, MP4, WebM, detected from the content).`)}</p>
${ctx.gated ? `<p class="lead">${t("现在还在内测：上传接口暂时需要请求头 <code class=\"chip\">Authorization: Bearer &lt;token&gt;</code>，匿名请求会得到 401。", "Closed test for now: the upload endpoints need <code class=\"chip\">Authorization: Bearer &lt;token&gt;</code>, anonymous requests get 401.")}</p>` : ""}
</section>
${ctx.flags.cli ? `<div class="seg big" data-tabs="dev" role="tablist"><button type="button" class="on" data-tab="api" role="tab">HTTP API</button><button type="button" data-tab="cli" role="tab">${t("命令行 CLI", "CLI")}</button><button type="button" data-tab="mcp" role="tab">MCP</button></div>` : ""}

<section class="stack" data-panel="dev:api">
<h2 class="h2">${t("上传", "Upload")}</h2>
${codeBlock(ctx, [
  { kind: "comment", text: t("# 永久保存，返回直链", "# keep forever, prints the direct link") },
  { kind: "cmd", text: `curl -F "file=@cat.png" ${api}` },
  { kind: "out", text: `${ctx.env.FILES_ORIGIN}/k3x9qa2m.png` },
  { kind: "comment", text: t("# 临时保存：1h / 12h / 72h", "# temporary: 1h / 12h / 72h"), gap: true },
  { kind: "cmd", text: `curl -F "file=@cat.png" -F "expire=1h" ${api}` },
  { kind: "comment", text: t("# 从链接搬运", "# import from a link"), gap: true },
  { kind: "cmd", text: `curl -F "url=https://example.com/a.png" ${api}` },
  { kind: "comment", text: t("# 直接 PUT 文件内容", "# PUT the raw file"), gap: true },
  { kind: "cmd", text: `curl -T cat.png "${api}?expire=12h"` },
])}

<h2 class="h2 gap">${t("想要 JSON？", "Want JSON?")}</h2>
<p class="lead">${t('加上 <code class="chip">Accept: application/json</code>，会多返回删除凭证和过期时间。', 'Send <code class="chip">Accept: application/json</code> to also get the delete token and the expiry.')}</p>
${codeBlock(ctx, [
  { kind: "json", text: "{" },
  jsonLine("url", str(`${ctx.env.FILES_ORIGIN}/k3x9qa2m.png`), 2),
  jsonLine("id", str("k3x9qa2m"), 2),
  jsonLine("page", str(`${main}/f/k3x9qa2m`), 2),
  jsonLine("size", "482113", 2),
  jsonLine("type", str("image/png"), 2),
  jsonLine("name", str("cat.png"), 2),
  jsonLine("expires_at", "null", 2),
  jsonLine("delete_token", str("d_7Yq2…"), 2, true),
  { kind: "json", text: "}" },
])}

<h2 class="h2 gap">${t("删除", "Delete")}</h2>
${codeBlock(ctx, [{ kind: "cmd", text: `curl -X DELETE -H "Sugi-Token: d_7Yq2…" ${main}/api/files/k3x9qa2m` }])}

<h2 class="h2 gap">${t("全部接口", "All endpoints")}</h2>
<div class="card apitable">
${rows.map(([path, desc]) => `<div class="apirow"><code>${esc(path)}</code><span>${esc(desc)}</span></div>`).join("\n")}
</div>
<p class="small">${t(
    `限流：每个 IP 每 ${RATE_LIMIT_PERIOD_SECONDS} 秒最多 ${RATE_LIMIT} 次上传（一次上传、一次链接搬运、一次分片上传的开始各算一次），打包链接另算，也是 ${RATE_LIMIT_PERIOD_SECONDS} 秒 ${RATE_LIMIT} 次；另外防火墙对 /upload、/api/upload 和 /api/uploads 每个 IP 每 ${WAF_PERIOD_SECONDS} 秒最多 ${WAF_LIMIT} 次请求，超过会被拦 ${WAF_PERIOD_SECONDS} 秒。超过限制会返回 429，歇一下再来就好。`,
    `Rate limits: each IP may start ${RATE_LIMIT} uploads per ${RATE_LIMIT_PERIOD_SECONDS} seconds (an upload, a link import and the start of a chunked upload each count once), and separately create ${RATE_LIMIT} albums per ${RATE_LIMIT_PERIOD_SECONDS} seconds. On top of that the firewall allows ${WAF_LIMIT} requests per ${WAF_PERIOD_SECONDS} seconds per IP to /upload, /api/upload and /api/uploads, and blocks for ${WAF_PERIOD_SECONDS} seconds beyond that. Over a limit you get 429; wait a moment and try again.`,
  )}</p>
<p class="small">${t(
    `旧接口 <code class="chip">POST /upload</code> 继续可用：只收 PNG、JPEG、WebP、GIF，最大 20 MB，链接是 ${main}/&lt;内容哈希&gt;.png 这种形式，相同内容得到同一个链接，没有删除凭证。`,
    `The original <code class="chip">POST /upload</code> keeps working: PNG, JPEG, WebP and GIF only, up to 20 MB, links look like ${main}/&lt;content hash&gt;.png, the same content always gets the same link, and there is no delete token.`,
  )}</p>
</section>
${ctx.flags.cli ? cliPanel(ctx) + mcpPanel(ctx) : ""}`;
  return { id: "dev", title: pageTitle(ctx, "开发者", "Developers"), main: html, description: t(`${brand(ctx.env).siteName} 的 HTTP API：curl 一行上传图片和视频，返回直链和删除凭证；支持临时文件、链接搬运、打包链接和分片上传。`, `The ${brand(ctx.env).siteName} HTTP API: upload images and videos with one curl command and get a direct link and a delete token; temporary files, link import, albums and chunked uploads.`) };
}

function cliPanel(ctx: Ctx): string {
  const t = tr(ctx);
  const files = ctx.env.FILES_ORIGIN;
  return `<section class="stack" data-panel="dev:cli" hidden>
<h2 class="h2">${t("安装", "Install")}</h2>
${codeBlock(ctx, [{ kind: "cmd", text: `curl -fsSL ${ctx.env.MAIN_ORIGIN}/install.sh | sh` }])}
<p class="small">${t("一个 bash 脚本，只依赖 curl，macOS、Linux 和 WSL 都能用；装到 ~/.local/bin/sugi，安装脚本会校验下载文件的 SHA-256。", "A single bash script that only needs curl; works on macOS, Linux and WSL. It goes to ~/.local/bin/sugi and the installer checks the download's SHA-256.")}</p>
<h2 class="h2 gap">${t("常用命令", "Everyday commands")}</h2>
${codeBlock(ctx, [
  { kind: "comment", text: t("# 传一个或很多个，链接自动进剪贴板", "# upload one or many; the links land on your clipboard") },
  { kind: "cmd", text: "sugi up cat.png dog.gif" },
  { kind: "out", text: `✿ cat.png  →  ${files}/k3x9qa2m.png` },
  { kind: "out", text: `✿ dog.gif  →  ${files}/p0w2nd7x.gif` },
  { kind: "comment", text: t("# 临时保存 1 小时", "# keep for 1 hour"), gap: true },
  { kind: "cmd", text: "sugi up -e 1h secret.jpg" },
  { kind: "comment", text: t("# 直接传剪贴板里的截图", "# upload the screenshot on your clipboard"), gap: true },
  { kind: "cmd", text: "sugi up --clipboard" },
  { kind: "comment", text: t("# 从管道读", "# read from a pipe"), gap: true },
  { kind: "cmd", text: "cat cat.png | sugi up - --name cat.png" },
  { kind: "comment", text: t("# 打包成一个分享链接", "# bundle into one share link"), gap: true },
  { kind: "cmd", text: `sugi album "${t("猫猫合集", "Cats")}" *.png` },
  { kind: "comment", text: t("# 查看和删除自己传过的", "# list and delete what you uploaded"), gap: true },
  { kind: "cmd", text: "sugi ls" },
  { kind: "cmd", text: "sugi rm k3x9qa2m" },
  ...(ctx.flags.accounts ? [{ kind: "comment" as const, text: t("# 登录账号，之后传的都会同步（可选）", "# log in so uploads go to your account (optional)"), gap: true }, { kind: "cmd" as const, text: "sugi login" }] : []),
])}
<p class="small">${t('CLI 会把删除凭证存在 <code class="chip">~/.config/sugi/history.jsonl</code>，所以 sugi rm 只能删这台电脑传过的文件。超过 90 MB 的文件会自动分片上传。加 --json 可以拿到完整返回；SUGI_TOKEN 环境变量里的令牌会作为 Authorization: Bearer 发出去。', 'The CLI keeps delete tokens in <code class="chip">~/.config/sugi/history.jsonl</code>, so sugi rm can only delete files uploaded from this machine. Files over 90 MB are uploaded in chunks automatically. Add --json for the full responses; a token in SUGI_TOKEN is sent as Authorization: Bearer.')}</p>
</section>`;
}

function mcpPanel(ctx: Ctx): string {
  const t = tr(ctx);
  const mcp = `${ctx.env.MAIN_ORIGIN}/mcp`;
  const tool = (name: string, desc: string) => `<div class="card feature"><code class="toolname">${name}</code><span class="d">${desc}</span></div>`;
  return `<section class="stack" data-panel="dev:mcp" hidden>
<p class="lead">${t(`接上 sugi 的 MCP 服务后，AI 助手可以直接上传文件、搬运链接、建打包链接，然后把链接交给你。服务地址是 <code class="chip">${mcp}</code>（Streamable HTTP）。AI 能跑命令时，传本地文件最快的是命令行 <code class="chip">sugi up</code>；没装命令行就用 <code class="chip">create_upload</code> 拿一次性上传链接，再用 curl 把文件传上去，几十个文件也只要一次工具调用。<code class="chip">upload_file</code>（base64，最大 ${MCP_MAX_BYTES / MiB} MB）只适合 AI 自己生成的小内容。`, `Connect the sugi MCP server and your AI assistant can upload files, fetch links and make albums, then hand you the links. The server lives at <code class="chip">${mcp}</code> (Streamable HTTP). If the AI can run commands, the fastest way to upload local files is the <code class="chip">sugi up</code> CLI; without it, <code class="chip">create_upload</code> hands out one-time upload links that curl can send files to, dozens of files in one tool call. <code class="chip">upload_file</code> (base64, up to ${MCP_MAX_BYTES / MiB} MB) is only for small content the AI generated itself.`)}</p>
<div class="results-head"><h2 class="h2">${t("接入", "Connect")}</h2><div class="seg" data-tabs="mcp" role="tablist"><button type="button" class="on" data-tab="code" role="tab">Claude Code</button><button type="button" data-tab="desktop" role="tab">Claude Desktop</button><button type="button" data-tab="cursor" role="tab">Cursor</button></div></div>
<div data-panel="mcp:code">${codeBlock(ctx, [
  { kind: "cmd", text: `claude mcp add --transport http sugi ${mcp}` },
  ...(ctx.gated ? [{ kind: "comment" as const, text: t("# 内测期间带上令牌", "# during the closed test, add your token"), gap: true }, { kind: "cmd" as const, text: `claude mcp add --transport http sugi ${mcp} --header "Authorization: Bearer <token>"` }] : []),
])}</div>
<div data-panel="mcp:desktop" hidden><p class="lead">${t('把下面这段加进 <code class="chip">claude_desktop_config.json</code>，重启一下就好（用 mcp-remote 把远程服务接到桌面版）。', 'Add this to <code class="chip">claude_desktop_config.json</code> and restart (mcp-remote bridges the remote server into the desktop app).')}</p>
${codeBlock(ctx, [
  { kind: "json", text: "{" },
  { kind: "json", indent: 2, text: '<span class="k">"mcpServers"</span>: {' },
  { kind: "json", indent: 4, text: '<span class="k">"sugi"</span>: {' },
  jsonLine("command", str("npx"), 6),
  { kind: "json", indent: 6, text: `<span class="k">"args"</span>: [${str("-y")}, ${str("mcp-remote")}, ${str(mcp)}]` },
  { kind: "json", indent: 4, text: "}" },
  { kind: "json", indent: 2, text: "}" },
  { kind: "json", text: "}" },
])}</div>
<div data-panel="mcp:cursor" hidden><p class="lead">${t('把下面这段加进 <code class="chip">~/.cursor/mcp.json</code>。', 'Add this to <code class="chip">~/.cursor/mcp.json</code>.')}</p>
${codeBlock(ctx, [
  { kind: "json", text: "{" },
  { kind: "json", indent: 2, text: '<span class="k">"mcpServers"</span>: {' },
  { kind: "json", indent: 4, text: `<span class="k">"sugi"</span>: { <span class="k">"url"</span>: ${str(mcp)} }` },
  { kind: "json", indent: 2, text: "}" },
  { kind: "json", text: "}" },
])}</div>
<h2 class="h2 gap">${t("仓仓会的工具", "Tools")}</h2>
<div class="features">
${tool("create_upload", t(`给本地文件要一次性上传链接（一次最多 ${UPLOAD_LINK_MAX} 个，${UPLOAD_LINK_TTL_SECONDS / 60} 分钟内有效），用 curl -T 上传`, `One-time upload links for local files (up to ${UPLOAD_LINK_MAX} per call, valid ${UPLOAD_LINK_TTL_SECONDS / 60} minutes), uploaded with curl -T`))}
${tool("upload_file", t(`上传 base64 内容（最大 ${MCP_MAX_BYTES / MiB} MB），只适合 AI 生成的小文件`, `Upload base64 content (up to ${MCP_MAX_BYTES / MiB} MB), for small generated content`))}
${tool("upload_url", t("把网上的图片或视频搬到 sugi", "Copy an image or video from the web to sugi"))}
${tool("create_album", t("把几个文件打包成一个分享链接", "Bundle files into one share link"))}
${tool("get_file", t("查文件的链接、大小和过期时间", "Look up a file's link, size and expiry"))}
${tool("delete_file", t("用上传时拿到的 delete_token 删除文件", "Delete a file with the delete_token from its upload"))}
</div>
<h2 class="h2 gap">${t("试着这样说", "Try saying")}</h2>
<div class="chat"><div class="me">${t("把这几张截图传到 sugi，打包成一个链接，标题叫「周报配图」", "Upload these screenshots to sugi and bundle them into one link titled “Weekly report”")}</div><div class="bot">${t("传好啦，一共 4 张～", "Done, 4 pictures~")}<br><span class="link">${ctx.env.MAIN_ORIGIN}/a/w8k2ru5d</span></div></div>
</section>`;
}

function faqItem(q: string, a: string): { q: string; a: string } {
  return { q, a };
}

const stripTags = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

export function faqPage(ctx: Ctx): Page {
  const t = tr(ctx);
  const b = brand(ctx.env);
  const host = (o: string) => o.replace(/^https?:\/\//, "");
  const contact = mailLink(b.contactEmail);
  const abuse = mailLink(b.abuseEmail);
  const maxMb = MAX_FILE_BYTES / MiB;
  const singleMb = SINGLE_REQUEST_MAX_BYTES / MiB;
  const items = [
    faqItem(t("sugi 是什么意思？", "What does “sugi” mean?"), t("日语里有两个意思：「杉」是柳杉，所以仓仓头上顶着一棵杉树苗；「〜すぎ」是“太……了”，かわいすぎ 就是太可爱了。仓仓是一只什么都往腮帮子里屯的仓鼠，屯太多的时候会说「屯すぎ！」。", "Two things in Japanese: 杉 (sugi) is the Japanese cedar, which is why the hamster has a cedar sprout on its head, and 〜すぎ (-sugi) means “too much”, as in かわいすぎ, “way too cute”. The hamster stuffs everything into its cheeks, and when it has stuffed too much it says “too much!”.")),
    faqItem(t("一定要注册吗？", "Do I need an account?"), ctx.flags.accounts ? t("不用。不登录也能传，记录只保存在当前浏览器里。想换设备也不丢，可以登录，之前传的文件能一键认领。", "No. You can upload without logging in; your history stays in this browser. Log in if you want it on every device, and claim your earlier uploads in one click.") : t("不用，sugi 现在没有账号，打开就能传。上传记录和删除凭证保存在你当前用的浏览器里（「我的文件」），可以随时导出一份备份。", "No. sugi has no accounts right now; just open it and upload. Your history and delete tokens are kept in this browser (“My files”), and you can export them at any time.")),
    faqItem(t("文件会保存多久？", "How long are files kept?"), t(`选「永久」的文件会一直保存，除非违反使用条款被删除，或者你用删除凭证自己删掉。选 1 小时、12 小时或 3 天的，链接放在 ${host(ctx.env.TMP_ORIGIN)} 下，到期后链接立刻失效，文件会在之后十分钟左右内被清理。`, `Files kept “forever” stay until they break the terms or you delete them with their delete token. Files kept for 1 hour, 12 hours or 3 days get a ${host(ctx.env.TMP_ORIGIN)} link that stops working the moment it expires; the file itself is cleaned up within about ten minutes after that.`)),
    faqItem(t("能传什么格式？", "What can I upload?"), t(`图片和短视频：PNG、JPEG、WebP、GIF、AVIF、MP4、WebM。格式按文件内容判断，不看扩展名。单个文件最大 ${maxMb} MB，超过 ${singleMb} MB 的网页会自动分片上传。其他格式（SVG、HTML、PDF、压缩包、可执行文件等）一律不收。`, `Images and short videos: PNG, JPEG, WebP, GIF, AVIF, MP4 and WebM, recognised by their content rather than the file name. Up to ${maxMb} MB per file; the website splits anything over ${singleMb} MB into chunks for you. Everything else (SVG, HTML, PDF, archives, executables…) is refused.`)),
    faqItem(t("上传的文件谁能看到？", "Who can see my uploads?"), t("所有上传都是公开的，任何拿到链接的人都能打开。链接是随机生成的，不会被列出来，但「可爱链接名」组合少，更容易被猜到。不要上传含个人信息、证件、密码或密钥的图片。", "Every upload is public: anyone with the link can open it. Links are random and never listed anywhere, but cute link names come from a much smaller pool and are easier to guess. Do not upload pictures that show personal details, IDs, passwords or keys.")),
    faqItem(t("怎么删除自己传的文件？", "How do I delete something I uploaded?"), t(`在「我的文件」页找到文件点 ×。删除凭证只存在上传时用的那个浏览器里，换了浏览器或清理了浏览器数据就删不了，记得先导出记录。用 API 上传的，用返回的 delete_token 调 DELETE /api/files/:id。旧版链接（${host(ctx.env.MAIN_ORIGIN)}/一串十六进制.png）没有删除凭证，要删的话${contact ? `写信到 ${contact}` : "请联系这个网站的运营者"}。`, `Find it under “My files” and press ×. The delete token lives only in the browser you uploaded from, so if you switch browsers or clear its data you can no longer delete it; export your history first. For API uploads, call DELETE /api/files/:id with the delete_token you got back. Links in the old format (${host(ctx.env.MAIN_ORIGIN)}/<hex>.png) have no delete token; ${contact ? `write to ${contact}` : "contact the operator of this site"} to have one removed.`)),
    faqItem(t("换设备还能看到记录吗？", "Can I see my history on another device?"), t("看不到，记录只在当前浏览器里。可以在「我的文件」页点「导出记录」存一份。", "No, the history lives in this browser only. Use “Export” on the “My files” page to save a copy.")),
    faqItem(t("照片里的位置信息会被抹掉吗？", "Is the location in my photos removed?"), t("在网页上传时，默认勾选的「抹掉照片位置信息」会在你的浏览器里、上传之前删掉 JPEG、PNG、WebP 里的 EXIF 和 XMP 元数据（GPS、相机型号、拍摄时间都在里面），JPEG 只保留照片方向。AVIF 和视频不处理，用 API 上传的文件也不会被改动。", "When you upload on the website, the “Strip photo location” option (on by default) removes the EXIF and XMP metadata from JPEG, PNG and WebP files in your browser before upload; that is where GPS position, camera model and capture time live. For JPEG only the orientation is kept. AVIF files, videos and anything uploaded through the API are left untouched.")),
    faqItem(t("sugi 会记录我的什么？", "What does sugi record about me?"), t("不保存你的 IP 地址。每个文件会记下上传时间、文件名（如果有）和上传者 IP 的 HMAC 指纹（用服务器密钥算出来，不能反推出 IP），只用来在出现滥用时找出并清除同一来源的上传。网站没有统计脚本，也没有广告。sugi 运行在 Cloudflare 上，请求会经过 Cloudflare 的网络。详见 <a href=\"/privacy\" data-nav>隐私政策</a>。", "Not your IP address. With each file we keep its upload time, its file name if it had one, and an HMAC fingerprint of the uploader's IP made with a server-side key, which cannot be turned back into the IP. The fingerprint is only used to find and remove everything from the same source when there is abuse. The site has no analytics and no ads. sugi runs on Cloudflare, so requests pass through Cloudflare's network. See the <a href=\"/privacy\" data-nav>privacy policy</a>.")),
    faqItem(t("链接能直接贴到论坛、博客里吗？", "Can I embed the links in forums and blogs?"), t("可以，所有链接都是直链，支持外链和热链。上传完可以直接复制成 Markdown、HTML 或 BBCode。", "Yes. Every link is a direct link and hotlinking is allowed. You can copy them as Markdown, HTML or BBCode right after uploading.")),
    faqItem(t("看到不好的内容怎么办？", "I found something bad. What do I do?"), t(`${abuse ? `把链接发到 ${abuse}` : "把链接发给这个网站的运营者"}，确认违规后会删除。${b.csamScanning ? "通过 Cloudflare 缓存提供的内容还会由 Cloudflare 的 CSAM 扫描工具检测。" : ""}`, `${abuse ? `Send the link to ${abuse}` : "Send the link to the operator of this site"} and it will be removed once confirmed.${b.csamScanning ? " Content served through Cloudflare's cache is also checked by Cloudflare's CSAM Scanning Tool." : ""}`)),
    faqItem(t("仓仓靠什么活下去？", "Who pays for the hamster?"), ctx.flags.donate ? t("服务器和流量都是大家投喂的。如果仓仓帮到了你，可以 <a href=\"/donate\" data-nav>投喂一点瓜子</a>。", "Servers and bandwidth are paid for by people like you. If the hamster helped, you can <a href=\"/donate\" data-nav>toss it a few seeds</a>.") : t("目前由维护者自费运行，没有广告，也不卖数据。", "For now the maintainers pay for it themselves. There are no ads and no data is sold.")),
  ];
  const html = `<section class="stack8">
<h1 class="h1">${t("问问仓仓", "Ask the hamster")}</h1>
${contact ? `<p class="lead">${t(`没找到答案的话，写信到 ${contact}。`, `Didn't find your answer? Write to ${contact}.`)}</p>` : ""}
</section>
<section class="faq">
${items.map((i) => `<details class="card"><summary>${i.q}</summary><p>${i.a}</p></details>`).join("\n")}
</section>`;
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      inLanguage: ctx.lang === "zh" ? "zh-CN" : "en",
      mainEntity: items.map((i) => ({ "@type": "Question", name: stripTags(i.q), acceptedAnswer: { "@type": "Answer", text: stripTags(i.a) } })),
    },
  ];
  return { id: "faq", title: pageTitle(ctx, "问问题", "FAQ"), main: html, jsonLd, description: t(`关于 ${b.siteName} 的常见问题：文件保存多久、能传什么格式、怎么删除、我们记录什么。`, `Common questions about ${b.siteName}: how long files are kept, what you can upload, how to delete, and what we record.`) };
}

export function termsPage(ctx: Ctx): Page {
  const t = tr(ctx);
  const b = brand(ctx.env);
  const abuse = mailLink(b.abuseEmail);
  const maxMb = MAX_FILE_BYTES / MiB;
  const items = [
    t("禁止上传违法内容，包括但不限于儿童性剥削内容、侵犯他人版权的内容、他人的隐私信息。", "Do not upload anything illegal, including but not limited to child sexual abuse material, content that infringes someone else's copyright, and other people's private information."),
    t("禁止用 sugi 分发恶意软件、钓鱼页面或做任何诈骗。", "Do not use sugi to spread malware or phishing, or for any kind of fraud."),
    t(`只接受图片和短视频（PNG、JPEG、WebP、GIF、AVIF、MP4、WebM），单个文件最大 ${maxMb} MB。`, `Only images and short videos are accepted (PNG, JPEG, WebP, GIF, AVIF, MP4, WebM), up to ${maxMb} MB per file.`),
    t("所有上传都是公开的，任何拿到链接的人都能看到。只上传你有权公开的内容。", "Every upload is public and visible to anyone with the link. Only upload what you have the right to make public."),
    t("违规内容会被直接删除，不另行通知；必要时会配合执法机关。", "Content that breaks these rules is removed without notice; we cooperate with law enforcement when required."),
    t('为了处理滥用，每次上传会保存上传时间和上传者 IP 的 HMAC 指纹，不保存 IP 本身。详见 <a href="/privacy" data-nav>隐私政策</a>。', 'To deal with abuse we keep, for every upload, its time and an HMAC fingerprint of the uploader\'s IP, never the IP itself. See the <a href="/privacy" data-nav>privacy policy</a>.'),
    t("仓仓会尽力保管好每个文件，但不保证永不丢失，也不保证服务一直可用，重要文件请自己留备份。临时文件到期后会被删除。", "The hamster takes good care of every file, but cannot promise that nothing is ever lost or that the service is always up. Keep your own copy of anything important. Temporary files are deleted when they expire."),
    ...(ctx.flags.accounts ? [t("未满 16 岁请不要注册账号。", "If you are under 16, please do not create an account.")] : []),
    ...(abuse ? [t(`举报请写信到 ${abuse}。`, `Report abuse to ${abuse}.`)] : []),
  ];
  const html = `<section class="stack8">
<h1 class="h1">${t("使用条款", "Terms of use")}</h1>
<p class="lead">${b.operator ? t(`${esc(b.siteName)} 由 ${esc(b.operator)} 运营。用 ${esc(b.siteName)} 就代表你同意下面这些规则。`, `${esc(b.siteName)} is operated by ${esc(b.operator)}. By using ${esc(b.siteName)} you agree to the rules below.`) : t(`用 ${esc(b.siteName)} 就代表你同意下面这些规则。`, `By using ${esc(b.siteName)} you agree to the rules below.`)}</p>
</section>
<ol class="card terms">
${items.map((i) => `<li>${i}</li>`).join("\n")}
</ol>`;
  return { id: "terms", title: pageTitle(ctx, "使用条款", "Terms"), main: html, description: t(`使用 ${b.siteName} 的规则：能传什么、不能传什么、文件会保存多久。`, `The rules for using ${b.siteName}: what you may upload, what you may not, and how long files are kept.`) };
}

export function notFoundPage(ctx: Ctx): Page {
  const t = tr(ctx);
  const html = `<section class="nf">
<div class="art"><span class="q a" aria-hidden="true">?</span><span class="q b" aria-hidden="true">?</span>${LOST_HAMSTER}</div>
<div class="code404">404</div>
<h1>${t("仓仓翻遍了腮帮子也没找到", "Checked both cheeks, still can't find it")}</h1>
<p>${t("这个文件可能已经过期，被主人删掉了，或者链接抄错了一个字母。", "It may have expired, been deleted by its owner, or the link has a typo.")}</p>
<div class="acts"><a class="btn big" href="/" data-nav>${t("回首页", "Home")}</a><a class="btn big ghost" href="/mine" data-nav>${t("看看我的文件", "My files")}</a></div>
</section>`;
  return { id: "notfound", title: pageTitle(ctx, "找不到啦", "Not found"), main: html, status: 404, noindex: true };
}

// Visual only until accounts ship (FEATURE_ACCOUNTS); the buttons are not wired to anything yet.
export function loginPage(ctx: Ctx): Page {
  const t = tr(ctx);
  const html = `<section class="login"><div class="holder">
${peekHamster(110, 100, false)}<div class="paw l"></div><div class="paw r"></div>
<div class="frame">
<div class="center"><h1 class="h2">${t("登录 sugi", "Log in to sugi")}</h1><p class="lead">${t("不登录也能传。登录后记录跟着你走，换设备也不会丢。", "You can upload without an account. Logging in keeps your history on every device.")}</p></div>
<p class="small">${t("登录功能还在路上。", "Logging in is on its way.")}</p>
<p class="small">${t('登录即表示同意 <a href="/terms" data-nav>使用条款</a> 和 <a href="/privacy" data-nav>隐私政策</a>。', 'By logging in you agree to the <a href="/terms" data-nav>terms</a> and the <a href="/privacy" data-nav>privacy policy</a>.')}</p>
</div></div></section>`;
  return { id: "login", title: pageTitle(ctx, "登录", "Log in"), main: html };
}

// Hidden behind FEATURE_DONATE. Amounts, payment methods and the thank-you wall come from real data supplied by the maintainers; nothing is invented here.
export interface DonateData {
  monthlyCost: { label: string; amount: string }[];
  tiers: { icon: string; name: string; price: string; desc: string }[];
  methods: { label: string; url: string }[];
  supporters: string[];
}

export const DONATE_DATA: DonateData = { monthlyCost: [], tiers: [], methods: [], supporters: [] };

export function donatePage(ctx: Ctx, data: DonateData = DONATE_DATA): Page {
  const t = tr(ctx);
  const html = `<section class="center">
<h1 class="h1">${t("投喂仓仓", "Feed the hamster")}</h1>
<p class="lead">${t("sugi 没有广告，也不卖数据。服务器、存储和流量全靠大家投喂，每一粒瓜子都会变成硬盘空间。", "sugi has no ads and sells no data. Servers, storage and bandwidth are paid for by people who chip in; every seed turns into disk space.")}</p>
</section>
${data.tiers.length ? `<section class="features">${data.tiers.map((x) => `<div class="card feature"><div class="ic">${esc(x.icon)}</div><div class="t">${esc(x.name)} · ${esc(x.price)}</div><div class="d">${esc(x.desc)}</div></div>`).join("")}</section>` : ""}
${data.methods.length ? `<section class="row-actions">${data.methods.map((m) => `<a class="btn" href="${esc(m.url)}" rel="noopener">${esc(m.label)} →</a>`).join("")}</section>` : ""}
${data.supporters.length ? `<section class="stack"><h2 class="h2">${t("谢谢这些好心人", "Thank you")} <span class="heart">♡</span></h2><div class="badges">${data.supporters.map((s) => `<span class="badge">${esc(s)}</span>`).join("")}</div></section>` : ""}`;
  return { id: "donate", title: pageTitle(ctx, "投喂仓仓", "Feed the hamster"), main: html };
}
