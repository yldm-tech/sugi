import { describe, expect, it } from "vitest";
import { ICONS, OG_IMAGES } from "../src/site/og-images";
import { call, FILES, MAIN, mp4, png, upload } from "./helpers";

const get = (path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) =>
  call(new Request(path.startsWith("http") ? path : `${MAIN}${path}`, init), overrides);

// Minimal <head> parser: meta/link attributes and JSON-LD blocks.
function head(html: string) {
  const attrs = (tag: string) =>
    Object.fromEntries([...tag.matchAll(/([a-z:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))]));
  const metas = [...html.matchAll(/<meta\b[^>]*>/g)].map((m) => attrs(m[0]));
  const links = [...html.matchAll(/<link\b[^>]*>/g)].map((m) => attrs(m[0]));
  const meta = (key: string) => metas.find((m) => m.property === key || m.name === key)?.content;
  const jsonLd = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  return { meta, links, jsonLd, title };
}

describe("robots and sitemap", () => {
  it("robots.txt allows the site, blocks the API and points to the sitemap", async () => {
    const res = await get("/robots.txt");
    const body = await res.text();
    expect(body).toContain("Disallow: /api/");
    expect(body).toContain("Disallow: /mcp");
    expect(body).toContain("Sitemap: https://sugi.moe/sitemap.xml");
    expect(body).not.toMatch(/Disallow: \/f\/|Disallow: \/a\//);
    const files = await get(`${FILES}/robots.txt`);
    expect(files.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("sitemap lists the public pages in both languages with alternates, and flagged pages only when on", async () => {
    const xml = await (await get("/sitemap.xml")).text();
    for (const p of ["/", "/dev", "/faq", "/terms", "/privacy"]) {
      expect(xml).toContain(`<loc>https://sugi.moe${p}?lang=zh</loc>`);
      expect(xml).toContain(`<loc>https://sugi.moe${p}?lang=en</loc>`);
    }
    expect(xml).toContain('hreflang="x-default" href="https://sugi.moe/faq"');
    expect(xml).not.toContain("/donate");
    expect(xml).not.toContain("/login");
    expect(xml).not.toContain("/mine");
    const on = await (await get("/sitemap.xml", {}, { FEATURE_DONATE: "1", FEATURE_ACCOUNTS: "1" })).text();
    expect(on).toContain("https://sugi.moe/donate?lang=zh");
    expect(on).toContain("https://sugi.moe/login?lang=en");
  });
});

describe("page metadata", () => {
  it.each([
    ["/", "zh", "sugi.moe · 可爱过头的图床", "home"],
    ["/", "en", "sugi.moe · the cutest image host", "home"],
    ["/dev", "zh", "开发者 · sugi.moe", "dev"],
    ["/faq", "en", "FAQ · sugi.moe", "faq"],
    ["/terms", "zh", "使用条款 · sugi.moe", "terms"],
    ["/privacy", "en", "Privacy · sugi.moe", "privacy"],
  ])("%s (%s) has title, description, canonical, hreflang, Open Graph and Twitter tags", async (path, lang, title, family) => {
    const res = await get(`${path}?lang=${lang}`);
    expect(res.headers.get("x-robots-tag")).toBeNull();
    const h = head(await res.text());
    expect(h.title).toBe(title);
    expect(h.meta("description")!.length).toBeGreaterThan(20);
    const canonical = `https://sugi.moe${path}?lang=${lang}`;
    expect(h.links.find((l) => l.rel === "canonical")?.href).toBe(canonical);
    expect(h.links.filter((l) => l.rel === "alternate").map((l) => `${l.hreflang} ${l.href}`)).toEqual([
      `zh https://sugi.moe${path}?lang=zh`,
      `en https://sugi.moe${path}?lang=en`,
      `x-default https://sugi.moe${path}`,
    ]);
    expect(h.meta("og:title")).toBe(title);
    expect(h.meta("og:url")).toBe(canonical);
    expect(h.meta("og:type")).toBe("website");
    expect(h.meta("og:image")).toBe(`https://sugi.moe${OG_IMAGES[`${family}-${lang}`]}`);
    expect(h.meta("og:image:width")).toBe("1200");
    expect(h.meta("og:image:height")).toBe("630");
    expect(h.meta("og:locale")).toBe(lang === "zh" ? "zh_CN" : "en_US");
    expect(h.meta("twitter:card")).toBe("summary_large_image");
    expect(h.meta("twitter:image")).toBe(h.meta("og:image"));
    expect(h.meta("robots")).toBeUndefined();
    expect(h.links.find((l) => l.rel === "manifest")?.href).toBe("/manifest.webmanifest");
    expect(h.links.find((l) => l.rel === "apple-touch-icon")?.href).toBe(ICONS.apple);
  });

  it("the home page carries WebSite and Organization JSON-LD", async () => {
    const h = head(await (await get("/?lang=en")).text());
    const types = h.jsonLd.map((o) => o["@type"]);
    expect(types).toEqual(["WebSite", "Organization"]);
    expect(h.jsonLd[1]).toMatchObject({ name: "YLDM Co., Ltd.", url: "https://sugi.moe/" });
  });

  it("the FAQ carries FAQPage JSON-LD with plain-text answers", async () => {
    const h = head(await (await get("/faq?lang=zh")).text());
    const faq = h.jsonLd[0];
    expect(faq["@type"]).toBe("FAQPage");
    expect(faq.mainEntity.length).toBeGreaterThanOrEqual(10);
    for (const q of faq.mainEntity) {
      expect(q["@type"]).toBe("Question");
      expect(q.acceptedAnswer.text).not.toMatch(/<[a-z]/);
    }
  });
});

describe("noindex", () => {
  it("user content, personal pages and errors are noindex with header and meta", async () => {
    const img = await upload(png());
    const vid = await upload(mp4(), "?expire=1h");
    for (const path of [`/f/${img.id}`, `/f/${vid.id}`, "/mine", "/nope"]) {
      const res = await get(path);
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex");
      const h = head(await res.text());
      expect(h.meta("robots"), path).toBe("noindex, nofollow");
      expect(
        h.links.find((l) => l.rel === "canonical"),
        path,
      ).toBeUndefined();
    }
    // A permanent image previews itself; a temporary video falls back to the site image. Both use the site title.
    const ih = head(await (await get(`/f/${img.id}?lang=en`)).text());
    expect(ih.meta("og:image")).toBe(img.url);
    expect(ih.meta("og:title")).toBe("sugi.moe · the cutest image host");
    const vh = head(await (await get(`/f/${vid.id}?lang=en`)).text());
    expect(vh.meta("og:image")).toBe(`https://sugi.moe${OG_IMAGES["home-en"]}`);
  });

  it("files on the file hosts and legacy links are noindex", async () => {
    const r = await upload(png());
    expect((await get(r.url)).headers.get("x-robots-tag")).toBe("noindex");
    expect((await get(`${FILES}/zzzzzzzz.png`)).headers.get("x-robots-tag")).toBe("noindex");
    const fd = new FormData();
    fd.append("file", new Blob([png()]), "x.png");
    const legacy = await call(new Request(`${MAIN}/upload`, { method: "POST", body: fd, headers: { authorization: "Bearer test-trusted-token" } }));
    const url = (await legacy.text()).trim();
    expect((await get(url)).headers.get("x-robots-tag")).toBe("noindex");
  });
});

describe("icons, manifest and OG images", () => {
  function pngSize(bytes: Uint8Array): [number, number] {
    const v = new DataView(bytes.buffer, bytes.byteOffset);
    return [v.getUint32(16), v.getUint32(20)];
  }

  it("serves every OG image as a 1200x630 PNG with long caching", async () => {
    expect(Object.keys(OG_IMAGES).sort()).toEqual([
      "dev-en",
      "dev-zh",
      "faq-en",
      "faq-zh",
      "home-en",
      "home-zh",
      "privacy-en",
      "privacy-zh",
      "terms-en",
      "terms-zh",
    ]);
    for (const path of Object.values(OG_IMAGES)) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(pngSize(new Uint8Array(await res.arrayBuffer())), path).toEqual([1200, 630]);
    }
  });

  it("serves the manifest and icons", async () => {
    const res = await get("/manifest.webmanifest");
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    const m = await res.json<{ name: string; theme_color: string; icons: { src: string; sizes: string }[] }>();
    expect(m).toMatchObject({ name: "sugi.moe", theme_color: "#F6F4EA" });
    for (const icon of m.icons) expect((await get(icon.src)).status, icon.src).toBe(200);
    const sizes: [string, [number, number]][] = [
      [ICONS.png32, [32, 32]],
      [ICONS.png192, [192, 192]],
      [ICONS.png512, [512, 512]],
      [ICONS.apple, [180, 180]],
    ];
    for (const [path, size] of sizes) expect(pngSize(new Uint8Array(await (await get(path)).arrayBuffer()))).toEqual(size);
    expect((await get("/apple-touch-icon.png")).headers.get("content-type")).toBe("image/png");
  });
});
