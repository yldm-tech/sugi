import { MAX_FILE_BYTES, SINGLE_REQUEST_MAX_BYTES } from "../../limits";
import { esc } from "../i18n";
import { brand } from "../../config";
import { type Ctx, mailLink, type Page, pageTitle, tr } from "../layout";
import { LOST_HAMSTER } from "../svg";

const MiB = 1024 * 1024;

function faqItem(q: string, a: string): { q: string; a: string } {
  return { q, a };
}

/** One sentence on who may upload videos (VIDEO_UPLOADS), or "" when anyone may. */
export function videoRule(ctx: Ctx): string {
  const t = tr(ctx);
  const scan = brand(ctx.env).csamScanning;
  if (ctx.flags.video === "account")
    return t(
      `${scan ? "Cloudflare 的 CSAM 扫描工具只检测图片、不检测视频，所以" : ""}视频要先登录（或者用 API 令牌）才能上传，图片不用。`,
      `${scan ? "Cloudflare's CSAM Scanning Tool checks images but not videos, so v" : "V"}ideos need an account (a login or an API token); images do not.`,
    );
  if (ctx.flags.video === "trusted")
    return t("这个网站只有维护者能上传视频，匿名只能传图片。", "On this site only the maintainers can upload videos; anonymous uploads are images only.");
  return "";
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
    ...(b.sourceUrl
      ? [
          faqItem(
            t("sugi 是开源的吗？", "Is sugi open source?"),
            t(
              `是的，sugi 以 MIT 许可开源，代码在 <a href="${esc(b.sourceUrl)}" rel="noopener">这里</a>。你也可以把它部署到自己的 Cloudflare 账号，做一个自己的图床。`,
              `Yes. sugi is open source under the MIT license; the code is <a href="${esc(b.sourceUrl)}" rel="noopener">here</a>. You can also deploy it to your own Cloudflare account and run an image host of your own.`,
            ),
          ),
        ]
      : []),
    faqItem(
      t("sugi 是什么意思？", "What does “sugi” mean?"),
      t(
        "日语里有两个意思：「杉」是柳杉，所以仓仓头上顶着一棵杉树苗；「〜すぎ」是“太……了”，かわいすぎ 就是太可爱了。仓仓是一只什么都往腮帮子里屯的仓鼠，屯太多的时候会说「屯すぎ！」。",
        "Two things in Japanese: 杉 (sugi) is the Japanese cedar, which is why the hamster has a cedar sprout on its head, and 〜すぎ (-sugi) means “too much”, as in かわいすぎ, “way too cute”. The hamster stuffs everything into its cheeks, and when it has stuffed too much it says “too much!”.",
      ),
    ),
    faqItem(
      t("一定要注册吗？", "Do I need an account?"),
      `${
        ctx.flags.account.includes("sync")
          ? t(
              "不用。不登录也能传，记录只保存在当前浏览器里。想换设备也不丢，可以登录，之前传的文件能一键认领。",
              "No. You can upload without logging in; your history stays in this browser. Log in if you want it on every device, and claim your earlier uploads in one click.",
            )
          : ctx.flags.accounts
            ? t(
                "不用。不登录也能传，记录只保存在当前浏览器里（「我的文件」）。登录后，新上传的文件会记在你的账号下。",
                "No. You can upload without logging in; your history stays in this browser (“My files”). Once you log in, new uploads are recorded under your account.",
              )
            : t(
                "不用，sugi 现在没有账号，打开就能传。上传记录和删除凭证保存在你当前用的浏览器里（「我的文件」），可以随时导出一份备份。",
                "No. sugi has no accounts right now; just open it and upload. Your history and delete tokens are kept in this browser (“My files”), and you can export them at any time.",
              )
      }${ctx.flags.video === "anyone" ? "" : ctx.lang === "zh" ? `传图片是这样；${videoRule(ctx)}` : ` That is for pictures: ${videoRule(ctx)}`}`,
    ),
    faqItem(
      t("文件会保存多久？", "How long are files kept?"),
      t(
        `选「永久」的文件会一直保存，除非违反使用条款被删除，或者你用删除凭证自己删掉。选 1 小时、12 小时或 3 天的，链接放在 ${host(ctx.env.TMP_ORIGIN)} 下，到期后链接立刻失效，文件会在之后十分钟左右内被清理。`,
        `Files kept “forever” stay until they break the terms or you delete them with their delete token. Files kept for 1 hour, 12 hours or 3 days get a ${host(ctx.env.TMP_ORIGIN)} link that stops working the moment it expires; the file itself is cleaned up within about ten minutes after that.`,
      ),
    ),
    faqItem(
      t("能传什么格式？", "What can I upload?"),
      t(
        `图片和短视频：PNG、JPEG、WebP、GIF、AVIF、MP4、WebM。格式按文件内容判断，不看扩展名。单个文件最大 ${maxMb} MB，超过 ${singleMb} MB 的网页会自动分片上传。其他格式（SVG、HTML、PDF、压缩包、可执行文件等）一律不收。${videoRule(ctx)}`,
        `Images and short videos: PNG, JPEG, WebP, GIF, AVIF, MP4 and WebM, recognised by their content rather than the file name. Up to ${maxMb} MB per file; the website splits anything over ${singleMb} MB into chunks for you. Everything else (SVG, HTML, PDF, archives, executables…) is refused.${videoRule(ctx) ? ` ${videoRule(ctx)}` : ""}`,
      ),
    ),
    faqItem(
      t("上传的文件谁能看到？", "Who can see my uploads?"),
      t(
        "所有上传都是公开的，任何拿到链接的人都能打开。链接是随机生成的，不会被列出来，但「可爱链接名」组合少，更容易被猜到。不要上传含个人信息、证件、密码或密钥的图片。",
        "Every upload is public: anyone with the link can open it. Links are random and never listed anywhere, but cute link names come from a much smaller pool and are easier to guess. Do not upload pictures that show personal details, IDs, passwords or keys.",
      ),
    ),
    faqItem(
      t("怎么删除自己传的文件？", "How do I delete something I uploaded?"),
      t(
        `在「我的文件」页找到文件点 ×。删除凭证只存在上传时用的那个浏览器里，换了浏览器或清理了浏览器数据就删不了，记得先导出记录。用 API 上传的，用返回的 delete_token 调 DELETE /api/files/:id。旧版链接（${host(ctx.env.MAIN_ORIGIN)}/一串十六进制.png）没有删除凭证，要删的话${contact ? `写信到 ${contact}` : "请联系这个网站的运营者"}。`,
        `Find it under “My files” and press ×. The delete token lives only in the browser you uploaded from, so if you switch browsers or clear its data you can no longer delete it; export your history first. For API uploads, call DELETE /api/files/:id with the delete_token you got back. Links in the old format (${host(ctx.env.MAIN_ORIGIN)}/<hex>.png) have no delete token; ${contact ? `write to ${contact}` : "contact the operator of this site"} to have one removed.`,
      ),
    ),
    faqItem(
      t("换设备还能看到记录吗？", "Can I see my history on another device?"),
      t(
        "看不到，记录只在当前浏览器里。可以在「我的文件」页点「导出记录」存一份。",
        "No, the history lives in this browser only. Use “Export” on the “My files” page to save a copy.",
      ),
    ),
    faqItem(
      t("照片里的位置信息会被抹掉吗？", "Is the location in my photos removed?"),
      t(
        "在网页上传时，默认勾选的「抹掉照片位置信息」会在你的浏览器里、上传之前删掉 JPEG、PNG、WebP 里的 EXIF 和 XMP 元数据（GPS、相机型号、拍摄时间都在里面），JPEG 只保留照片方向。AVIF 和视频不处理，用 API 上传的文件也不会被改动。",
        "When you upload on the website, the “Strip photo location” option (on by default) removes the EXIF and XMP metadata from JPEG, PNG and WebP files in your browser before upload; that is where GPS position, camera model and capture time live. For JPEG only the orientation is kept. AVIF files, videos and anything uploaded through the API are left untouched.",
      ),
    ),
    faqItem(
      t("sugi 会记录我的什么？", "What does sugi record about me?"),
      t(
        '不保存你的 IP 地址。每个文件会记下上传时间、文件名（如果有）和上传者 IP 的 HMAC 指纹（用服务器密钥算出来，不能反推出 IP），只用来在出现滥用时找出并清除同一来源的上传。网站没有统计脚本，也没有广告。sugi 运行在 Cloudflare 上，请求会经过 Cloudflare 的网络。详见 <a href="/privacy" data-nav>隐私政策</a>。',
        "Not your IP address. With each file we keep its upload time, its file name if it had one, and an HMAC fingerprint of the uploader's IP made with a server-side key, which cannot be turned back into the IP. The fingerprint is only used to find and remove everything from the same source when there is abuse. The site has no analytics and no ads. sugi runs on Cloudflare, so requests pass through Cloudflare's network. See the <a href=\"/privacy\" data-nav>privacy policy</a>.",
      ),
    ),
    faqItem(
      t("链接能直接贴到论坛、博客里吗？", "Can I embed the links in forums and blogs?"),
      t(
        "可以，所有链接都是直链，支持外链和热链。上传完可以直接复制成 Markdown、HTML 或 BBCode。",
        "Yes. Every link is a direct link and hotlinking is allowed. You can copy them as Markdown, HTML or BBCode right after uploading.",
      ),
    ),
    // MAINLAND_CHINA_FAQ: the operator states that the site has no ICP filing in mainland China (true for sugi.moe), so it is off by default.
    ...(ctx.env.MAINLAND_CHINA_FAQ === "1"
      ? [
          faqItem(
            t("在中国大陆能用吗？", "Does it work in mainland China?"),
            t(
              `多数时候能用，但我们不能保证速度和稳定性。${esc(b.siteName)} 运行在 Cloudflare 的全球网络上，没有在中国大陆做 ICP 备案，也没有用 Cloudflare 的中国网络，所以从大陆访问时，请求会绕到境外的节点。速度取决于你的运营商、地区和时段，晚高峰可能明显变慢，个别网络下也可能完全打不开，网页、上传和图片链接都一样。如果图片主要给大陆读者看，或者内容很重要，请另外存一份。`,
              `Usually, but we cannot promise speed or reliability there. ${esc(b.siteName)} runs on Cloudflare's global network, has no ICP filing in mainland China and does not use Cloudflare's China Network, so requests from the mainland are served from data centres outside it. Speed depends on your carrier, region and the time of day; it can slow down a lot in the evening peak, and on some networks the site may not load at all. This applies to the website, uploads and image links alike. If your readers are mostly in mainland China, or the pictures matter, keep a copy elsewhere too.`,
            ),
          ),
        ]
      : []),
    faqItem(
      t("看到不好的内容怎么办？", "I found something bad. What do I do?"),
      t(
        `点文件页或打包链接页最下面的「举报」，选一个原因提交就行${abuse ? `，也可以把链接发到 ${abuse}` : ""}。运营者会人工查看，确认违规后删除。${b.csamScanning ? "通过 Cloudflare 缓存提供的图片还会由 Cloudflare 的 CSAM 扫描工具检测（它只检测图片，不检测视频）。" : ""}`,
        `Use “Report” at the bottom of the file or album page and pick a reason${abuse ? `, or send the link to ${abuse}` : ""}. A person at the operator reviews it and removes it once confirmed.${b.csamScanning ? " Images served through Cloudflare's cache are also checked by Cloudflare's CSAM Scanning Tool (it checks images only, not videos)." : ""}`,
      ),
    ),
    faqItem(
      t("仓仓靠什么活下去？", "Who pays for the hamster?"),
      `${t("没有广告，也不卖数据。", "There are no ads and no data is sold.")}${
        ctx.flags.donate
          ? t(
              '想帮仓仓付服务器和域名的话，可以 <a href="/donate" data-nav>投喂仓仓</a>。',
              ' If you would like to help pay for the servers and the domain: <a href="/donate" data-nav>Feed the hamster</a>.',
            )
          : ""
      }`,
    ),
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
  return {
    id: "faq",
    title: pageTitle(ctx, "问问题", "FAQ"),
    main: html,
    jsonLd,
    description: t(
      `关于 ${b.siteName} 的常见问题：文件保存多久、能传什么格式、怎么删除、我们记录什么。`,
      `Common questions about ${b.siteName}: how long files are kept, what you can upload, how to delete, and what we record.`,
    ),
  };
}

