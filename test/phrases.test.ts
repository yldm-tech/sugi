import { describe, expect, it } from "vitest";
import { phraseHtml, phraseLeads } from "../src/site/phrases";
import { call, MAIN } from "./helpers";

describe("Chinese lead paragraphs", () => {
  it("become one line per sentence made of unbreakable clauses", () => {
    expect(phraseHtml("sugi.moe 没有广告，也不卖数据，由 YLDM 运营。投喂会用来付服务器和域名，让仓仓一直开着。")).toBe(
      '<span class="sent"><span class="ph">sugi.moe 没有广告，</span><span class="ph">也不卖数据，</span><span class="ph">由 YLDM 运营。</span></span>' +
        '<span class="sent"><span class="ph">投喂会用来付服务器和域名，</span><span class="ph">让仓仓一直开着。</span></span>',
    );
  });

  it("never cut inside markup", () => {
    const html = phraseHtml('在 <a href="/mine" data-nav>我的文件，看看</a> 里，换设备也能看到。');
    expect(html).toBe(
      '<span class="sent"><span class="ph">在 <a href="/mine" data-nav>我的文件，看看</a> 里，</span><span class="ph">换设备也能看到。</span></span>',
    );
  });

  it("leave English pages alone", () => {
    const main = '<p class="lead">No ads, no tracking.</p>';
    expect(phraseLeads(main, "en")).toBe(main);
  });

  it("is applied to the leads of real pages", async () => {
    const html = await (await call(new Request(`${MAIN}/faq?lang=zh`, { headers: { accept: "text/html" } }))).text();
    expect(html).toMatch(/<p class="lead phrased"><span class="sent"><span class="ph">/);
  });
});
