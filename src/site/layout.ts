import { ASSETS } from "../generated/assets";
import { MAX_FILE_BYTES, RATE_LIMIT, RATE_LIMIT_PERIOD_SECONDS, SINGLE_REQUEST_MAX_BYTES } from "../limits";
import { esc, jsonForScript, Lang } from "./i18n";
import { clientStrings } from "./strings";
import { HEART, LOGO, MOON, SUN } from "./svg";
import { ICONS, OG_IMAGES } from "./og-images";

export interface Flags {
  accounts: boolean;
  cli: boolean;
  donate: boolean;
}

export interface Ctx {
  env: Env;
  lang: Lang;
  nonce: string;
  gated: boolean;
  flags: Flags;
  path: string;
}

export type PageId = "home" | "mine" | "dev" | "faq" | "terms" | "privacy" | "file" | "album" | "login" | "donate" | "notfound";

export interface Page {
  id: PageId;
  title: string;
  main: string;
  status?: number;
  /** Meta description; falls back to the site description. */
  description?: string;
  /** Keep out of search engines (user content, personal pages, errors). */
  noindex?: boolean;
  /** og:image override (absolute URL); defaults to the page's rendered OG image. */
  ogImage?: string;
  /** og:title override; user content pages use the site title instead of the file name. */
  ogTitle?: string;
  /** schema.org objects emitted as JSON-LD. */
  jsonLd?: object[];
}

export function tr(ctx: Ctx): (zh: string, en: string) => string {
  return (zh, en) => (ctx.lang === "zh" ? zh : en);
}

export function flagsOf(env: Env): Flags {
  return { accounts: env.FEATURE_ACCOUNTS === "1", cli: env.FEATURE_CLI === "1", donate: env.FEATURE_DONATE === "1" };
}

