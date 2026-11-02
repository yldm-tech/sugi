// The developer page: HTTP API reference, and with FEATURE_CLI the command-line and MCP tabs.
import { MCP_MAX_BYTES } from "../../mcp";
import {
  ALBUM_MAX_FILES,
  MAX_FILE_BYTES,
  RATE_LIMIT,
  RATE_LIMIT_PERIOD_SECONDS,
  SINGLE_REQUEST_MAX_BYTES,
  UPLOAD_LINK_MAX,
  UPLOAD_LINK_TTL_SECONDS,
  WAF_LIMIT,
  WAF_PERIOD_SECONDS,
} from "../../limits";
import { esc } from "../i18n";
import { quotas } from "../../quota";
import { BRAND_ICONS } from "../brand-icons";
import { brand } from "../../config";
import { type Ctx, type Page, pageTitle, tr } from "../layout";

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
      if (l.kind === "out") return `<div class="s${cls ? ` ${cls}` : ""}" data-l>${esc(l.text)}</div>`;
      if (l.kind === "comment") return `<div class="cm${cls ? ` ${cls}` : ""}" data-l>${esc(l.text)}</div>`;
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

function quotaLine(ctx: Ctx): string {
  const t = tr(ctx);
  const q = quotas(ctx.env);
  const gb = (b: number) => `${Math.round((b / 1024 ** 3) * 10) / 10} GB`;
  const parts = [
    ...(q.anon ? [t(`不登录时每个来源每天 ${gb(q.anon)}`, `${gb(q.anon)} per source without an account`)] : []),
    ...(q.account && ctx.flags.accounts ? [t(`登录账号每天 ${gb(q.account)}`, `${gb(q.account)} per account`)] : []),
  ];
  if (!parts.length && !q.global) return "";
  return `<p class="small">${t(
    `每日上传额度（按 UTC 日计）：${parts.join("，") || "不限"}。${q.global ? "整个网站每天的总量也有上限，到了之后当天只接受带可信令牌的上传。" : ""}超出时返回 429（个人额度）或 507（网站额度）。`,
    `Daily upload allowance (UTC days): ${parts.join(", ") || "unlimited"}.${q.global ? " The whole site also has a daily total; once it is reached only uploads with a trusted token are taken that day." : ""} Going over returns 429 (your allowance) or 507 (the site's).`,
  )}</p>`;
}

export function devPage(ctx: Ctx): Page {
  const b = brand(ctx.env);
  const wafRule = b.wafRule;
  const t = tr(ctx);
  const main = ctx.env.MAIN_ORIGIN;
  const api = `${main}/api/upload`;
  const maxMb = MAX_FILE_BYTES / MiB;
  const singleMb = SINGLE_REQUEST_MAX_BYTES / MiB;
  const rows: [string, string][] = [
    [
      "POST /api/upload",
      t(
        `上传：multipart 字段 file（文件）或 url（链接），可选 expire（1h、12h、72h，不填就是永久）、style（random 或 cute）、name（显示用的文件名）。单个请求最多 ${singleMb} MB`,
        `Upload: multipart field file, or url to import a link; optional expire (1h, 12h, 72h; omit for forever), style (random or cute), name (display name). Up to ${singleMb} MB per request`,
      ),
    ],
    [
      "PUT /api/upload",
      t(
        "同上，但请求体就是文件本身，选项放在查询参数里（?expire=1h&style=cute&name=a.png）",
        "Same, with the raw file as the body and the options in the query string (?expire=1h&style=cute&name=a.png)",
      ),
    ],
    [
      "POST /api/uploads?size=…",
      t(
        `分片上传（${singleMb} MB 以上、最多 ${maxMb} MB）：请求体是第一片（5 到 ${singleMb} MB），返回 upload 会话、片大小和片数`,
        `Chunked upload for files over ${singleMb} MB (up to ${maxMb} MB): the body is part 1 (5 to ${singleMb} MB); returns an upload session, the part size and the part count`,
      ),
    ],
    [
      "PUT /api/uploads/:n",
      t("上传第 n 片，请求头 Sugi-Upload: 会话；返回这一片的 etag", "Upload part n with the header Sugi-Upload: <session>; returns the part's etag"),
    ],
    [
      "POST /api/uploads/complete",
      t(
        '结束分片上传，请求头带会话，JSON {"etags": [...]}；返回和 /api/upload 一样的结果。DELETE /api/uploads 放弃',
        'Finish a chunked upload with the session header and JSON {"etags": [...]}; returns the same as /api/upload. DELETE /api/uploads aborts',
      ),
    ],
    [
      "PUT /api/upload/<link>",
      t(
        `上传到 MCP 工具 create_upload 给的一次性链接：请求体就是文件（也可以用 multipart 的 file 字段），${UPLOAD_LINK_TTL_SECONDS / 60} 分钟内有效，只能用一次，返回和 /api/upload 一样的 JSON`,
        `Upload to a one-time link from the MCP tool create_upload: the body is the file (or a multipart "file" field), valid for ${UPLOAD_LINK_TTL_SECONDS / 60} minutes and only once; returns the same JSON as /api/upload`,
      ),
    ],
    ["GET /api/files/:id", t("读取文件信息（链接、大小、类型、过期时间）", "File info (link, size, type, expiry)")],
    ["DELETE /api/files/:id", t("删除文件，需要请求头 Sugi-Token: delete_token", "Delete a file; needs the header Sugi-Token: <delete_token>")],
    [
      "POST /api/albums",
      t(
        `用 files=id1,id2（最多 ${ALBUM_MAX_FILES} 个）和可选 title 打包成一个分享链接，返回链接和删除凭证`,
        `Make one share link from files=id1,id2 (up to ${ALBUM_MAX_FILES}) and an optional title; returns the link and a delete token`,
      ),
    ],
    ["GET /api/albums/:id", t("读取打包链接里的文件列表", "List the files in an album")],
    ["DELETE /api/albums/:id", t("删除打包链接（不会删除里面的文件），需要 Sugi-Token", "Delete an album (its files stay); needs Sugi-Token")],
    [
      "POST /api/reports",
      t(
        "举报文件或打包链接：JSON {target: 链接, reason: csam|illegal|copyright|privacy|spam|other, details?, contact?}，返回 202，由人工处理",
        "Report a file or album: JSON {target: link, reason: csam|illegal|copyright|privacy|spam|other, details?, contact?}; returns 202 and a person reviews it",
      ),
    ],
  ];
  const html = `<section class="stack8">
