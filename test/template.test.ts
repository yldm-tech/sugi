import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureSchema, MIGRATIONS, statements } from "../src/migrate";
import { OG_IMAGES, OG_IMAGES_GENERIC } from "../src/site/og-images";
import { call, freshIp, png, TRUSTED } from "./helpers";

// A deployment of the template configuration (wrangler.jsonc as committed): no branding, no custom domains, served from *.workers.dev.
const HOST = "https://my-sugi.example.workers.dev";
const TEMPLATE: Partial<Env> = {
  SITE_NAME: "",
  MAIN_ORIGIN: "",
  FILES_ORIGIN: "",
  TMP_ORIGIN: "",
  OPERATOR_NAME: "",
  CONTACT_EMAIL: "",
  ABUSE_EMAIL: "",
  CSAM_SCANNING: "0",
  EMAIL_ROUTING: "0",
  WAF_RATE_LIMIT: "0",
  STORAGE_LOCATION: "",
  RESEND_REGION: "",
  MAIL_FROM: "",
  CACHE_ORIGIN: "",
  ZONE_ID: "",
  FEATURE_CLI: "1",
};

const get = (path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) => call(new Request(`${HOST}${path}`, init), { ...TEMPLATE, ...overrides });
const zh = { headers: { "accept-language": "zh-CN" } };

describe("template deployment", () => {
  it("never claims to be sugi.moe or names its operator", async () => {
    for (const path of ["/", "/faq", "/terms", "/privacy", "/dev", "/mine", "/nope"]) {
      for (const init of [{}, zh]) {
        const html = await (await get(path, init)).text();
        for (const needle of ["sugi.moe", "YLDM", "hi@", "abuse@", "CSAM", "Resend", "邮件转发", "email forwarding", "防火墙", "firewall"])
          expect(html, `${path} ${needle}`).not.toContain(needle);
      }
    }
    const home = await (await get("/")).text();
    expect(home).toContain("<title>my-sugi.example.workers.dev · ");
    expect(home).toContain('<span class="brand-word">my-sugi</span>');
    expect(home).toContain(`content="${HOST}${OG_IMAGES_GENERIC["home-en"]}"`);
    expect(home).not.toContain(OG_IMAGES["home-en"]);
    expect(home).not.toContain('"@type":"Organization"');
  });

  it("says who to contact once an operator is configured", async () => {
    const branded = { OPERATOR_NAME: "Example Ltd.", CONTACT_EMAIL: "help@example.org", SITE_NAME: "pics.example.org" };
    const terms = await (await get("/terms", {}, branded)).text();
    expect(terms).toContain("pics.example.org is operated by Example Ltd.");
    expect(terms).toContain('href="mailto:help@example.org"');
    const privacy = await (await get("/privacy", {}, { ...branded, STORAGE_LOCATION: "weur" })).text();
    expect(privacy).toContain("pics.example.org is operated by Example Ltd.");
    expect(privacy).toContain("help@example.org");
    expect(privacy).toContain("stored in western Europe");
    expect(privacy).not.toContain("CSAM");
  });

  it("serves uploads from paths on its own host", async () => {
    const up = async (query = "") => {
      const res = await get(`/api/upload${query}`, {
        method: "PUT",
        body: png(),
        headers: { "cf-connecting-ip": freshIp(), accept: "application/json", ...TRUSTED },
      });
      expect(res.status).toBe(201);
      return res.json<{ url: string; page: string }>();
    };
    const kept = await up();
    expect(kept.url).toMatch(new RegExp(`^${HOST}/_files/[a-z0-9]{8}\\.png$`));
    expect(kept.page.startsWith(`${HOST}/`)).toBe(true);
    expect((await call(new Request(kept.url), TEMPLATE)).status).toBe(200);
    const temp = await up("?expire=1h");
    expect(temp.url).toMatch(new RegExp(`^${HOST}/_tmp/[a-z0-9]{8}\\.png$`));
    expect((await call(new Request(temp.url), TEMPLATE)).status).toBe(200);
  });

  it("points install.sh, robots.txt and the sitemap at its own host", async () => {
    const install = await (await get("/install.sh")).text();
    expect(install).toContain(`origin="\${SUGI_URL:-${HOST}}"`);
    // After the checksum check the installer points the CLI's default server at this host.
    expect(install).toContain(
      `awk -v o="$origin" '$0 == "BASE=\\"\${SUGI_URL:-https://sugi.moe}\\"" { print "BASE=\\"\${SUGI_URL:-" o "}\\""; next } { print }'`,
    );
    expect(await (await get("/robots.txt")).text()).toContain(`${HOST}/sitemap.xml`);
    expect(await (await get("/sitemap.xml")).text()).toContain(`<loc>${HOST}/?lang=en</loc>`);
  });
});

describe("runtime migrations", () => {
  it("splits every migration into statements and is idempotent", async () => {
    const files = (env as unknown as { TEST_MIGRATIONS: { name: string }[] }).TEST_MIGRATIONS.map((m) => m.name);
    expect(MIGRATIONS.map(([n]) => n)).toEqual(files.map((n) => (n.endsWith(".sql") ? n : `${n}.sql`)));
    for (const [name, sql] of MIGRATIONS) expect(statements(sql).length, name).toBeGreaterThan(0);
    await ensureSchema(env.DB);
    await ensureSchema(env.DB);
    const { results } = await env.DB.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(MIGRATIONS.map(([n]) => n));
  });
});

describe("missing secrets", () => {
  it("tells the operator instead of failing silently", async () => {
    const home = await (await get("/", {}, { IP_HASH_SECRET: undefined })).text();
    expect(home).toContain("IP_HASH_SECRET secret is missing");
    expect(await (await get("/")).text()).not.toContain("IP_HASH_SECRET");
    const res = await get("/api/upload", { method: "PUT", body: png(), headers: { "cf-connecting-ip": freshIp(), ...TRUSTED } }, { IP_HASH_SECRET: undefined });
    expect(res.status).toBe(503);
  });
});
