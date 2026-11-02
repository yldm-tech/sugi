import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASSETS } from "../src/generated/assets";
import { call, freshIp, MAIN, png, TRUSTED, upload, UPLOAD_AUTH } from "./helpers";

const CLI_ON = { FEATURE_CLI: "1" };

afterEach(() => {
  vi.restoreAllMocks();
});

let rpcId = 0;
async function rpc(method: string, params: unknown, headers: Record<string, string> = TRUSTED, overrides: Partial<Env> = CLI_ON): Promise<{ status: number; body: any }> {
  const res = await call(
    new Request(`${MAIN}/mcp`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", "cf-connecting-ip": freshIp(), ...headers },
    }),
    overrides,
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function tool(name: string, args: Record<string, unknown>, headers: Record<string, string> = TRUSTED): Promise<{ isError?: boolean; data: any; text: string }> {
  const r = await rpc("tools/call", { name, arguments: args }, headers);
  expect(r.status).toBe(200);
  const result = r.body.result;
  const text = result.content[0].text as string;
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { isError: result.isError, data, text };
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

describe("/mcp", () => {
  it("is off unless FEATURE_CLI is on", async () => {
    expect((await rpc("tools/list", {}, TRUSTED, {})).status).toBe(404);
  });

  it("initializes and lists the tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo).toMatchObject({ name: "sugi" });
    const list = await rpc("tools/list", {});
    expect(list.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["create_album", "create_upload", "delete_file", "get_file", "upload_file", "upload_url"]);
    const how = init.body.result.instructions as string;
    for (const needle of ["sugi up", "/install.sh", "create_upload", "upload_url", "no SVG", "fonts"]) expect(how, needle).toContain(needle);
  });

  it("upload_file stores base64 data and delete_file removes it with the returned token", async () => {
    const bytes = png(400);
    const up = await tool("upload_file", { data: `data:image/png;base64,${b64(bytes)}`, filename: "mcp.png", expire: "1h", style: "cute" });
    expect(up.isError).toBeFalsy();
    expect(up.data).toMatchObject({ name: "mcp.png", type: "image/png", size: 400 });
    expect(up.data.url).toMatch(/^https:\/\/tmp\.sugi\.moe\/[a-z]+-[a-z]+-\d\d\.png$/);
    const served = await call(new Request(up.data.url));
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);

    const info = await tool("get_file", { id: up.data.url });
    expect(info.data).toMatchObject({ id: up.data.id, name: "mcp.png" });

    const wrong = await tool("delete_file", { id: up.data.id, delete_token: "d_nope" });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("403");
    const del = await tool("delete_file", { id: up.data.id, delete_token: up.data.delete_token });
    expect(del.data).toMatchObject({ deleted: up.data.id });
    expect((await call(new Request(up.data.url))).status).toBe(404);
  });

  it("rejects non-images and oversized data as tool errors", async () => {
    const svg = await tool("upload_file", { data: btoa("<svg xmlns='http://www.w3.org/2000/svg'/>") });
    expect(svg.isError).toBe(true);
    expect(svg.text).toContain("415");
    const big = await tool("upload_file", { data: "A".repeat(27 * 1024 * 1024) });
    expect(big.isError).toBe(true);
    expect(big.text).toContain("413");
    const bad = await tool("upload_file", { data: "!!!not base64!!!" });
    expect(bad.isError).toBe(true);
    // Anything beyond the envelope allowance is refused before parsing.
    expect((await rpc("tools/call", { name: "upload_file", arguments: { data: "A".repeat(29 * 1024 * 1024) } })).status).toBe(413);
  });

  it("upload_url imports a link and create_album bundles files", async () => {
    const bytes = png(300);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(bytes, { headers: { "content-length": "300" } }));
    const imp = await tool("upload_url", { url: "https://example.com/x/cat.png" });
    expect(imp.data).toMatchObject({ name: "cat.png", size: 300 });
    vi.restoreAllMocks();
    const other = await upload(png());
    const album = await tool("create_album", { files: [imp.data.id, other.url], title: "MCP 合集" });
    expect(album.data).toMatchObject({ title: "MCP 合集", files: 2 });
    expect(album.data.url).toMatch(/^https:\/\/sugi\.moe\/a\/[a-z0-9]{8}$/);
    const res = await call(new Request(`${MAIN}/api/albums/${album.data.id}`));
    expect((await res.json<{ files: unknown[] }>()).files).toHaveLength(2);
  });

  it("applies the upload gate and rate limit per call", async () => {
    const anon = await tool("upload_file", { data: b64(png()) }, {});
    expect(anon.isError).toBe(true);
    expect(anon.text).toContain("401");
    const ok = await tool("upload_file", { data: b64(png()) }, UPLOAD_AUTH);
    expect(ok.isError).toBeFalsy();
  });

  it("create_upload hands out one-time links that curl can upload local files to", async () => {
    const made = await tool("create_upload", { count: 3, expire: "1h" });
    expect(made.isError).toBeFalsy();
    const links = made.data.links as { id: string; upload_url: string }[];
    expect(links).toHaveLength(3);
    expect(new Set(links.map((l) => l.id)).size).toBe(3);
    expect(made.data.commands[0]).toBe(`curl -sS -T <path> '${links[0].upload_url}'`);
    for (const l of links) expect(l.upload_url).toMatch(/^https:\/\/sugi\.moe\/api\/upload\/[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    const local = (u: string) => u.replace("https://sugi.moe", MAIN);

    // Raw PUT, like curl -T.
    const bytes = png(500);
    const put = await call(new Request(local(links[0].upload_url) + "?name=shot.png", { method: "PUT", body: bytes }));
    expect(put.status).toBe(201);
    const up = await put.json<{ id: string; url: string; name: string; delete_token: string; expires_at: string }>();
    expect(up).toMatchObject({ id: links[0].id, name: "shot.png" });
    expect(up.url).toBe(`https://tmp.sugi.moe/${links[0].id}.png`);
    expect(up.expires_at).not.toBeNull();
    expect(new Uint8Array(await (await call(new Request(up.url))).arrayBuffer())).toEqual(bytes);
    // Each link works once.
    expect((await call(new Request(local(links[0].upload_url), { method: "PUT", body: png() }))).status).toBe(409);

    // Multipart, like curl -F file=@path, keeps the file name.
    const form = new FormData();
    form.append("file", new File([png(300)], "from-disk.png", { type: "image/png" }));
    const post = await call(new Request(local(links[1].upload_url), { method: "POST", body: form }));
    expect(post.status).toBe(201);
    expect(await post.json()).toMatchObject({ id: links[1].id, name: "from-disk.png", size: 300 });

    // The same type checks as every upload.
    expect((await call(new Request(local(links[2].upload_url), { method: "PUT", body: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>") }))).status).toBe(415);
    const tampered = links[2].upload_url.replace(/\.([0-9a-f])/, (_, c: string) => `.${c === "0" ? "1" : "0"}`);
    expect((await call(new Request(local(tampered), { method: "PUT", body: png() }))).status).toBe(404);

    const del = await tool("delete_file", { id: up.id, delete_token: up.delete_token });
    expect(del.data).toMatchObject({ deleted: up.id });
  });

  it("upload links expire and anonymous callers cannot reserve more than the rate limit", async () => {
    const made = await tool("create_upload", { filename: "named.png" });
    const link = (made.data.links[0].upload_url as string).replace("https://sugi.moe", MAIN);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60 * 1000);
    expect((await call(new Request(link, { method: "PUT", body: png() }))).status).toBe(410);
    vi.restoreAllMocks();
    const ok = await call(new Request(link, { method: "PUT", body: png() }));
    expect(await ok.json()).toMatchObject({ name: "named.png", expires_at: null });

    const tooMany = await tool("create_upload", { count: 11 }, UPLOAD_AUTH);
    expect(tooMany.isError).toBe(true);
    expect(tooMany.text).toContain("429");
    const trusted = await tool("create_upload", { count: 50 });
    expect(trusted.data.links).toHaveLength(50);
    expect((await tool("create_upload", { count: 51 })).isError).toBe(true);
  });

  it("answers GET with 405 since it is stateless", async () => {
    const res = await call(new Request(`${MAIN}/mcp`), CLI_ON);
    expect(res.status).toBe(405);
  });
});

describe("CLI distribution", () => {
  it("serves install.sh pinned to the CLI's SHA-256", async () => {
    expect((await call(new Request(`${MAIN}/install.sh`))).status).toBe(404);
    const res = await call(new Request(`${MAIN}/install.sh`), CLI_ON);
    expect(res.status).toBe(200);
    const script = await res.text();
    expect(script.startsWith("#!/bin/sh")).toBe(true);
    expect(script).toContain(`expected="${ASSETS.cliSha256}"`);
    expect(script).toContain(`origin="\${SUGI_URL:-https://sugi.moe}"`);
    const cli = await call(new Request(`${MAIN}${ASSETS.cli}`));
    expect(cli.status).toBe(200);
    expect(cli.headers.get("cache-control")).toBe("no-cache");
    const body = new Uint8Array(await cli.arrayBuffer());
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(digest).toBe(ASSETS.cliSha256);
  });

  it("the developer page shows the CLI and MCP tabs only with the flag", async () => {
    const off = await (await call(new Request(`${MAIN}/dev`))).text();
    expect(off).not.toContain("install.sh");
    expect(off).not.toContain('data-panel="dev:mcp"');
    const on = await (await call(new Request(`${MAIN}/dev`, { headers: { "accept-language": "zh-CN" } }), CLI_ON)).text();
    for (const needle of ["curl -fsSL https://sugi.moe/install.sh | sh", "sugi up -e 1h secret.jpg", "sugi up --clipboard", "claude mcp add --transport http sugi https://sugi.moe/mcp", "mcp-remote", "~/.cursor/mcp.json", "upload_file", "delete_file", "history.jsonl"]) expect(on, needle).toContain(needle);
    expect(on).not.toContain("sugi login");
    expect(await (await call(new Request(`${MAIN}/dev`), { ...CLI_ON, FEATURE_ACCOUNTS: "1" })).text()).toContain("sugi login");
    const home = await (await call(new Request(`${MAIN}/`, { headers: { "accept-language": "zh-CN" } }), CLI_ON)).text();
    expect(home).toContain("sugi up cat.png");
    expect(home).toContain("在终端里、让 AI 帮你传");
  });
});

void env;
