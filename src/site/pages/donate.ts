import { esc } from "../i18n";
import { type Ctx, type Page, pageTitle, tr } from "../layout";

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
