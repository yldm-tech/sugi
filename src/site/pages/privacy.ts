import { Ctx, Page, tr } from "../layout";

// Privacy policy (draft for the maintainers' legal review). Every paragraph carries the text in both languages; `review` notes, never rendered, mark sentences whose legal footing the maintainers still need to confirm, and are listed in the pull request.
interface Para {
  zh: string;
  en: string;
  review?: string;
  accountsOnly?: boolean;
}

interface Section {
  zh: string;
  en: string;
  paras: Para[];
  accountsOnly?: boolean;
}

export const LAST_UPDATED = "2026-11-02";

export const PRIVACY: Section[] = [
  {
    zh: "一句话",
    en: "In short",
    paras: [
      {
        zh: "你上传的图片和视频是公开的，任何拿到链接的人都能看到。我们不保存你的 IP 地址，不记录访问日志，网站上没有统计、广告或追踪。",
        en: "The images and videos you upload are public: anyone with the link can see them. We do not keep your IP address, we keep no access logs, and the site has no analytics, ads or trackers.",
      },
      {
        zh: "sugi.moe 由个人维护者运营，不是公司。关于本政策的任何问题，请写信到 abuse@sugi.moe。",
        en: "sugi.moe is run by individual maintainers, not a company. Questions about this policy go to abuse@sugi.moe.",
        review: "Operator identity: privacy laws (e.g. GDPR art. 13, China's PIPL art. 17) expect the controller's name and contact details; confirm what name to publish.",
      },
    ],
  },
  {
    zh: "你上传的内容",
    en: "What you upload",
    paras: [
      {
        zh: "我们保存文件本身，以及它的文件名（如果你的浏览器或命令提供了）、类型、大小、上传时间和到期时间。文件和文件名会出现在公开的链接和分享页上。",
        en: "We store the file itself and its name (if your browser or command supplied one), type, size, upload time and expiry. The file and its name appear on its public link and share page.",
      },
      {
        zh: "在网页上传时，「抹掉照片位置信息」默认开启：JPEG、PNG、WebP 里的 EXIF 和 XMP 元数据（包括 GPS 位置、相机型号和拍摄时间）会在你的浏览器里、上传之前删掉，不会发送给我们。AVIF、视频以及通过 API、命令行、MCP 上传的文件不会被处理，请自己先检查。",
        en: "When you upload on the website, “Strip photo location” is on by default: EXIF and XMP metadata in JPEG, PNG and WebP files (including GPS position, camera model and capture time) is removed in your browser before upload and never reaches us. AVIF files, videos, and anything uploaded through the API, the CLI or MCP are not processed, so check them yourself.",
      },
      {
        zh: "不要上传含有个人信息、证件、密码或密钥的图片。上传即表示你有权公开这些内容。",
        en: "Do not upload pictures that show personal details, IDs, passwords or keys. By uploading you confirm you have the right to make the content public.",
      },
    ],
  },
  {
    zh: "为了防止滥用而记录的信息",
    en: "What we record to fight abuse",
    paras: [
      {
        zh: "每个文件和每个打包链接会记下上传时间，以及上传者 IP 地址的 HMAC 指纹：用只有服务器知道的密钥对 IP 做的单向运算。我们不保存 IP 本身。没有密钥的人无法从指纹还原 IP；持有密钥的维护者可以拿一个已知的 IP 去比对它是否和某个指纹一致。",
        en: "For every file and album we record its upload time and an HMAC fingerprint of the uploader's IP address: a one-way function of the IP keyed with a secret only the server holds. We never store the IP itself. Without the key the fingerprint cannot be turned back into an IP; the maintainers, who hold the key, can check whether a known IP matches a fingerprint.",
      },
      {
        zh: "这个指纹只用于处理滥用：找出并删除同一来源上传的违规内容，以及在法律要求时配合执法机关。它和对应的文件保存同样长的时间。",
        en: "The fingerprint is used only to handle abuse: to find and remove violating content uploaded from the same source, and to cooperate with law enforcement when the law requires it. It is kept as long as the file it belongs to.",
        review: "Legal basis for processing the IP-derived fingerprint (e.g. GDPR art. 6(1)(f) legitimate interest) and whether an HMAC of an IP counts as personal data in each jurisdiction.",
      },
      {
        zh: "为了限流，Cloudflare 会按 IP 短时间计数上传请求（几秒到一分钟）。",
        en: "To enforce rate limits, Cloudflare briefly counts upload requests per IP (for seconds up to a minute).",
      },
    ],
  },
  {
    zh: "我们不记录的东西",
    en: "What we do not record",
    paras: [
      {
        zh: "sugi 自己不保存访问日志，Worker 的请求日志是关闭的。sugi 运行在 Cloudflare 上，请求会经过 Cloudflare 的网络，Cloudflare 会按它自己的隐私政策（https://www.cloudflare.com/privacypolicy/）处理连接数据，包括 IP 地址。",
        en: "sugi itself keeps no access logs; request logging for the Worker is turned off. sugi runs on Cloudflare, so requests pass through Cloudflare's network, and Cloudflare processes connection data, including IP addresses, under its own privacy policy (https://www.cloudflare.com/privacypolicy/).",
        review: "Whether a reference to Cloudflare's policy is enough, or a data processing agreement / transfer notice must be described.",
      },
    ],
  },
  {
    zh: "保存在你浏览器里的东西",
    en: "What stays in your browser",
    paras: [
      {
        zh: "「我的文件」的记录（链接、文件名、删除凭证和小缩略图）和你的偏好（白天或夜间、上传选项）保存在浏览器的 localStorage 里，只在你这台设备上，不会发送给我们。清理浏览器数据就会删掉它们，所以请先导出。",
        en: "Your “My files” history (links, file names, delete tokens and small thumbnails) and your preferences (day or night, upload options) are kept in your browser's localStorage, on this device only, and are never sent to us. Clearing the browser's data deletes them, so export them first.",
      },
      {
        zh: "你切换语言时，我们会设置一个名为 sugi_lang 的 cookie 记住你的选择，有效期一年。",
        en: "When you switch the language we set a cookie named sugi_lang to remember the choice, for one year.",
      },
    ],
  },
  {
    zh: "账号",
    en: "Accounts",
    accountsOnly: true,
    paras: [
      {
        zh: "账号是可选的。登录后我们会保存：你的邮箱（用邮箱、GitHub 或 Google 登录时）、GitHub 或 Google 的用户 id 和它们提供的邮箱、通行密钥的公钥（不包含指纹、面容等生物特征，它们从不离开你的设备）、哪些文件和打包链接属于你的账号，以及登录会话和 API 令牌的哈希（令牌本身只在生成时显示给你一次）。",
        en: "Accounts are optional. If you log in we store: your email (when you log in with email, GitHub or Google), your GitHub or Google user id and the email they provide, the public keys of your passkeys (no fingerprints or face data; those never leave your device), which files and albums belong to your account, and hashes of your login sessions and API tokens (a token itself is shown to you once, when it is created).",
      },
      {
        zh: "登录后浏览器里会有一个名为 sugi_session 的 cookie（HttpOnly，30 天有效），只用来让你保持登录。邮件里的登录链接 15 分钟内有效，只能用一次。",
        en: "While you are logged in your browser holds a cookie named sugi_session (HttpOnly, valid for 30 days) that only keeps you logged in. Login links sent by email are valid for 15 minutes and work once.",
      },
      {
        zh: "登录邮件通过我们选定的邮件发送服务商发出；确定服务商之后会写在这里。",
        en: "Login emails are sent through an email delivery provider; we will name it here once it is chosen.",
        review: "Fill in the email provider (Cloudflare Email Service or Resend) once decided.",
      },
    ],
  },
  {
    zh: "保存多久",
    en: "How long we keep things",
    paras: [
      {
        zh: "选「永久」的文件会一直保存，直到你用删除凭证删掉，或者因为违反使用条款被删除。选 1 小时、12 小时或 3 天的文件，到期后链接立即失效，文件会在大约十分钟内被删除，最晚不超过到期后 4 天。文件删除时，我们会同时清除 Cloudflare 缓存里的副本；别处（例如其他网站、浏览器）已经缓存的副本不受我们控制。",
        en: "Files kept “forever” stay until you delete them with their delete token or they are removed for breaking the terms. Files kept for 1 hour, 12 hours or 3 days stop working the moment they expire and are deleted within about ten minutes, and in any case within 4 days. When a file is deleted we also purge its copies from Cloudflare's cache; copies cached elsewhere (other websites, browsers) are out of our control.",
      },
      {
        zh: "打包链接保存到你删除它为止；里面的文件被删除后，打包链接里就不再显示它们。",
        en: "Albums stay until you delete them; files deleted from an album's set simply stop appearing in it.",
      },
      {
        zh: "账号数据保存到你要求删除账号为止；会话 30 天后过期，邮件登录链接 15 分钟后失效。",
        en: "Account data is kept until you ask us to delete the account; sessions expire after 30 days and email login links after 15 minutes.",
        accountsOnly: true,
      },
    ],
  },
  {
    zh: "谁会处理这些数据",
    en: "Who processes this data",
    paras: [
      {
        zh: "Cloudflare, Inc. 为 sugi 提供托管和 CDN、文件存储（R2）、数据库（D1）、邮件转发，以及 CSAM 扫描：经过 Cloudflare 缓存的图片会与已知儿童性剥削内容的哈希列表比对，命中时 Cloudflare 会通知我们并阻止该内容继续被访问。",
        en: "Cloudflare, Inc. provides sugi's hosting and CDN, file storage (R2), database (D1), email forwarding and CSAM scanning: images served through Cloudflare's cache are compared against hash lists of known child sexual abuse material, and on a match Cloudflare notifies us and blocks the content.",
        review: "Whether matches are reported to NCMEC or authorities (and by whom) must be stated accurately; also where the data is stored (the R2 bucket is in the APAC region) and any cross-border transfer notice.",
      },
    ],
  },
  {
    zh: "Cookie 和追踪",
    en: "Cookies and tracking",
    paras: [
      {
        zh: "sugi 只使用上面提到的语言 cookie（以及登录后的会话 cookie）。没有统计脚本、广告、第三方脚本、追踪像素或指纹识别，页面不会从别的网站加载任何东西。",
        en: "sugi only uses the language cookie described above (and the session cookie once you log in). There are no analytics, ads, third-party scripts, tracking pixels or fingerprinting, and pages load nothing from other websites.",
      },
    ],
  },
  {
    zh: "删除和其他请求",
    en: "Deletion and other requests",
    paras: [
      {
        zh: "你可以随时删除自己上传的文件：在「我的文件」里点 ×，或用上传时返回的删除凭证调用 DELETE /api/files/:id。",
        en: "You can delete your own uploads at any time: press × under “My files”, or call DELETE /api/files/:id with the delete token returned by the upload.",
      },
      {
        zh: "其他请求，例如删除你没有删除凭证的文件、查询或删除与你相关的记录、删除账号，请写信到 abuse@sugi.moe（等专门的隐私邮箱设立后会更新这里），并附上相关链接。我们会在合理的时间内答复。",
        en: "For anything else, such as removing a file you have no delete token for, asking what we hold about you or deleting your account, write to abuse@sugi.moe (this will change once a dedicated privacy address exists) with the relevant links. We answer within a reasonable time.",
        review: "Response deadlines and the list of data-subject rights (access, correction, deletion, portability, objection) required by the laws that apply.",
      },
    ],
  },
  {
    zh: "儿童",
    en: "Children",
    paras: [
      {
        zh: "sugi 不面向儿童。如果你未满所在地区可以自行同意处理个人信息的年龄，请不要注册账号。",
        en: "sugi is not meant for children. If you are under the age at which you can consent to the processing of your personal information where you live, please do not create an account.",
        review: "Pick a concrete minimum age (13 / 14 under PIPL / 16 under GDPR by default).",
      },
    ],
  },
  {
    zh: "变更",
    en: "Changes",
    paras: [
      {
        zh: "这份政策更新时，页面上的日期会随之更新；重要的变化会在首页提示。",
        en: "When this policy changes, the date on this page changes with it; significant changes are announced on the home page.",
      },
    ],
  },
];

function paragraphs(ctx: Ctx, s: Section): string {
  return s.paras
    .filter((p) => ctx.flags.accounts || !p.accountsOnly)
    .map((p) => `<p>${ctx.lang === "zh" ? p.zh : p.en}</p>`)
    .join("\n");
}

export function privacyPage(ctx: Ctx): Page {
  const t = tr(ctx);
  const sections = PRIVACY.filter((s) => ctx.flags.accounts || !s.accountsOnly);
  const html = `<section class="stack8">
<h1 class="h1">${t("隐私政策", "Privacy policy")}</h1>
<p class="lead">${t(`最后更新：${LAST_UPDATED}`, `Last updated: ${LAST_UPDATED}`)}</p>
</section>
<section class="faq privacy">
${sections.map((s) => `<div class="card policy"><h2 class="h2">${t(s.zh, s.en)}</h2>\n${paragraphs(ctx, s)}</div>`).join("\n")}
</section>`;
  return { id: "privacy", title: t("隐私政策 · sugi.moe", "Privacy · sugi.moe"), main: html };
}