<h1 class="h1">${t("给开发者的仓仓", "The hamster for developers")}</h1>
${
  b.sourceUrl
    ? `<p class="lead source-line">${BRAND_ICONS.github}<span>${t(`${esc(b.siteName)} 用的是开源的 sugi（MIT）：<a href="${esc(b.sourceUrl)}" rel="noopener">源代码</a>`, `${esc(b.siteName)} runs sugi, which is open source (MIT): <a href="${esc(b.sourceUrl)}" rel="noopener">source code</a>`)}${b.deployUrl ? t(`。你也可以自己托管一个：<a href="${esc(b.deployUrl)}" rel="noopener">部署到 Cloudflare</a>。`, `. You can host your own too: <a href="${esc(b.deployUrl)}" rel="noopener">Deploy to Cloudflare</a>.`) : t("。", ".")}</span></p>`
    : ""
}
<p class="lead">${t(`HTTP API 和网页用的是同一套规则：不登录也能直接用，单个文件最大 ${maxMb} MB，只收图片和短视频（PNG、JPEG、WebP、GIF、AVIF、MP4、WebM，按内容识别格式）。`, `The HTTP API follows the same rules as the website: no account needed, up to ${maxMb} MB per file, images and short videos only (PNG, JPEG, WebP, GIF, AVIF, MP4, WebM, detected from the content).`)}</p>
${ctx.gated ? `<p class="lead">${t('这个网站的上传接口需要请求头 <code class="chip">Authorization: Bearer &lt;token&gt;</code>，匿名请求会得到 401。', 'Uploads on this site need <code class="chip">Authorization: Bearer &lt;token&gt;</code>; anonymous requests get 401.')}</p>` : ""}
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
    `限流：每个 IP 每 ${RATE_LIMIT_PERIOD_SECONDS} 秒最多 ${RATE_LIMIT} 次上传（一次上传、一次链接搬运、一次分片上传的开始各算一次），打包链接另算，也是 ${RATE_LIMIT_PERIOD_SECONDS} 秒 ${RATE_LIMIT} 次${wafRule ? `；另外防火墙对 /upload、/api/upload 和 /api/uploads 每个 IP 每 ${WAF_PERIOD_SECONDS} 秒最多 ${WAF_LIMIT} 次请求，超过会被拦 ${WAF_PERIOD_SECONDS} 秒` : ""}。超过限制会返回 429，歇一下再来就好。`,
    `Rate limits: each IP may start ${RATE_LIMIT} uploads per ${RATE_LIMIT_PERIOD_SECONDS} seconds (an upload, a link import and the start of a chunked upload each count once), and separately create ${RATE_LIMIT} albums per ${RATE_LIMIT_PERIOD_SECONDS} seconds.${wafRule ? ` On top of that the firewall allows ${WAF_LIMIT} requests per ${WAF_PERIOD_SECONDS} seconds per IP to /upload, /api/upload and /api/uploads, and blocks for ${WAF_PERIOD_SECONDS} seconds beyond that.` : ""} Over a limit you get 429; wait a moment and try again.`,
  )}</p>
${quotaLine(ctx)}
<p class="small">${t(
    `旧接口 <code class="chip">POST /upload</code> 继续可用：只收 PNG、JPEG、WebP、GIF，最大 20 MB，链接是 ${main}/&lt;内容哈希&gt;.png 这种形式，相同内容得到同一个链接，没有删除凭证。`,
    `The original <code class="chip">POST /upload</code> keeps working: PNG, JPEG, WebP and GIF only, up to 20 MB, links look like ${main}/&lt;content hash&gt;.png, the same content always gets the same link, and there is no delete token.`,
  )}</p>
</section>
${ctx.flags.cli ? cliPanel(ctx) + mcpPanel(ctx) : ""}`;
  return {
    id: "dev",
    title: pageTitle(ctx, "开发者", "Developers"),
    main: html,
    description: t(
      `${brand(ctx.env).siteName} 的 HTTP API：curl 一行上传图片和视频，返回直链和删除凭证；支持临时文件、链接搬运、打包链接和分片上传。`,
      `The ${brand(ctx.env).siteName} HTTP API: upload images and videos with one curl command and get a direct link and a delete token; temporary files, link import, albums and chunked uploads.`,
    ),
  };
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
  ...(ctx.flags.account.includes("tokens")
    ? [
        {
          kind: "comment" as const,
          text: t(
            "# 在账号页创建 API 令牌，之后传的都进你的账号（可选）",
            "# create an API token on your account page so uploads go to your account (optional)",
          ),
          gap: true,
        },
        { kind: "cmd" as const, text: "sugi login sugi_…" },
      ]
    : []),
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
    ...(ctx.gated
      ? [
          { kind: "comment" as const, text: t("# 这个网站要求带上令牌", "# this site requires a token"), gap: true },
          { kind: "cmd" as const, text: `claude mcp add --transport http sugi ${mcp} --header "Authorization: Bearer <token>"` },
        ]
      : []),
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
