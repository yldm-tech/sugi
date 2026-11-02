// The donate page ("Feed the hamster"). It appears only when a payment method is configured (DONATE_ALIPAY_QR or DONATE_ALIPAY_LINK) and shows nothing it cannot back up: the payment method, what is actually paid each month (only costs above zero; the block is left out when nothing is paid), how much of each free tier is used (from the bucket's measured size and the email counter), what the next costs would be at the providers' published prices, and a thank-you list only when the operator configures one.
import { brand } from "../../config";
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

// Published prices, checked 2026-11-02:
// R2 (https://developers.cloudflare.com/r2/pricing/): Standard storage $0.015 per GB-month after 10 GB-month free, billed in whole GB-months; Class A $4.50 and Class B $0.36 per million after 1 and 10 million free each month; no egress fees.
// Workers (https://developers.cloudflare.com/workers/platform/pricing/): Paid plan from $5 a month (10 million requests and 30 million CPU ms included), which also lifts the per-request CPU limit.
// Resend (https://resend.com/pricing): Free 3,000 emails a month and 100 a day; Pro $20 a month for 50,000.
export const R2_USD_PER_GB_MONTH = 0.015;
export const R2_FREE_GB_MONTH = 10;
export const RESEND_FREE_PER_DAY = 100;
export const RESEND_FREE_PER_MONTH = 3000;

/** Monthly storage cost in US dollars for a bucket of `bytes`, at R2's published price. */
export function r2MonthlyCost(bytes: number): number {
  const gb = Math.ceil(bytes / 1024 ** 3);
  return Math.max(0, gb - R2_FREE_GB_MONTH) * R2_USD_PER_GB_MONTH;
}

// Whole dollars as they are, cents otherwise; small amounts need three decimals.
const usd = (n: number) => `US$${Number.isInteger(n) ? n : n < 1 ? n.toFixed(3).replace(/0$/, "") : n.toFixed(2)}`;
const size = (b: number) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;

export interface DonateNumbers {
  storage: StorageSnapshot;
  /** Emails sent through the provider; null when this instance sends none. */
  mail: { today: number; month: number; countedSince: string } | null;
}

function bar(label: string, used: string, of: string, frac: number): string {
  // A native progress bar: no inline styles needed under the page CSP. Tiny shares still show a sliver.
  const value = frac > 0 ? Math.max(5, Math.min(1000, Math.round(frac * 1000))) : 0;
  return `<li><div class="use-head"><b>${label}</b><span class="num">${used} / ${of}</span></div><progress max="1000" value="${value}">${Math.round(frac * 100)}%</progress></li>`;
}

