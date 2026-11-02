import { describe, expect, it } from "vitest";
import { call, freshIp, MAIN, png, TRUSTED } from "./helpers";

const page = (path: string, overrides: Partial<Env> = {}) =>
  call(new Request(`${MAIN}${path}`, { headers: { accept: "text/html" } }), overrides).then((r) => r.text());

describe("integrations", () => {
  it("serves a ShareX custom uploader for this deployment", async () => {
    const res = await call(new Request(`${MAIN}/integrations/sharex.sxcu`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="sugi.moe.sxcu"');
    const cfg = await res.json<Record<string, any>>();
    expect(cfg).toMatchObject({
      Name: "sugi.moe",
      RequestMethod: "POST",
      RequestURL: "https://sugi.moe/api/upload",
      Body: "MultipartFormData",
      FileFormName: "file",
      Headers: { Accept: "application/json" },
      URL: "{json:url}",
      ErrorMessage: "{json:error}",
    });
    expect((await call(new Request(`${MAIN}/integrations/sharex.sxcu`, { method: "POST" }))).status).toBe(405);
    // A template deployment points at its own origin.
    const own = await call(new Request("https://my-sugi.example.workers.dev/integrations/sharex.sxcu"), { MAIN_ORIGIN: "", SITE_NAME: "" });
    expect((await own.json<{ RequestURL: string }>()).RequestURL).toBe("https://my-sugi.example.workers.dev/api/upload");
  });

  it("the request those tools send is answered with the url they read", async () => {
    const form = new FormData();
    form.set("file", new File([png()], "shot.png", { type: "image/png" }));
    const res = await call(
      new Request(`${MAIN}/api/upload`, { method: "POST", body: form, headers: { accept: "application/json", "cf-connecting-ip": freshIp(), ...TRUSTED } }),
    );
    expect(res.status).toBe(201);
    expect((await res.json<{ url: string }>()).url).toMatch(/^https:\/\/files\.sugi\.moe\/[a-z0-9-]+\.png$/);
  });

  it("the developer page has an Integrations tab", async () => {
    const zh = await page("/dev?lang=zh");
    expect(zh).toContain('data-tab="tools"');
    expect(zh).toContain('data-panel="dev:tools"');
    for (const name of ["ShareX", "PicGo / PicList", "uPic", "Obsidian"]) expect(zh).toContain(`<h2 class="h2 gap">${name}</h2>`);
    expect(zh).toContain('href="/integrations/sharex.sxcu"');
    // Typora goes through the CLI, so it is listed only with FEATURE_CLI.
    expect(zh).not.toContain("Typora");
    const withCli = await page("/dev?lang=en", { FEATURE_CLI: "1" });
    expect(withCli).toContain("~/.local/bin/sugi up --plain --no-copy");
  });
});

describe("FAQ on mainland China", () => {
  it("is shown only when the operator turns it on", async () => {
    expect(await page("/faq?lang=zh")).not.toContain("在中国大陆能用吗？");
    const zh = await page("/faq?lang=zh", { MAINLAND_CHINA_FAQ: "1" });
    expect(zh).toContain("在中国大陆能用吗？");
    expect(zh).toContain("没有在中国大陆做 ICP 备案");
    const en = await page("/faq?lang=en", { MAINLAND_CHINA_FAQ: "1" });
    expect(en).toContain("has no ICP filing in mainland China");
  });
});
