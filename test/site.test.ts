import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ASSETS } from "../src/generated/assets";
import { call, MAIN, mp4, png, upload, freshIp, TRUSTED } from "./helpers";

const page = (path = "/", init: RequestInit = {}, overrides: Partial<Env> = {}) => call(new Request(`${MAIN}${path}`, init), overrides);
const zh = { headers: { "accept-language": "zh-CN,zh;q=0.9" } };

function nonceOf(res: Response): string {
  return /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(res.headers.get("content-security-policy") ?? "")![1];
}

describe("page CSP", () => {
  it("allows only nonce'd scripts and styles, never inline attributes", async () => {
    const res = await page();
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    const nonce = nonceOf(res);
    expect(csp).toBe(
      `default-src 'none'; script-src 'nonce-${nonce}' 'strict-dynamic'; style-src 'nonce-${nonce}'; img-src 'self' data: blob: https://files.sugi.moe https://tmp.sugi.moe; media-src 'self' blob: https://files.sugi.moe https://tmp.sugi.moe; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    );
    expect(csp).not.toContain("unsafe");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const html = await res.text();
    // JSON-LD blocks are data, not code; everything else must be ours and carry the nonce.
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]).filter((a) => a !== ' type="application/ld+json"');
    expect(scripts).toEqual([` nonce="${nonce}"`, ' type="application/json" id="sugi-config"', ` type="module" src="${ASSETS.js}" nonce="${nonce}"`]);
    expect(html).toContain(`<link rel="stylesheet" href="${ASSETS.css}" nonce="${nonce}">`);
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/(src|href)="https?:\/\/(?!sugi\.moe|files\.sugi\.moe|tmp\.sugi\.moe)/);
    expect(nonceOf(await page())).not.toBe(nonce);
  });

  it("applies the same CSP to every page", async () => {
    for (const path of ["/mine", "/dev", "/faq", "/terms", "/nope"]) {
      const res = await page(path);
      const html = await res.text();
      expect(res.headers.get("content-security-policy"), path).toContain("'strict-dynamic'");
      expect(html, path).not.toMatch(/\sstyle=|\son[a-z]+=/i);
    }
  });
});

describe("language", () => {
  it("defaults to English, follows Accept-Language, and lets ?lang= set a cookie", async () => {
    const en = await page();
    expect(en.headers.get("content-language")).toBe("en");
    expect(await en.text()).toContain('href="?lang=zh"');
    const z = await page("/", zh);
    expect(z.headers.get("content-language")).toBe("zh-CN");
    expect(await z.text()).toContain("把图图交给仓仓吧～");

    const sw = await page("/?lang=zh");
    expect(sw.headers.get("set-cookie")).toBe("sugi_lang=zh; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
    expect((await page("/", { headers: { cookie: "sugi_lang=zh", "accept-language": "en" } })).headers.get("content-language")).toBe("zh-CN");
    expect((await page("/?lang=en", { headers: { cookie: "sugi_lang=zh" } })).headers.get("content-language")).toBe("en");
    expect((await page("/", { headers: { "accept-language": "fr,ja;q=0.8" } })).headers.get("content-language")).toBe("en");
    expect(en.headers.get("vary")).toContain("Accept-Language");
  });
});

describe("pages", () => {
  it.each([
    ["/", "zh", ["把图图交给仓仓吧～", "把图片和视频拖到这里", "单个文件最大 200 MB", "传完自动复制", "抹掉照片位置信息", "可爱链接名", "传完啾一声", "搬过来", "暂未开放匿名上传"]],
    ["/", "en", ["Hand your pics to the hamster~", "Drop images and videos here", "up to 200 MB per file", "Strip photo location", "Cute link names", "Anonymous uploads are not open yet"]],
    ["/mine", "zh", ["我的文件", "仓库还空空的", "导出记录", "打包链接"]],
    ["/mine", "en", ["My files", "Nothing stashed yet", "Export"]],
    ["/faq", "zh", ["问问仓仓", "公开", "不保存你的 IP 地址", "HMAC", "abuse@sugi.moe", "200 MB", "PNG、JPEG、WebP、GIF、AVIF、MP4、WebM", "tmp.sugi.moe", "CSAM"]],
    ["/faq", "en", ["Ask the hamster", "public", "Not your IP address", "HMAC", "abuse@sugi.moe", "200 MB"]],
    ["/terms", "zh", ["使用条款", "儿童性剥削", "所有上传都是公开的", "HMAC", "abuse@sugi.moe"]],
    ["/terms", "en", ["Terms of use", "public", "HMAC", "abuse@sugi.moe"]],
  ])("%s renders in %s", async (path, lang, needles) => {
    const res = await page(path, lang === "zh" ? zh : {});
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const n of needles) expect(html, n).toContain(n);
    expect(html).not.toMatch(/msime|水杉|截图上传|PR screenshot/i);
  });

  it("the developer page documents exactly the real endpoints and limits", async () => {
    const html = await (await page("/dev", zh)).text();
    for (const ep of ["POST /api/upload", "PUT /api/upload", "POST /api/uploads?size=…", "PUT /api/uploads/:n", "POST /api/uploads/complete", "GET /api/files/:id", "DELETE /api/files/:id", "POST /api/albums", "GET /api/albums/:id", "DELETE /api/albums/:id"]) expect(html, ep).toContain(ep);
    expect(html).toContain("每个 IP 每 60 秒最多 10 次上传");
    expect(html).toContain("每个 IP 每 10 秒最多 5 次请求");
    expect(html).toContain("Sugi-Token");
    expect(html).toContain("curl -F &#34;file=@cat.png&#34; https://sugi.moe/api/upload");
    expect(html).toContain("Authorization: Bearer");
    const en = await (await page("/dev")).text();
    expect(en).toContain(`each IP may start 10 uploads per 60 seconds`);
  });

  it("hides flagged pages and nav entries until their phase ships", async () => {
    const html = await (await page("/")).text();
    expect(html).not.toContain('href="/donate"');
    expect(html).not.toContain('href="/login"');
    expect((await page("/donate")).status).toBe(404);
    expect((await page("/login")).status).toBe(404);
    const on = { FEATURE_DONATE: "1", FEATURE_ACCOUNTS: "1" };
    expect((await page("/donate", {}, on)).status).toBe(200);
    expect((await page("/login", {}, on)).status).toBe(200);
    const flagged = await (await page("/", {}, on)).text();
    expect(flagged).toContain('href="/donate"');
    expect(flagged).toContain('href="/login"');
    // The donate page invents nothing: with no data it shows only the introduction.
    const donate = await (await page("/donate", zh, on)).text();
    expect(donate).not.toMatch(/¥|\$\d|yuki|Momo/);
  });

  it("unknown paths get the 404 page", async () => {
    const res = await page("/no/such/page", zh);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("仓仓翻遍了腮帮子也没找到");
  });

  it("returns only the main content as JSON for in-page navigation", async () => {
    const res = await page("/faq", { headers: { "x-sugi-partial": "1", ...zh.headers } });
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = await res.json<{ page: string; title: string; html: string }>();
    expect(body.page).toBe("faq");
    expect(body.title).toBe("问问题 · sugi.moe");
    expect(body.html).toContain("问问仓仓");
    expect(body.html).not.toContain("<html");
  });
});

describe("file and album pages", () => {
  it("renders a file page with the media, link formats and a QR code", async () => {
    const r = await upload(png(), "?name=cat%20%3Cb%3E.png");
    const res = await page(`/f/${r.id}`, zh);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<img src="${r.url}"`);
    expect(html).toContain("cat &#60;b&#62;.png");
    expect(html).not.toContain("<b>.png");
    expect(html).toContain(`![cat &#60;b&#62;.png](${r.url})`);
    expect(html).toContain(`[img]${r.url}[/img]`);
    expect(html).toContain('aria-label="QR"');
    expect(html).toContain(`https://sugi.moe/f/${r.id}`);
    expect(html).toContain("永久");
  });

  it("renders videos with a video element and temporary files with an expiry badge", async () => {
    const r = await upload(mp4(), "?expire=12h");
    const html = await (await page(`/f/${r.id}`)).text();
    expect(html).toContain(`<video src="${r.url}" controls`);
    expect(html).toMatch(/data-expires="\d+"/);
  });

  it("404s for unknown files and albums", async () => {
    expect((await page("/f/zzzzzzzz")).status).toBe(404);
    expect((await page("/a/zzzzzzzz")).status).toBe(404);
    expect((await page("/f/../../x")).status).toBe(404);
  });

  it("renders an album page", async () => {
    const a = await upload(png());
    const b = await upload(mp4());
    const res = await call(new Request(`${MAIN}/api/albums`, { method: "POST", body: JSON.stringify({ files: [a.id, b.id], title: "猫猫合集" }), headers: { "cf-connecting-ip": freshIp(), ...TRUSTED, "content-type": "application/json", accept: "application/json" } }));
    const al = await res.json<{ id: string }>();
    const html = await (await page(`/a/${al.id}`, zh)).text();
    expect(html).toContain("猫猫合集");
    expect(html).toContain("2 个文件");
    expect(html).toContain(`<img src="${a.url}"`);
    expect(html).toContain(`<video src="${b.url}"`);
    expect(html).toContain(`https://sugi.moe/a/${al.id}`);
  });
});