export function donatePage(ctx: Ctx, n: DonateNumbers): Page {
  const t = tr(ctx);
  const b = brand(ctx.env);
  const c = donateConfig(ctx.env);
  const site = esc(b.siteName);
  // Latin names get spaces around them in Chinese text; 维护者 does not.
  const who = b.operator ? t(` ${esc(b.operator)} `, esc(b.operator)) : t("维护者", "its maintainers");

  // What is actually paid each month: only amounts above zero; the block is left out when nothing is paid.
  const r2 = r2MonthlyCost(n.storage.bytes);
  const paid: [string, string, number][] = [
    ...(c.domainCostUsd
      ? [
          [t(`域名 ${site}`, `The domain ${site}`), t(`每年 ${usd(c.domainCostUsd)}`, `${usd(c.domainCostUsd)} a year`), c.domainCostUsd / 12] as [
            string,
            string,
            number,
          ],
        ]
      : []),
    ...(r2 > 0
      ? [
          [
            t("R2 文件存储", "R2 file storage"),
            t(`${size(n.storage.bytes)}，超出免费额度的部分`, `${size(n.storage.bytes)}, the part above the free tier`),
            r2,
          ] as [string, string, number],
        ]
      : []),
  ];
  const total = paid.reduce((a, [, , m]) => a + m, 0);
  const paidBlock =
    total > 0
      ? `<div class="card donate-costs">
<div class="t">${t("现在每月实际花费", "What it costs each month")}</div>
<ul class="costs">${paid.map(([what, detail, m]) => `<li><div><b>${what}</b><span>${detail}</span></div><span class="num">${t(`约 ${usd(Math.round(m * 100) / 100)} / 月`, `about ${usd(Math.round(m * 100) / 100)} / month`)}</span></li>`).join("")}</ul>
${paid.length > 1 ? `<p class="small">${t(`合计约 ${usd(Math.round(total * 100) / 100)} / 月。`, `About ${usd(Math.round(total * 100) / 100)} a month in total.`)}</p>` : ""}
</div>`
      : "";

  const usage = [
    bar(t("R2 文件存储", "R2 file storage"), size(n.storage.bytes), `${R2_FREE_GB_MONTH} GB`, n.storage.bytes / (R2_FREE_GB_MONTH * 1024 ** 3)),
    ...(n.mail
      ? [
          bar(t("今天发出的邮件", "Emails sent today"), String(n.mail.today), String(RESEND_FREE_PER_DAY), n.mail.today / RESEND_FREE_PER_DAY),
          bar(
            t(
              `本月发出的邮件${n.mail.countedSince.endsWith("-01") ? "" : `（${n.mail.countedSince.slice(5).replace("-", " 月 ")} 日起统计）`}`,
              `Emails sent this month${n.mail.countedSince.endsWith("-01") ? "" : ` (counted since ${n.mail.countedSince})`}`,
            ),
            String(n.mail.month),
            RESEND_FREE_PER_MONTH.toLocaleString("en"),
            n.mail.month / RESEND_FREE_PER_MONTH,
          ),
        ]
      : []),
  ];
  const usageBlock = `<div class="card donate-costs">
<div class="t">${t("免费额度用了多少", "How much of the free tiers is used")}</div>
<ul class="usage">${usage.join("")}</ul>
<p class="small">${t(`存储量 ${new Date(n.storage.at).toISOString().slice(0, 10)} 统计，每隔几个小时更新；邮件按 UTC 日和月计。`, `Storage measured ${new Date(n.storage.at).toISOString().slice(0, 10)} and refreshed every few hours; emails count by UTC day and month.`)}</p>
</div>`;

  const next: [string, string, string, string][] = [
    [
      "Workers Paid",
      t("US$5 / 月起", "from US$5 / month"),
      t(
        "每天超过 10 万次请求时需要。它还能放开每次请求的 CPU 限制：现在超过 20 MB 的文件算不完内容哈希，下架后没法挡住同样文件的重传。",
        "Needed past 100,000 requests a day. It also lifts the per-request CPU limit: today files over 20 MB cannot be content-hashed, so after a takedown the same file cannot be blocked from coming back.",
      ),
      "https://developers.cloudflare.com/workers/platform/pricing/",
    ],
    [
      t("R2 存储和操作", "R2 storage and operations"),
      t("US$0.015 / GB·月", "US$0.015 / GB-month"),
      t(
        `存储超过 ${R2_FREE_GB_MONTH} GB 之后按这个价计；每月超过 100 万次写、1000 万次读之后，再按每百万次 US$4.50、US$0.36 计。流量不收费。`,
        `For storage past ${R2_FREE_GB_MONTH} GB; past 1 million writes and 10 million reads a month, US$4.50 and US$0.36 per million. Traffic is free.`,
      ),
      "https://developers.cloudflare.com/r2/pricing/",
    ],
    ...(n.mail
      ? [
          [
            "Resend Pro",
            t("US$20 / 月", "US$20 / month"),
            t(
              `登录邮件每天超过 ${RESEND_FREE_PER_DAY} 封或每月超过 3,000 封时需要，每月含 5 万封。`,
              `Needed once login emails pass ${RESEND_FREE_PER_DAY} a day or 3,000 a month; includes 50,000 a month.`,
            ),
            "https://resend.com/pricing",
          ] as [string, string, string, string],
        ]
      : []),
  ];
  const nextBlock = `<div class="card donate-costs">
<div class="t">${t("超过免费额度后要付的钱", "What it costs past the free tiers")}</div>
<ul class="costs">${next.map(([what, price, why, link]) => `<li><div><b><a href="${link}" rel="noopener">${what}</a></b><span>${why}</span></div><span class="num">${price}</span></li>`).join("")}</ul>
<p class="small">${t("投喂的钱就是留给这些的。", "That is what chipping in pays for.")}</p>
</div>`;

  const pay = `<div class="card donate-pay">
<div class="t">${t("支付宝", "Alipay")}</div>
${c.alipayQr ? `<img class="donate-qr" src="${esc(c.alipayQr)}" width="240" height="240" alt="${t("支付宝收款码", "Alipay payment QR code")}">` : ""}
${c.alipayQr ? `<p class="small">${t("打开支付宝扫一扫", "Scan it with the Alipay app")}</p>` : ""}
${c.alipayLink ? `<a class="btn${c.alipayQr ? " phone-only" : ""}" href="${esc(c.alipayLink)}" rel="noopener">${t("在支付宝中打开", "Open in Alipay")}</a>` : ""}
</div>`;
  const html = `<section class="center stack8">
<h1 class="h1">${t("投喂仓仓", "Feed the hamster")}</h1>
<p class="lead">${t(
    `${site} 是${who}业余运营的小服务：没有广告，不卖数据，也不靠它赚钱。现在大部分还在免费额度里，用的人多了就会超出，投喂的钱留给那一天。`,
    `${site} is a hobby service run by ${who}: no ads, no selling data, no profit. It mostly runs within free tiers for now; as more people use it, it will outgrow them, and chipping in is for that day.`,
  )}</p>
</section>
<section class="donate-grid">
${pay}
<div class="stack">
${paidBlock}
${usageBlock}
${nextBlock}
</div>
</section>
${c.thanks.length ? `<section class="stack8 center"><h2 class="h2">${t("谢谢这些好心人", "Thank you")} <span class="heart">♡</span></h2><div class="badges center">${c.thanks.map((s) => `<span class="badge">${esc(s)}</span>`).join("")}</div></section>` : ""}`;
  return {
    id: "donate",
    title: pageTitle(ctx, "投喂仓仓", "Feed the hamster"),
    main: html,
    description: t(`${b.siteName} 的运营成本和投喂方式。`, `What running ${b.siteName} costs, and how to chip in.`),
  };
}