export function pageCsp(env: Env, nonce: string): string {
  const files = [env.FILES_ORIGIN, env.TMP_ORIGIN].filter(Boolean).join(" ");
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'nonce-${nonce}'`,
    `img-src 'self' data: blob: ${files}`,
    `media-src 'self' blob: ${files}`,
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// Applied before first paint so the night theme never flashes: an explicit choice wins, otherwise night between 22:00 and 06:00 local time, as in the design.
const THEME_BOOT = `try{var p=JSON.parse(localStorage.getItem("sugi.prefs.v1")||"null"),h=new Date().getHours(),n=p&&typeof p.night==="boolean"?p.night:(h>=22||h<6);if(n)document.documentElement.classList.add("night")}catch(e){}`;

function navLink(ctx: Ctx, href: string, ids: PageId[], current: PageId, label: string, extraClass = ""): string {
  const on = ids.includes(current) ? " on" : "";
  return `<a class="pill${extraClass}${on}" href="${href}" data-nav data-for="${ids.join(" ")}">${label}</a>`;
}

export function header(ctx: Ctx, current: PageId): string {
  const t = tr(ctx);
  const other: Lang = ctx.lang === "zh" ? "en" : "zh";
  return `<header class="top">
<a class="brand" href="/" data-nav aria-label="sugi.moe">${LOGO}<span class="brand-word">sugi${HEART}moe</span></a>
<nav class="nav" id="nav">
${navLink(ctx, "/", ["home"], current, t("上传", "Upload"))}
${navLink(ctx, "/mine", ["mine", "album"], current, t("我的文件", "My files"))}
${navLink(ctx, "/dev", ["dev"], current, t("开发者", "Developers"))}
${navLink(ctx, "/faq", ["faq", "terms", "privacy"], current, t("问问题", "FAQ"))}
${ctx.flags.donate ? navLink(ctx, "/donate", ["donate"], current, t("投喂 ♡", "Feed ♡")) : ""}
${ctx.flags.accounts ? navLink(ctx, "/login", ["login"], current, t("登录", "Log in"), " login") : ""}
<a class="lang" href="?lang=${other}" hreflang="${other}" id="lang-switch" title="${t("Switch to English", "切换到中文")}">${other === "en" ? "EN" : "中"}</a>
<button class="round" type="button" id="theme" title="${t("切换白天 / 夜间", "Toggle day / night")}" aria-label="${t("切换白天 / 夜间", "Toggle day / night")}">${MOON}${SUN}</button>
</nav>
</header>`;
}

export function footer(ctx: Ctx): string {
  const t = tr(ctx);
  return `<footer class="foot">
<span class="c">© 2026 sugi.moe · <span title="すぎ = ${t("太……了", "too much")}">kawaii すぎ</span> <span class="heart">♡</span></span>
<nav>
<a href="/faq" data-nav>${t("问问题", "FAQ")}</a>
<a href="/terms" data-nav>${t("使用条款", "Terms")}</a>
<a href="/privacy" data-nav>${t("隐私政策", "Privacy")}</a>
<a href="/dev" data-nav>${t("开发者", "Developers")}</a>
${ctx.flags.donate ? `<a href="/donate" data-nav>${t("投喂仓仓", "Feed the hamster")}</a>` : ""}
</nav>
</footer>`;
}

export function clientConfig(ctx: Ctx, page: PageId) {
  return {
    lang: ctx.lang,
    page,
    gated: ctx.gated,
    flags: ctx.flags,
    origins: { main: ctx.env.MAIN_ORIGIN, files: ctx.env.FILES_ORIGIN, tmp: ctx.env.TMP_ORIGIN },
    limits: { maxFile: MAX_FILE_BYTES, single: SINGLE_REQUEST_MAX_BYTES, rate: RATE_LIMIT, ratePeriod: RATE_LIMIT_PERIOD_SECONDS },
    t: clientStrings(ctx.lang),
  };
}

export function siteDescription(ctx: Ctx): string {
  return tr(ctx)("匿名、免费、不用注册的图床：拖进来就能拿到图片和短视频的直链，可以永久保存，也可以 1 小时到 3 天后自动消失。", "Anonymous, free image host with no sign-up: drop in a picture or short video and get a direct link, kept forever or deleted after 1 hour to 3 days.");
}

/** Pages that search engines may index, with the OG image family they use. */
export const INDEXABLE: Partial<Record<PageId, string>> = { home: "home", dev: "dev", faq: "faq", terms: "terms", privacy: "privacy", login: "home", donate: "home" };

function langUrl(ctx: Ctx, lang: Lang | null): string {
  const base = `${ctx.env.MAIN_ORIGIN}${ctx.path}`;
  return lang ? `${base}?lang=${lang}` : base;
}

// <title>, description, canonical and hreflang alternates (?lang=zh / ?lang=en, x-default = Accept-Language), robots, Open Graph, Twitter card and JSON-LD.
export function seoHead(ctx: Ctx, page: Page): string {
  const t = tr(ctx);
  const description = page.description ?? siteDescription(ctx);
  const canonical = langUrl(ctx, ctx.lang);
  const family = INDEXABLE[page.id] ?? "home";
  const image = page.ogImage ?? `${ctx.env.MAIN_ORIGIN}${OG_IMAGES[`${family}-${ctx.lang}`] ?? OG_IMAGES[`home-${ctx.lang}`]}`;
  const ogTitle = page.ogTitle ?? page.title;
  const custom = Boolean(page.ogImage);
  const tags = [
    `<title>${esc(page.title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    page.noindex ? `<meta name="robots" content="noindex, nofollow">` : `<link rel="canonical" href="${esc(canonical)}">`,
    ...(page.noindex ? [] : [`<link rel="alternate" hreflang="zh" href="${esc(langUrl(ctx, "zh"))}">`, `<link rel="alternate" hreflang="en" href="${esc(langUrl(ctx, "en"))}">`, `<link rel="alternate" hreflang="x-default" href="${esc(langUrl(ctx, null))}">`]),
    `<meta property="og:site_name" content="sugi.moe">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${esc(ogTitle)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    ...(custom ? [] : [`<meta property="og:image:width" content="1200">`, `<meta property="og:image:height" content="630">`, `<meta property="og:image:alt" content="${esc(t("仓仓趴在纸箱里", "The sugi hamster peeking out of its box"))}">`]),
    `<meta property="og:locale" content="${ctx.lang === "zh" ? "zh_CN" : "en_US"}">`,
    `<meta property="og:locale:alternate" content="${ctx.lang === "zh" ? "en_US" : "zh_CN"}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(ogTitle)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
    ...(page.jsonLd ?? []).map((o) => `<script type="application/ld+json">${jsonForScript(o)}</script>`),
  ];
  return tags.join("\n");
}

export function documentHtml(ctx: Ctx, page: Page): string {
  const t = tr(ctx);
  const nonce = esc(ctx.nonce);
  return `<!doctype html>
<html lang="${ctx.lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin">
${seoHead(ctx, page)}
<meta name="theme-color" content="#F6F4EA">
<link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="${ICONS.png32}">
<link rel="apple-touch-icon" href="${ICONS.apple}">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="preload" as="font" type="font/woff2" href="/static/fonts/zcool-kuaile-subset.woff2" crossorigin>
<link rel="stylesheet" href="${ASSETS.css}" nonce="${nonce}">
<script nonce="${nonce}">${THEME_BOOT}</script>
<script type="application/json" id="sugi-config">${jsonForScript(clientConfig(ctx, page.id))}</script>
<script type="module" src="${ASSETS.js}" nonce="${nonce}"></script>
</head>
<body>
<div class="wrap">
${header(ctx, page.id)}
<main id="main" data-page="${page.id}">
${page.main}
</main>
${footer(ctx)}
</div>
<div id="overlays"></div>
</body>
</html>
`;
}
