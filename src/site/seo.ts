import { brand } from "../config";
import { flagsOf } from "./layout";
import { ICONS } from "./og-images";

const TEXT = { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" };

// Crawl everything public; user content pages carry noindex themselves (meta robots and X-Robots-Tag), which only works if crawlers may fetch them.
export function robotsTxt(env: Env): Response {
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /mcp",
    "Disallow: /admin/",
    "Disallow: /auth/",
    "Disallow: /healthz",
    "",
    `Sitemap: ${env.MAIN_ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");
  return new Response(body, { headers: TEXT });
}

/** files./tmp. hosts: allowed to crawl (so X-Robots-Tag: noindex is seen) but nothing is indexable. */
export function fileHostRobotsTxt(): Response {
  return new Response("User-agent: *\nAllow: /\n", { headers: { ...TEXT, "x-robots-tag": "noindex" } });
}

export function sitemapPaths(env: Env): string[] {
  const flags = flagsOf(env);
  return ["/", "/dev", "/faq", "/terms", "/privacy", ...(flags.donate ? ["/donate"] : []), ...(flags.accounts ? ["/login"] : [])];
}

export function sitemapXml(env: Env): Response {
  const urls = sitemapPaths(env)
    .map((p) => {
      const base = `${env.MAIN_ORIGIN}${p}`;
      const alt = (lang: string, href: string) => `<xhtml:link rel="alternate" hreflang="${lang}" href="${href}"/>`;
      return ["zh", "en"]
        .map((lang) => `<url><loc>${base}?lang=${lang}</loc>${alt("zh", `${base}?lang=zh`)}${alt("en", `${base}?lang=en`)}${alt("x-default", base)}</url>`)
        .join("\n");
    })
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
}

export function webManifest(env: Env): Response {
  const name = brand(env).siteName;
  const manifest = {
    name,
    short_name: name.split(".")[0] || name,
    description: "Anonymous image and short video host",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#F6F4EA",
    theme_color: "#F6F4EA",
    icons: [
      { src: "/static/favicon.svg", type: "image/svg+xml", sizes: "any" },
      { src: ICONS.png192, type: "image/png", sizes: "192x192" },
      { src: ICONS.png512, type: "image/png", sizes: "512x512" },
      { src: ICONS.png512, type: "image/png", sizes: "512x512", purpose: "maskable" },
    ],
  };
  return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=86400" } });
}
