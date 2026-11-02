// The donate page ("Feed the hamster"). It appears only when a payment method is configured (DONATE_ALIPAY_QR or DONATE_ALIPAY_LINK). A warm, simple page: who runs the site and what chipping in is for, a few playful amounts that only change the hint next to the QR code (no claims about what each buys, no progress bars), the QR code itself, and a thank-you list only when the operator configures one. Running costs and provider prices live in docs/operations.md, not here.
import { brand } from "../../config";
import { esc } from "../i18n";
import { type Ctx, type Page, pageTitle, tr } from "../layout";
import { hamsterFace } from "../svg";

export interface DonateConfig {
  /** Image URL of the Alipay collection QR code (served from this site's files host, or an origin added to the page CSP). */
  alipayQr: string | null;
  /** The qr.alipay.com link behind that code, offered as a button on phones. */
  alipayLink: string | null;
  /** Names on the thank-you list, comma-separated in DONATE_THANKS; the list is hidden while it is empty. */
  thanks: string[];
}

const blank = (v: string | undefined | null): string | null => {
  const s = (v ?? "").trim();
  return s ? s : null;
};

export function donateConfig(env: Env): DonateConfig {
  return {
    alipayQr: blank(env.DONATE_ALIPAY_QR),
    alipayLink: blank(env.DONATE_ALIPAY_LINK),
    thanks: (env.DONATE_THANKS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export function donateOn(env: Env): boolean {
  const c = donateConfig(env);
  return Boolean(c.alipayQr || c.alipayLink);
}

/** Suggested amounts (yuan): only a hint for what to type after scanning. */
export const DONATE_AMOUNTS: { icon: string; zh: string; en: string; yuan: number }[] = [
  { icon: "🌰", zh: "一把瓜子", en: "A handful of seeds", yuan: 6 },
  { icon: "🍎", zh: "一个苹果", en: "An apple", yuan: 18 },
  { icon: "🍰", zh: "一块蛋糕", en: "A slice of cake", yuan: 50 },
  { icon: "🏠", zh: "一个小窝", en: "A little nest", yuan: 200 },
];
const DEFAULT_AMOUNT = 18;

export function donatePage(ctx: Ctx): Page {
  const t = tr(ctx);
  const b = brand(ctx.env);
  const c = donateConfig(ctx.env);
  const site = esc(b.siteName);
  // Latin names get spaces around them in Chinese text; 维护者 does not.
  const who = b.operator ? t(` ${esc(b.operator)} `, esc(b.operator)) : t("维护者", "its maintainers");
  const hint = (yuan: number) => t(`扫码后输入 ¥${yuan}`, `Scan, then enter ¥${yuan}`);
  const amounts = `<div class="donate-amounts" role="radiogroup" aria-label="${t("选一份口粮", "Pick a snack")}" data-hint-zh="扫码后输入 ¥{n}" data-hint-en="Scan, then enter ¥{n}">
${DONATE_AMOUNTS.map(
  (a) =>
    `<button type="button" class="card donate-amount${a.yuan === DEFAULT_AMOUNT ? " on" : ""}" role="radio" aria-checked="${a.yuan === DEFAULT_AMOUNT}" data-yuan="${a.yuan}"><span class="ic" aria-hidden="true">${a.icon}</span><span class="nm">${t(a.zh, a.en)}</span><span class="yuan">¥${a.yuan}</span></button>`,
).join("\n")}
</div>`;
  // 仓仓 with a little bowl of seeds.
  const mascot = `<div class="donate-mascot" aria-hidden="true">${hamsterFace(96, 88, 2.4)}<svg class="bowl" viewBox="0 0 80 34" width="104" height="44"><ellipse cx="22" cy="9" rx="3.6" ry="2.6" fill="#7A5230"/><ellipse cx="31" cy="6" rx="3.6" ry="2.6" fill="#8B5E36"/><ellipse cx="40" cy="8" rx="3.6" ry="2.6" fill="#7A5230"/><ellipse cx="49" cy="5.5" rx="3.6" ry="2.6" fill="#8B5E36"/><ellipse cx="58" cy="9" rx="3.6" ry="2.6" fill="#7A5230"/><path d="M6 11 H74 C72 25 60 31 40 31 C20 31 8 25 6 11 Z" fill="#F5D3A6" stroke="#4A5646" stroke-width="2.4" stroke-linejoin="round"/><path d="M16 18 C24 22 32 23 40 23" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity="0.7"/></svg></div>`;
  const html = `<section class="center stack8 donate-head">
${mascot}
<h1 class="h1">${t("投喂仓仓", "Feed the hamster")}</h1>
<p class="lead">${t(
    `${site} 没有广告，也不卖数据，由${who}运营。投喂会用来付服务器和域名，让仓仓一直开着。`,
    `${site} has no ads and sells no data. It is <span class="nw">run by ${who}${who.endsWith(".") ? "" : "."}</span> Chipping in pays for the servers and the domain, so the hamster stays open.`,
  )}</p>
</section>
<section class="stack8">
<h2 class="h2">${t("选一份口粮", "Pick a snack")}</h2>
${amounts}
</section>
<section class="card donate-pay">
${c.alipayQr ? `<img class="donate-qr" src="${esc(c.alipayQr)}" width="280" height="280" alt="${t("支付宝收款码", "Alipay payment QR code")}">` : ""}
<div class="donate-pay-text">
<div class="t">${t("支付宝扫码投喂", "Scan with Alipay")}</div>
<p class="donate-hint" id="donate-hint">${hint(DEFAULT_AMOUNT)}</p>
${c.alipayLink ? `<a class="btn${c.alipayQr ? " phone-only" : ""}" href="${esc(c.alipayLink)}" rel="noopener">${t("在支付宝中打开", "Open in Alipay")}</a>` : ""}
<p class="small">${t("不投喂也完全没关系，常来玩就好。", "Not chipping in is completely fine; just come and play.")}</p>
</div>
</section>
${c.thanks.length ? `<section class="stack8"><h2 class="h2">${t("谢谢这些好心人", "Thank you")} <span class="heart">♡</span></h2><div class="badges">${c.thanks.map((s) => `<span class="badge">${esc(s)}</span>`).join("")}</div></section>` : ""}`;
  return {
    id: "donate",
    title: pageTitle(ctx, "投喂仓仓", "Feed the hamster"),
    main: html,
    description: t(`投喂 ${b.siteName} 的仓仓。`, `Feed the ${b.siteName} hamster.`),
  };
}