export function termsPage(ctx: Ctx): Page {
  const t = tr(ctx);
  const b = brand(ctx.env);
  const abuse = mailLink(b.abuseEmail);
  const maxMb = MAX_FILE_BYTES / MiB;
  const items = [
    t(
      "禁止上传违法内容，包括但不限于儿童性剥削内容、侵犯他人版权的内容、他人的隐私信息。",
      "Do not upload anything illegal, including but not limited to child sexual abuse material, content that infringes someone else's copyright, and other people's private information.",
    ),
    t("禁止用 sugi 分发恶意软件、钓鱼页面或做任何诈骗。", "Do not use sugi to spread malware or phishing, or for any kind of fraud."),
    t(
      `只接受图片和短视频（PNG、JPEG、WebP、GIF、AVIF、MP4、WebM），单个文件最大 ${maxMb} MB。${videoRule(ctx)}`,
      `Only images and short videos are accepted (PNG, JPEG, WebP, GIF, AVIF, MP4, WebM), up to ${maxMb} MB per file.${videoRule(ctx) ? ` ${videoRule(ctx)}` : ""}`,
    ),
    t(
      "所有上传都是公开的，任何拿到链接的人都能看到。只上传你有权公开的内容。",
      "Every upload is public and visible to anyone with the link. Only upload what you have the right to make public.",
    ),
    t(
      "违规内容会被直接删除，不另行通知；必要时会配合执法机关。",
      "Content that breaks these rules is removed without notice; we cooperate with law enforcement when required.",
    ),
    t(
      '为了处理滥用，每次上传会保存上传时间和上传者 IP 的 HMAC 指纹，不保存 IP 本身。详见 <a href="/privacy" data-nav>隐私政策</a>。',
      'To deal with abuse we keep, for every upload, its time and an HMAC fingerprint of the uploader\'s IP, never the IP itself. See the <a href="/privacy" data-nav>privacy policy</a>.',
    ),
    t(
      "仓仓会尽力保管好每个文件，但不保证永不丢失，也不保证服务一直可用，重要文件请自己留备份。临时文件到期后会被删除。",
      "The hamster takes good care of every file, but cannot promise that nothing is ever lost or that the service is always up. Keep your own copy of anything important. Temporary files are deleted when they expire.",
    ),
    ...(ctx.flags.accounts ? [t("未满 16 岁请不要注册账号。", "If you are under 16, please do not create an account.")] : []),
    abuse
      ? t(`举报违规内容请用文件页上的「举报」，或写信到 ${abuse}。`, `Report abuse with “Report” on the file's page, or write to ${abuse}.`)
      : t("举报违规内容请用文件页上的「举报」。", "Report abuse with “Report” on the file's page."),
  ];
  const html = `<section class="stack8">
<h1 class="h1">${t("使用条款", "Terms of use")}</h1>
<p class="lead">${b.operator ? t(`${esc(b.siteName)} 由 ${esc(b.operator)} 运营。用 ${esc(b.siteName)} 就代表你同意下面这些规则。`, `${esc(b.siteName)} is operated by ${esc(b.operator)}${b.operator.endsWith(".") ? "" : "."} By using ${esc(b.siteName)} you agree to the rules below.`) : t(`用 ${esc(b.siteName)} 就代表你同意下面这些规则。`, `By using ${esc(b.siteName)} you agree to the rules below.`)}</p>
</section>
<ol class="card terms">
${items.map((i) => `<li>${i}</li>`).join("\n")}
</ol>`;
  return {
    id: "terms",
    title: pageTitle(ctx, "使用条款", "Terms"),
    main: html,
    description: t(
      `使用 ${b.siteName} 的规则：能传什么、不能传什么、文件会保存多久。`,
      `The rules for using ${b.siteName}: what you may upload, what you may not, and how long files are kept.`,
    ),
  };
}

export function notFoundPage(ctx: Ctx): Page {
  const t = tr(ctx);
  const html = `<section class="nf">
<div class="art"><span class="q a" aria-hidden="true">?</span><span class="q b" aria-hidden="true">?</span>${LOST_HAMSTER}</div>
<div class="code404">404</div>
<h1>${t("仓仓翻遍了腮帮子也没找到", "Checked both cheeks, still can't find it")}</h1>
<p class="lead">${t("这个文件可能已经过期，被主人删掉了，或者链接抄错了一个字母。", "It may have expired, been deleted by its owner, or the link has a typo.")}</p>
<div class="acts"><a class="btn big" href="/" data-nav>${t("回首页", "Home")}</a><a class="btn big ghost" href="/mine" data-nav>${t("看看我的文件", "My files")}</a></div>
</section>`;
  return { id: "notfound", title: pageTitle(ctx, "找不到啦", "Not found"), main: html, status: 404, noindex: true };
}
