import { type Brand, brand } from "../../config";
import { esc } from "../i18n";
import { type Ctx, type Page, pageTitle, tr } from "../layout";

// Privacy policy. Every paragraph carries the text in both languages. `review` notes are never rendered: they record why a legally sensitive sentence is worded the way it is (decided for sugi.moe; other operators should review those paragraphs for their own service). Operator-specific sentences (who runs the site, contacts, storage region, CSAM scanning, mail providers) come from the deployment's configuration, and the account section describes only the live ACCOUNT_FEATURES.
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

// R2 location hints and jurisdictions.
const STORAGE_REGIONS: Record<string, [string, string]> = {
  apac: ["亚太", "the Asia-Pacific region"],
  wnam: ["北美西部", "western North America"],
  enam: ["北美东部", "eastern North America"],
  weur: ["西欧", "western Europe"],
  eeur: ["东欧", "eastern Europe"],
  oc: ["大洋洲", "Oceania"],
  eu: ["欧盟", "the European Union"],
  fedramp: ["美国（FedRAMP）", "the United States (FedRAMP)"],
};

// Resend sending regions: [region name zh, en, country zh, en].
const RESEND_REGIONS: Record<string, [string, string, string, string]> = {
  "us-east-1": ["美国东部", "US East", "美国", "the United States"],
  "eu-west-1": ["爱尔兰", "Ireland", "爱尔兰", "Ireland"],
  "sa-east-1": ["圣保罗", "São Paulo", "巴西", "Brazil"],
  "ap-northeast-1": ["东京", "Tokyo", "日本", "Japan"],
};

const when = <T>(cond: unknown, ...items: T[]): T[] => (cond ? items : []);