describe("static files", () => {
  it("serves the bundle with long caching and fonts with nosniff", async () => {
    const js = await page(ASSETS.js);
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    const font = await page("/static/fonts/zcool-kuaile-subset.woff2");
    expect(font.status).toBe(200);
    expect(font.headers.get("cache-control")).toBe("public, max-age=86400");
    expect((await page("/static/nope.js")).status).toBe(404);
    const fav = await page("/favicon.ico");
    expect(fav.status).toBe(200);
    expect(fav.headers.get("content-type")).toBe("image/png");
  });
});

describe("privacy policy", () => {
  it("renders in both languages, is linked everywhere and never shows the review notes", async () => {
    const { privacySections } = await import("../src/site/pages/privacy");
    const { brand } = await import("../src/config");
    const PRIVACY = privacySections(brand(env));
    for (const lang of ["zh", "en"] as const) {
      const html = await (await page("/privacy", lang === "zh" ? zh : {})).text();
      expect(html).toContain(lang === "zh" ? "隐私政策" : "Privacy policy");
      expect(html).toContain("HMAC");
      expect(html).toContain("abuse@sugi.moe");
      expect(html).toContain("sugi_lang");
      expect(html, "2-year limit on source fingerprints").toContain(lang === "zh" ? "来源指纹最长保留 2 年" : "source fingerprint is kept for at most 2 years");
      expect(html).not.toContain("sugi_session");
      for (const s of PRIVACY) for (const p of s.paras) if (p.review) expect(html).not.toContain(p.review);
    }
    for (const path of ["/", "/faq", "/terms"]) expect(await (await page(path, zh)).text(), path).toContain('href="/privacy"');
    expect(await (await page("/login", zh, { FEATURE_ACCOUNTS: "1" })).text()).toContain('href="/privacy"');
  });

  it("describes accounts only when accounts are on", async () => {
    const on = await (await page("/privacy", zh, { FEATURE_ACCOUNTS: "1", ACCOUNT_FEATURES: "email,github,google,passkey,sync,tokens" })).text();
    expect(on).toContain("sugi_session");
    expect(on).toContain("通行密钥的公钥");
  });
});

describe("operator sentence", () => {
  it("does not double the full stop after an operator name ending in one", async () => {
    const terms = await (await page("/terms?lang=en")).text();
    expect(terms).toContain("sugi.moe is operated by YLDM Co., Ltd. By using sugi.moe");
    expect(terms).not.toContain("Ltd..");
  });
});

describe("responsive markup", () => {
  it("keeps the header tools out of the scrolling link row, and fact phrases whole", async () => {
    const html = await (await page("/", zh)).text();
    expect(html).toMatch(/<\/nav>\s*<div class="tools">\s*<a class="lang"/);
    expect(html).toContain('<span class="nw">单个文件最大 200 MB</span>');
    expect(html).toMatch(/<span class="nw">也可以 <span class="kbd" id="paste-key">/);
  });
});
