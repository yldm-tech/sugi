import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSession } from "../src/auth/core";
import { call, freshIp, MAIN, mp4, png, TRUSTED, UPLOAD_AUTH } from "./helpers";

// Accounts on, no upload gate: the shape of sugi.moe.
const ACCOUNTS: Partial<Env> = { FEATURE_ACCOUNTS: "1", ACCOUNT_FEATURES: "email", UPLOAD_TOKEN: "" };
const ORIGIN = { origin: "https://sugi.moe" };

const put = (body: Uint8Array, headers: Record<string, string>, overrides: Partial<Env> = ACCOUNTS) =>
  call(
    new Request(`${MAIN}/api/upload`, { method: "PUT", body, headers: { "cf-connecting-ip": freshIp(), accept: "application/json", ...headers } }),
    overrides,
  );

async function session(): Promise<string> {
  const id = `u${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, NULL, ?)").bind(id, `${id}@example.org`, Date.now()).run();
  // createSession returns the Set-Cookie value; a request sends back only name=value.
  return (await createSession(env, id, "email")).split(";")[0];
}

describe("who may upload videos (VIDEO_UPLOADS)", () => {
  it("defaults to accounts: anonymous videos get 403, images and logged-in videos go through", async () => {
    const anon = await put(mp4(), {});
    expect(anon.status).toBe(403);
    expect((await anon.json<{ error: string }>()).error).toMatch(/^video uploads need an account: log in at https:\/\/sugi\.moe\/login/);
    expect((await put(png(), {})).status).toBe(201);
    expect((await put(mp4(), { cookie: await session(), ...ORIGIN })).status).toBe(201);
    expect((await put(mp4(), TRUSTED)).status).toBe(201);
  });

  it("with accounts off, only the trusted and admin tokens may upload videos", async () => {
    const res = await put(mp4(), UPLOAD_AUTH, {});
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toBe("video uploads are limited to this site's maintainers");
    expect((await put(png(), UPLOAD_AUTH, {})).status).toBe(201);
    expect((await put(mp4(), TRUSTED, {})).status).toBe(201);
  });

  it('"anyone" lets anonymous visitors upload videos', async () => {
    expect((await put(mp4(), {}, { ...ACCOUNTS, VIDEO_UPLOADS: "anyone" })).status).toBe(201);
  });

  it("applies to chunked uploads and link imports", async () => {
    const chunk = await call(
      new Request(`${MAIN}/api/uploads?size=300`, { method: "POST", body: mp4(300), headers: { "cf-connecting-ip": freshIp(), accept: "application/json" } }),
      ACCOUNTS,
    );
    expect(chunk.status).toBe(403);
    const form = new FormData();
    form.set("file", new File([mp4()], "clip.mp4", { type: "video/mp4" }));
    const multipart = await call(
      new Request(`${MAIN}/api/upload`, { method: "POST", body: form, headers: { "cf-connecting-ip": freshIp(), accept: "application/json" } }),
      ACCOUNTS,
    );
    expect(multipart.status).toBe(403);
  });

  it("upload links carry who asked for them", async () => {
    const mcp = async (headers: Record<string, string>) => {
      const res = await call(
        new Request(`${MAIN}/mcp`, {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_upload", arguments: { count: 1 } } }),
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
            "cf-connecting-ip": freshIp(),
            ...headers,
          },
        }),
        { ...ACCOUNTS, FEATURE_CLI: "1" },
      );
      const data = JSON.parse((await res.json<any>()).result.content[0].text);
      return data.links[0].upload_url as string;
    };
    const send = async (link: string) =>
      call(new Request(link.replace("https://sugi.moe", MAIN), { method: "PUT", body: mp4(), headers: { "cf-connecting-ip": freshIp() } }), {
        ...ACCOUNTS,
        FEATURE_CLI: "1",
      });
    expect((await send(await mcp({}))).status).toBe(403);
    expect((await send(await mcp(TRUSTED))).status).toBe(201);
  });

  it("the pages say so", async () => {
    const page = (path: string, headers: Record<string, string> = {}) =>
      call(new Request(`${MAIN}${path}`, { headers: { accept: "text/html", ...headers } }), ACCOUNTS).then((r) => r.text());
    expect(await page("/?lang=zh")).toContain('视频要先 <a href="/login" data-nav>登录</a> 才能上传。');
    expect(await page("/?lang=zh", { cookie: await session() })).not.toContain(`视频要先 <a href="/login"`);
    expect(await page("/faq?lang=en")).toContain("Cloudflare's CSAM Scanning Tool checks images but not videos, so videos need an account");
    expect(await page("/terms?lang=zh")).toContain("视频要先登录（或者用 API 令牌）才能上传");
    expect(await page("/faq?lang=zh")).toContain("传图片是这样；Cloudflare 的 CSAM 扫描工具只检测图片");
    expect(await page("/?lang=en", {})).toContain('"video":"account"');
    expect(
      await call(new Request(`${MAIN}/?lang=en`, { headers: { accept: "text/html" } }), { ...ACCOUNTS, VIDEO_UPLOADS: "anyone" }).then((r) => r.text()),
    ).not.toContain("Videos need you to");
  });
});