/** `features` are the live account features (ACCOUNT_FEATURES); the account section only describes those. */
export function privacySections(b: Brand, features: string[] = ["email", "github", "google", "passkey", "sync", "tokens"]): Section[] {
  const has = (f: string) => features.includes(f);
  const providers = ["github", "google"].filter(has).map((p) => (p === "github" ? "GitHub" : "Google"));
  const via = [...(has("email") ? ["邮箱"] : []), ...providers];
  const viaEn = [...(has("email") ? ["email"] : []), ...providers];
  const orJoin = (xs: string[], word: string) => (xs.length > 1 ? `${xs.slice(0, -1).join("、")}${word}${xs[xs.length - 1]}` : xs.join(""));
  const orJoinEn = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}` : xs.join(""));
  const storedZh = [
    ...(via.length ? [`你的邮箱（用${orJoin(via, "或")}登录时）`] : []),
    ...(providers.length ? [`${orJoin(providers, " 或 ")} 的用户 id 和它们提供的邮箱`] : []),
    ...(has("passkey") ? ["通行密钥的公钥（不包含指纹、面容等生物特征，它们从不离开你的设备）"] : []),
    "哪些文件和打包链接属于你的账号",
    has("tokens") ? "以及登录会话和 API 令牌的哈希（令牌本身只在生成时显示给你一次）" : "以及登录会话的哈希",
  ];
  const storedEn = [
    ...(viaEn.length ? [`your email (when you log in with ${orJoinEn(viaEn)})`] : []),
    ...(providers.length ? [`your ${orJoinEn(providers)} user id and the email they provide`] : []),
    ...(has("passkey") ? ["the public keys of your passkeys (no fingerprints or face data; those never leave your device)"] : []),
    "which files and albums belong to your account",
    has("tokens")
      ? "and hashes of your login sessions and API tokens (a token itself is shown to you once, when it is created)"
      : "and hashes of your login sessions",
  ];
  const site = esc(b.siteName);
  const contact = b.contactEmail ? esc(b.contactEmail) : null;
  const abuse = b.abuseEmail ? esc(b.abuseEmail) : null;
  const storage = b.storageLocation ? (STORAGE_REGIONS[b.storageLocation.toLowerCase()] ?? [esc(b.storageLocation), esc(b.storageLocation)]) : null;
  const resend = b.resendRegion ? (RESEND_REGIONS[b.resendRegion] ?? [esc(b.resendRegion), esc(b.resendRegion), "", ""]) : null;
  const region = b.resendRegion ? esc(b.resendRegion) : "";
  const countries: [string, string] =
    resend?.[2] && resend[2] !== "美国" ? [`美国和${resend[2]}`, `the United States and ${resend[3]}`] : ["美国", "the United States"];
  const services: [string, string][] = [
    ["托管和 CDN", "hosting and CDN"],
    [storage ? `文件存储（R2，存储区域为${storage[0]}）` : "文件存储（R2）", storage ? `file storage (R2, stored in ${storage[1]})` : "file storage (R2)"],
    ["数据库（D1）", "database (D1)"],
    ...when<[string, string]>(b.emailRouting, ["邮件转发", "email forwarding"]),
    ...when<[string, string]>(b.csamScanning, ["CSAM 扫描工具", "its CSAM Scanning Tool"]),
  ];
  const list = (items: string[], sep: string, last: string) =>
    items.length > 1 ? `${items.slice(0, -1).join(sep)}${last}${items[items.length - 1]}` : items.join("");
  const operatorZh = b.operator ? `${site} 由 ${esc(b.operator)} 运营，它负责处理本政策所说的个人信息。` : `${site} 的运营者负责处理本政策所说的个人信息。`;
  const operatorEn = b.operator
    ? `${site} is operated by ${esc(b.operator)}, which is responsible for the personal information described in this policy.`
    : `The operator of ${site} is responsible for the personal information described in this policy.`;
  const contactZh = `${contact ? `关于本政策和个人信息的问题，请写信到 ${contact}` : ""}${abuse && abuse !== contact ? `${contact ? "；" : ""}举报违规内容请写信到 ${abuse}` : ""}`;
  const contactEn = `${contact ? `Questions about this policy and your personal information go to ${contact}` : ""}${abuse && abuse !== contact ? `${contact ? "; r" : "R"}eport abuse to ${abuse}` : ""}`;
  return [
    {
      zh: "一句话",
      en: "In short",
      paras: [
        {
          zh: "你上传的图片和视频是公开的，任何拿到链接的人都能看到。我们不保存你的 IP 地址，不记录访问日志，网站上没有统计、广告或追踪。",
          en: "The images and videos you upload are public: anyone with the link can see them. We do not keep your IP address, we keep no access logs, and the site has no analytics, ads or trackers.",
        },
        {
          zh: `${operatorZh}${contactZh ? `${contactZh}。` : ""}`,
          en: `${operatorEn}${contactEn ? ` ${contactEn}.` : ""}`,
          review: "Decided: operator is YLDM Co., Ltd.; general and privacy contact hi@sugi.moe, abuse reports abuse@sugi.moe.",
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
          zh: "这个指纹只用于防止和处理滥用：找出并删除同一来源上传的违规内容，以及在法律要求时配合执法机关。我们这样做的依据是防止和处理滥用这一正当利益（GDPR 第 6 条第 1 款 f 项）。指纹和对应的文件保存同样长的时间，文件删除时一起删除；因为违反使用条款被删除的文件例外，见「保存多久」。",
          en: "The fingerprint is used only to prevent and handle abuse: to find and remove violating content uploaded from the same source, and to cooperate with law enforcement when the law requires it. Our legal basis is our legitimate interest in preventing and handling abuse (GDPR Art. 6(1)(f)). The fingerprint is kept exactly as long as the file it belongs to and is deleted with it, except for files removed for breaking the terms (see “How long we keep things”).",
          review: "Decided: legitimate interest (GDPR Art. 6(1)(f)); retention = lifetime of the file.",
        },
        {
          zh: "为了限流，Cloudflare 会按 IP 短时间计数上传请求（几秒到一分钟）。",
          en: "To enforce rate limits, Cloudflare briefly counts upload requests per IP (for seconds up to a minute).",
        },
        {
          zh: "你举报内容时，我们保存被举报的链接、你选的原因、你写的补充说明和你留下的邮箱（如果填了），以及你 IP 的 HMAC 指纹。指纹只用来限制举报频率，7 天后抹掉。举报会发到运营者的举报邮箱，由人工处理；处理完一年后整条举报删除。被举报的人看不到是谁举报的。",
          en: "When you report something we store the reported link, the reason you picked, the details you wrote, the email you left (if any) and an HMAC fingerprint of your IP. The fingerprint is used only to limit how often reports can be sent and is erased after 7 days. Reports are sent to the operator's abuse address and handled by a person; a report is deleted a year after it was dealt with. The person reported never sees who reported them.",
          review:
            "Decided (2026-11-02): reporter source HMAC erased after 7 days; resolved reports, including the optional contact email, deleted 1 year after resolution; open reports kept until handled.",
        },
      ],
    },
    {
      zh: "我们不记录的东西",
      en: "What we do not record",
      paras: [
        {
          zh: `${site} 自己不保存访问日志，Worker 的请求日志是关闭的。${site} 运行在 Cloudflare 上，请求会经过 Cloudflare 的网络；Cloudflare 作为我们的数据处理方，按照它的标准数据处理附录（Data Processing Addendum）处理连接数据（包括 IP 地址），详见 Cloudflare 的隐私政策：https://www.cloudflare.com/privacypolicy/。`,
          en: `${site} itself keeps no access logs; request logging for the Worker is turned off. ${site} runs on Cloudflare, so requests pass through Cloudflare's network; Cloudflare processes connection data, including IP addresses, as our processor under its standard Data Processing Addendum. See Cloudflare's privacy policy: https://www.cloudflare.com/privacypolicy/.`,
          review: "Decided: Cloudflare is our processor under its standard DPA; link its privacy policy, no further DPA text.",
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
          zh: `账号是可选的。登录后我们会保存：${storedZh.slice(0, -1).join("、")}，${storedZh[storedZh.length - 1]}。`,
          en: `Accounts are optional. If you log in we store: ${storedEn.join(", ")}.`,
        },
        {
          zh: `登录后浏览器里会有一个名为 sugi_session 的 cookie（HttpOnly，30 天有效），只用来让你保持登录。${has("email") ? "邮件里的登录链接 15 分钟内有效，只能用一次。" : ""}`,
          en: `While you are logged in your browser holds a cookie named sugi_session (HttpOnly, valid for 30 days) that only keeps you logged in.${has("email") ? " Login links sent by email are valid for 15 minutes and work once." : ""}`,
        },
        ...when<Para>(
          has("email"),
          resend
            ? {
                zh: `登录邮件通过 Resend（Resend, Inc.）发送，使用它的${resend[0]}区域（${region}）。Resend 作为我们的数据处理方，会处理收件邮箱地址和邮件内容（其中包含一次性登录链接）。`,
                en: `Login emails are sent through Resend (Resend, Inc.), using its ${resend[1]} region (${region}). As our processor, Resend handles the recipient address and the message content, which includes the one-time login link.`,
                review: "Decided: Resend, region ap-northeast-1; processes the login email address and message content.",
              }
            : {
                zh: "登录邮件由我们使用的邮件服务商发送，它作为我们的数据处理方，会处理收件邮箱地址和邮件内容（其中包含一次性登录链接）。",
                en: "Login emails are sent through our email provider, which as our processor handles the recipient address and the message content, which includes the one-time login link.",
              },
        ),
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
        ...when<Para>(b.backup, {
          zh: "为了防止数据丢失，我们会把永久保存的文件复制一份到同一存储区域里的备份存储（临时文件不备份）。文件被删除后，它在备份里的副本最多再保留 7 天，然后删除；因为违反使用条款被删除的文件，备份副本立即删除。",
          en: "To guard against data loss we keep a copy of files kept “forever” in backup storage in the same storage region (temporary files are not backed up). When a file is deleted, its backup copy is kept for at most 7 more days and then deleted; the backup copy of a file removed for breaking the terms is deleted at once.",
          review:
            "Proposed 2026-11-02 (needs the operator's confirmation): R2 backup bucket in the same location (APAC); copies of deleted files kept 7 days; takedowns removed from the backup immediately.",
        }),
        {
          zh: "因为违反使用条款而被删除的文件，我们会保留一条删除记录：文件 id、删除的时间和原因，以及上传来源的 HMAC 指纹，用来处理同一来源后续的滥用。来源指纹最长保留 2 年，到期后从记录里抹掉，只留下文件 id、时间和原因。必要时我们还会把文件内容的 SHA-256 哈希放进屏蔽列表，阻止同样的文件再次上传：哈希是单向的指纹，不能从它还原出文件，它会保留到不再需要阻止重新上传为止，你也可以请求解除。被禁止上传的来源按各自设定的期限解除。被删除文件的链接会一直显示「已删除」。",
          en: "When a file is removed for breaking the terms, we keep a record of the removal: the file id, when and why it was removed, and the HMAC fingerprint of its source, to deal with further abuse from the same source. The source fingerprint is kept for at most 2 years; after that it is erased from the record, leaving only the file id, time and reason. Where needed we also put the SHA-256 hash of the content in a blocklist so the same file cannot be uploaded again: a hash is a one-way fingerprint that the file cannot be recovered from, it is kept as long as it is needed to stop re-uploads, and you can ask for it to be lifted. Sources barred from uploading are released when their own block expires. The removed file's link keeps saying that it was removed.",
          review:
            "Decided (2026-11-02): keep takedown records; the source HMAC is erased from them (and from the admin log) after at most 2 years by the cron, leaving file id, time and reason; content hashes stay in the blocklist as long as needed to stop re-uploads and can be lifted on request; source blocks keep their own expiry.",
        },
        {
          zh: "账号数据保存到你在账号页删除账号（或写信要求我们删除）为止；会话 30 天后过期，邮件登录链接 15 分钟后失效。",
          en: "Account data is kept until you delete the account on the account page (or ask us to); sessions expire after 30 days and email login links after 15 minutes.",
          accountsOnly: true,
        },
      ],
    },
    {
      zh: "谁会处理这些数据",
      en: "Who processes this data",
      paras: [
        {
          zh: `Cloudflare, Inc. 为 ${site} 提供${list(
            services.map((x) => x[0]),
            "、",
            "，以及 ",
          )}。`,
          en: `Cloudflare, Inc. provides ${site}'s ${list(
            services.map((x) => x[1]),
            ", ",
            " and ",
          )}.`,
          review: "Decided: name Cloudflare's services; R2 bucket location APAC.",
        },
        ...when<Para>(b.csamScanning, {
          zh: "CSAM 扫描工具会把通过 Cloudflare 缓存提供的内容，与儿童保护组织（例如美国国家失踪与受剥削儿童中心 NCMEC）提供给 Cloudflare 的已知儿童性剥削内容列表进行比对。按照 Cloudflare 的说明：命中时会尽可能阻止该内容继续被访问；我们会每天收到一封邮件，列出过去 24 小时内命中内容的文件路径。Cloudflare 的说明把向有关机构报告的义务放在网站运营者一方；我们收到命中通知后会删除该内容，并依法向有关机构（例如通过 NCMEC 的 CyberTipline）报告。",
          en: "The CSAM Scanning Tool compares content served through Cloudflare's cache against lists of known child sexual abuse material that child safety organisations such as the National Center for Missing & Exploited Children (NCMEC) provide to Cloudflare. According to Cloudflare's documentation, on a match a block is placed, where possible, to prevent further serving of the content, and we receive a daily email listing the file paths of content matched in the past 24 hours. Cloudflare's documentation places the obligation to report on the website operator; when we are notified of a match we remove the content and report it to the appropriate authorities as the law requires (for example through NCMEC's CyberTipline).",
          review:
            "Decided: describe the tool using Cloudflare's own wording (developers.cloudflare.com/cache/reference/csam-scanning/): lists provided by groups such as NCMEC; block placed where possible; daily email with file paths; the docs do not say Cloudflare reports to NCMEC and put the reporting obligation on the site owner.",
        }),
        {
          zh: `跨境传输：${resend ? "Cloudflare 和 Resend" : "Cloudflare"} 在多个国家和地区运营，你的数据可能会在你所在地以外的国家或地区（包括${countries[0]}）被处理。`,
          en: `International transfers: ${resend ? "Cloudflare and Resend operate" : "Cloudflare operates"} in many countries, so your data may be processed outside the country you live in, including in ${countries[1]}.`,
          review: "Decided: add a cross-border transfer notice.",
        },
      ],
    },
    {
      zh: "Cookie 和追踪",
      en: "Cookies and tracking",
      paras: [
        {
          zh: `${site} 只使用上面提到的语言 cookie（以及登录后的会话 cookie）。没有统计脚本、广告、第三方脚本、追踪像素或指纹识别，页面不会从别的网站加载任何东西。`,
          en: `${site} only uses the language cookie described above (and the session cookie once you log in). There are no analytics, ads, third-party scripts, tracking pixels or fingerprinting, and pages load nothing from other websites.`,
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
          zh: `你有权查阅、更正、删除我们持有的你的个人信息，有权以可携带的格式取得这些信息，也有权反对我们处理它们。行使这些权利，或提出其他请求（例如删除你没有删除凭证的文件、删除账号），${contact ? `请写信到 ${contact}` : "请联系这个网站的运营者"}，并附上相关链接。我们会在 30 天内答复。`,
          en: `You have the right to access, correct and delete the personal information we hold about you, to receive it in a portable format, and to object to our processing of it. To exercise these rights, or for anything else (such as removing a file you have no delete token for, or deleting your account), ${contact ? `write to ${contact}` : "contact the operator of this site"} with the relevant links. We answer within 30 days.`,
          review: "Decided: access, correction, deletion, portability, objection; answer within 30 days; request by email to hi@sugi.moe.",
        },
      ],
    },
    {
      zh: "儿童",
      en: "Children",
      paras: [
        {
          zh: `${site} 不面向儿童。未满 16 岁请不要注册账号。`,
          en: `${site} is not meant for children. If you are under 16, please do not create an account.`,
          review: "Decided: minimum age 16.",
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
}

function paragraphs(ctx: Ctx, s: Section): string {
  return s.paras
    .filter((p) => ctx.flags.accounts || !p.accountsOnly)
    .map((p) => `<p>${ctx.lang === "zh" ? p.zh : p.en}</p>`)
    .join("\n");
}

export function privacyPage(ctx: Ctx): Page {
  const t = tr(ctx);
  const sections = privacySections(brand(ctx.env), ctx.flags.account).filter((s) => ctx.flags.accounts || !s.accountsOnly);
  const html = `<section class="stack8">
<h1 class="h1">${t("隐私政策", "Privacy policy")}</h1>
<p class="lead">${t(`最后更新：${LAST_UPDATED}`, `Last updated: ${LAST_UPDATED}`)}</p>
</section>
<section class="faq privacy">
${sections.map((s) => `<div class="card policy"><h2 class="h2">${t(s.zh, s.en)}</h2>\n${paragraphs(ctx, s)}</div>`).join("\n")}
</section>`;
  const site = brand(ctx.env).siteName;
  return {
    id: "privacy",
    title: pageTitle(ctx, "隐私政策", "Privacy"),
    main: html,
    description: t(`${site} 收集什么信息、为什么、保存多久，以及你有哪些权利。`, `What ${site} collects, why, how long it is kept, and your rights.`),
  };
}
