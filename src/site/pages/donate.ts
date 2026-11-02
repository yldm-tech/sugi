// The donate page ("Feed the hamster"). It appears only when a payment method is configured (DONATE_ALIPAY_QR or DONATE_ALIPAY_LINK) and shows nothing it cannot back up: the payment method, the running costs it can compute (R2 storage from the bucket's measured size at R2's published price, the free plans in use, and the domain renewal only when the operator states it), and a thank-you list only when the operator configures one.
import { brand } from "../../config";
import { emailConfigured } from "../../auth/email";
import type { StorageSnapshot } from "../../ops";
import { esc } from "../i18n";
import { type Ctx, type Page, pageTitle, tr } from "../layout";

export interface DonateConfig {
  /** Image URL of the Alipay collection QR code (served from this site's files host, or an origin added to the page CSP). */
  alipayQr: string | null;
  /** The qr.alipay.com link behind that code, offered as a button on phones. */
  alipayLink: string | null;
  /** Yearly domain renewal in US dollars, as the operator states it; not shown when unset. */
  domainCostUsd: number | null;
  /** Names on the thank-you list, comma-separated in DONATE_THANKS; the list is hidden while it is empty. */
  thanks: string[];
}

const blank = (v: string | undefined | null): string | null => {
  const s = (v ?? "").trim();
  return s ? s : null;
};

export function donateConfig(env: Env): DonateConfig {
  const cost = Number(blank(env.DONATE_DOMAIN_COST_USD) ?? "NaN");
  return {
    alipayQr: blank(env.DONATE_ALIPAY_QR),
    alipayLink: blank(env.DONATE_ALIPAY_LINK),
    domainCostUsd: Number.isFinite(cost) && cost > 0 ? cost : null,
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

// R2 Standard storage as published at https://developers.cloudflare.com/r2/pricing/ (checked 2026-11-02): $0.015 per GB-month after the first 10 GB-month each month, billed in whole GB-months. Egress is free.
export const R2_USD_PER_GB_MONTH = 0.015;
export const R2_FREE_GB_MONTH = 10;

/** Monthly storage cost in US dollars for a bucket of `bytes`, at R2's published price. */
export function r2MonthlyCost(bytes: number): number {
  const gb = Math.ceil(bytes / 1024 ** 3);
  return Math.max(0, gb - R2_FREE_GB_MONTH) * R2_USD_PER_GB_MONTH;
}

// Whole dollars as they are, cents otherwise; R2's per-GB price needs three decimals.
const usd = (n: number) => `US$${Number.isInteger(n) ? n : n < 1 ? n.toFixed(3).replace(/0$/, "") : n.toFixed(2)}`;
const size = (b: number) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;

export function donatePage(ctx: Ctx, storage: StorageSnapshot): Page {
  const t = tr(ctx);
  const b = brand(ctx.env);
  const c = donateConfig(ctx.env);
  const site = esc(b.siteName);
  const who = b.operator ? esc(b.operator) : t("维护者", "its maintainers");
  const rows: [string, string, string][] = [
    [
      t("R2 文件存储", "R2 file storage"),
      t(
        `现在存了 ${storage.objects} 个文件，共 ${size(storage.bytes)}（${new Date(storage.at).toISOString().slice(0, 10)} 统计）。每月前 ${R2_FREE_GB_MONTH} GB 免费，超出的部分每 GB ${usd(R2_USD_PER_GB_MONTH)}，流量不收费。`,
        `${storage.objects} files, ${size(storage.bytes)} in total (measured ${new Date(storage.at).toISOString().slice(0, 10)}). The first ${R2_FREE_GB_MONTH} GB a month are free, then ${usd(R2_USD_PER_GB_MONTH)} per GB; traffic is free.`,
      ),
      t(`${usd(r2MonthlyCost(storage.bytes))} / 月`, `${usd(r2MonthlyCost(storage.bytes))} / month`),
    ],
    [t("Workers 和 D1 数据库", "Workers and the D1 database"), t("Cloudflare 免费计划。", "Cloudflare's free plan."), t("US$0 / 月", "US$0 / month")],
    ...(emailConfigured(ctx.env) && ctx.env.RESEND_API_KEY
      ? [
          [t("登录邮件（Resend）", "Login emails (Resend)"), t("免费额度，每天 100 封。", "Free tier, 100 emails a day."), t("US$0 / 月", "US$0 / month")] as [
            string,
            string,
            string,
          ],
        ]
      : []),
    ...(c.domainCostUsd
      ? [
          [
            t(`域名 ${site}`, `The domain ${site}`),
            t("每年续费一次。", "Renewed once a year."),
            t(`${usd(c.domainCostUsd)} / 年`, `${usd(c.domainCostUsd)} / year`),
          ] as [string, string, string],
        ]
      : []),
  ];
  const pay = `<div class="card donate-pay">
<div class="t">${t("支付宝", "Alipay")}</div>
${c.alipayQr ? `<img class="donate-qr" src="${esc(c.alipayQr)}" width="240" height="240" alt="${t("支付宝收款码", "Alipay payment QR code")}">` : ""}
${c.alipayQr ? `<p class="small">${t("打开支付宝扫一扫", "Scan it with the Alipay app")}</p>` : ""}
${c.alipayLink ? `<a class="btn${c.alipayQr ? " phone-only" : ""}" href="${esc(c.alipayLink)}" rel="noopener">${t("在支付宝中打开", "Open in Alipay")}</a>` : ""}
</div>`;
  const costs = `<div class="card donate-costs">
<div class="t">${t("钱花在哪", "Where the money goes")}</div>
<ul class="costs">${rows.map(([what, detail, amount]) => `<li><div><b>${what}</b><span>${detail}</span></div><span class="num">${amount}</span></li>`).join("")}</ul>
<p class="small">${t(
    'R2 价格来自 Cloudflare 公布的 <a href="https://developers.cloudflare.com/r2/pricing/" rel="noopener">R2 价格表</a>，存储量每隔几个小时统计一次。',
    'R2 prices are from Cloudflare\'s published <a href="https://developers.cloudflare.com/r2/pricing/" rel="noopener">R2 pricing</a>; the storage figure is measured every few hours.',
  )}</p>
</div>`;
  const html = `<section class="center stack8">
<h1 class="h1">${t("投喂仓仓", "Feed the hamster")}</h1>
<p class="lead">${t(
    `${site} 是 ${who} 业余运营的小服务：没有广告，不卖数据，也不靠它赚钱。现在的花费不多，大部分还在免费额度里。投喂全凭心意，会用来付域名，以及以后越存越多的文件。`,
    `${site} is a hobby service run by ${who}: no ads, no selling data, no profit. It costs little for now, mostly within free tiers. Chipping in is entirely optional; it pays for the domain and for storage as it grows.`,
  )}</p>
</section>
<section class="donate-grid">
${pay}
${costs}
</section>
${c.thanks.length ? `<section class="stack8 center"><h2 class="h2">${t("谢谢这些好心人", "Thank you")} <span class="heart">♡</span></h2><div class="badges center">${c.thanks.map((s) => `<span class="badge">${esc(s)}</span>`).join("")}</div></section>` : ""}`;
  return {
    id: "donate",
    title: pageTitle(ctx, "投喂仓仓", "Feed the hamster"),
    main: html,
    description: t(`${b.siteName} 的运营成本和投喂方式。`, `What running ${b.siteName} costs, and how to chip in.`),
  };
}
