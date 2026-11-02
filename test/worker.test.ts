import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { MAX_BYTES } from "../src/index";

const ORIGIN = "https://sugi.test";
const UPLOAD_AUTH = { authorization: "Bearer test-upload-token" };
const ADMIN_AUTH = { authorization: "Bearer test-admin-token" };

let ipCounter = 0;
// Each test gets its own client address so the per-source rate limiter never couples tests together.
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

let contentCounter = 0;
function pngBytes(size = 64): Uint8Array {
  contentCounter += 1;
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // Unique payload per call so tests do not dedup into each other's objects.
  new DataView(bytes.buffer).setUint32(8, contentCounter);
  bytes[12] = Math.floor(Math.random() * 256);
  bytes[13] = Math.floor(Math.random() * 256);
  return bytes;
}

function call(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  return worker.fetch(request as Parameters<typeof worker.fetch>[0], { ...env, ...overrides } as Env) as Promise<Response>;
}

function putUpload(body: BodyInit, opts: { ip?: string; headers?: Record<string, string> } = {}): Request {
  return new Request(`${ORIGIN}/upload`, {
    method: "PUT",
    body,
    headers: { "cf-connecting-ip": opts.ip ?? freshIp(), ...UPLOAD_AUTH, ...opts.headers },
  });
}

function formUpload(file: Blob, opts: { ip?: string; headers?: Record<string, string>; field?: string } = {}): Request {
  const form = new FormData();
  form.append(opts.field ?? "file", file, "whatever.svg");
  return new Request(`${ORIGIN}/upload`, {
    method: "POST",
    body: form,
    headers: { "cf-connecting-ip": opts.ip ?? freshIp(), ...UPLOAD_AUTH, ...opts.headers },
  });
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("upload", () => {
  it("accepts a multipart upload, ignores the client filename/type, and returns the URL as text", async () => {
    const bytes = pngBytes();
    const res = await call(formUpload(new Blob([bytes], { type: "image/svg+xml" })));
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    const sha = await sha256Hex(bytes);
    expect(await res.text()).toBe(`${ORIGIN}/${sha.slice(0, 16)}.png\n`);
  });

  it("accepts a raw PUT body and returns JSON when asked", async () => {
    const bytes = pngBytes();
    const res = await call(putUpload(bytes, { headers: { accept: "application/json", "content-type": "text/html" } }));
    expect(res.status).toBe(201);
    const body = await res.json<{ url: string; key: string; size: number; type: string; deduplicated: boolean }>();
    const sha = await sha256Hex(bytes);
    expect(body).toEqual({ url: `${ORIGIN}/${sha.slice(0, 16)}.png`, key: `${sha.slice(0, 16)}.png`, size: bytes.length, type: "image/png", deduplicated: false });
  });

  it("accepts a raw POST body that is not multipart", async () => {
    const res = await call(new Request(`${ORIGIN}/upload`, { method: "POST", body: pngBytes(), headers: { "cf-connecting-ip": freshIp(), ...UPLOAD_AUTH } }));
    expect(res.status).toBe(201);
  });

  it("uses the extension of the detected type", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...pngBytes().slice(8)]);
    const res = await call(putUpload(jpeg));
    expect((await res.text()).trim()).toMatch(/\/[0-9a-f]{16}\.jpg$/);
  });

  it("stores the upload time, the HMAC of the client IP and the content hash, never the raw IP", async () => {
    const ip = freshIp();
    const bytes = pngBytes();
    const res = await call(putUpload(bytes, { ip }));
    const key = new URL((await res.text()).trim()).pathname.slice(1);
    const obj = await env.BUCKET.head(key);
    expect(obj).not.toBeNull();
    expect(obj!.httpMetadata?.contentType).toBe("image/png");
    const meta = obj!.customMetadata!;
    expect(meta.source).toBe(await hmacHex("test-ip-hash-secret", ip));
    expect(meta.sha256).toBe(await sha256Hex(bytes));
    expect(Date.now() - Date.parse(meta.uploaded)).toBeLessThan(60_000);
    expect(JSON.stringify(meta)).not.toContain(ip);
  });

  it.each([
    ["svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ["html", "<!doctype html><html><body>hi</body></html>"],
    ["text", "just text"],
  ])("rejects %s with 415 even when labelled as PNG", async (_name, content) => {
    const res = await call(formUpload(new Blob([content], { type: "image/png" })));
    expect(res.status).toBe(415);
    const raw = await call(putUpload(content, { headers: { "content-type": "image/png" } }));
    expect(raw.status).toBe(415);
  });

  it("rejects an empty body and a multipart body without the file field", async () => {
    expect((await call(putUpload(new Uint8Array(0)))).status).toBe(400);
    expect((await call(formUpload(new Blob([pngBytes()]), { field: "image" }))).status).toBe(400);
  });

  it("accepts exactly the size limit and rejects one byte more", async () => {
    const ok = pngBytes(MAX_BYTES);
    expect((await call(putUpload(ok))).status).toBe(201);
    const big = pngBytes(MAX_BYTES + 1);
    expect((await call(putUpload(big))).status).toBe(413);
    expect((await call(formUpload(new Blob([big])))).status).toBe(413);
  });

  it("rejects an oversized streamed body that has no Content-Length", async () => {
    const chunk = pngBytes(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_BYTES + 2 * chunk.length) return controller.close();
        sent += chunk.length;
        controller.enqueue(chunk.slice());
      },
    });
    const req = new Request(`${ORIGIN}/upload`, { method: "PUT", body: stream, headers: { "cf-connecting-ip": freshIp(), ...UPLOAD_AUTH }, duplex: "half" } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    expect((await call(req)).status).toBe(413);
  });

  it("dedups identical content to the same URL and never overwrites the stored object", async () => {
    const bytes = pngBytes();
    const firstIp = freshIp();
    const first = await call(putUpload(bytes, { ip: firstIp }));
    expect(first.status).toBe(201);
    const url = (await first.text()).trim();
    const key = new URL(url).pathname.slice(1);
    const before = await env.BUCKET.head(key);

    const second = await call(putUpload(bytes, { headers: { accept: "application/json" } }));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ url, deduplicated: true });

    const after = await env.BUCKET.head(key);
    expect(after!.etag).toBe(before!.etag);
    expect(after!.uploaded.getTime()).toBe(before!.uploaded.getTime());
    expect(after!.customMetadata).toEqual(before!.customMetadata);
    expect(after!.customMetadata!.source).toBe(await hmacHex("test-ip-hash-secret", firstIp));
  });

  it("refuses to treat a different file with a colliding key as a duplicate", async () => {
    const bytes = pngBytes();
    const key = `${(await sha256Hex(bytes)).slice(0, 16)}.png`;
    await env.BUCKET.put(key, pngBytes(), { customMetadata: { sha256: "0".repeat(64), source: "x", uploaded: "2020-01-01T00:00:00Z" } });
    expect((await call(putUpload(bytes))).status).toBe(409);
    expect((await env.BUCKET.head(key))!.customMetadata!.sha256).toBe("0".repeat(64));
  });

  it("returns 503 instead of storing untraceable uploads when IP_HASH_SECRET is missing", async () => {
    expect((await call(putUpload(pngBytes()), { IP_HASH_SECRET: undefined })).status).toBe(503);
  });

  it("rejects other methods on /upload", async () => {
    const res = await call(new Request(`${ORIGIN}/upload`));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, PUT");
  });
});

describe("upload token gate", () => {
  it("rejects anonymous and wrong-token uploads while UPLOAD_TOKEN is set", async () => {
    const anon = new Request(`${ORIGIN}/upload`, { method: "PUT", body: pngBytes(), headers: { "cf-connecting-ip": freshIp() } });
    const res = await call(anon);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect((await call(putUpload(pngBytes(), { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    expect((await call(putUpload(pngBytes(), { headers: { authorization: "Bearer test-admin-token" } }))).status).toBe(401);
    expect((await call(putUpload(pngBytes(), { headers: { authorization: "Basic dGVzdA==" } }))).status).toBe(401);
  });

  it("allows anonymous uploads when UPLOAD_TOKEN is unset", async () => {
    const anon = new Request(`${ORIGIN}/upload`, { method: "PUT", body: pngBytes(), headers: { "cf-connecting-ip": freshIp() } });
    expect((await call(anon, { UPLOAD_TOKEN: undefined })).status).toBe(201);
  });

  it("checks the token before doing any work, so unauthenticated requests do not consume the rate limit", async () => {
    const ip = freshIp();
    for (let i = 0; i < 15; i++) {
      const anon = new Request(`${ORIGIN}/upload`, { method: "PUT", body: pngBytes(), headers: { "cf-connecting-ip": ip } });
      expect((await call(anon)).status).toBe(401);
    }
    expect((await call(putUpload(pngBytes(), { ip }))).status).toBe(201);
  });

  it("the index page says whether anonymous uploads are open, in both languages", async () => {
    const zh = { headers: { "accept-language": "zh-CN,zh;q=0.9" } };
    expect(await (await call(new Request(`${ORIGIN}/`, zh))).text()).toContain("暂未开放匿名上传");
    // The 401 message stays in the script's message table either way; only the banner depends on the gate.
    expect(await (await call(new Request(`${ORIGIN}/`, zh), { UPLOAD_TOKEN: undefined })).text()).not.toContain('id="gate"');
    expect(await (await call(new Request(`${ORIGIN}/`))).text()).toContain("Anonymous uploads are not open yet");
    expect(await (await call(new Request(`${ORIGIN}/`), { UPLOAD_TOKEN: undefined })).text()).not.toContain('id="gate"');
  });
});

describe("rate limit", () => {
  it("returns 429 with Retry-After once a source exceeds 10 uploads per 60 seconds", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await call(putUpload(pngBytes(), { ip }))).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(statuses.slice(10)).toEqual([429, 429]);
    const res = await call(putUpload(pngBytes(), { ip, headers: { accept: "application/json" } }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toHaveProperty("error");
    // Another source is unaffected.
    expect((await call(putUpload(pngBytes()))).status).toBe(201);
  });
});

describe("serving", () => {
  async function uploaded(): Promise<{ key: string; bytes: Uint8Array }> {
    const bytes = pngBytes(300);
    const res = await call(putUpload(bytes));
    return { key: new URL((await res.text()).trim()).pathname.slice(1), bytes };
  }

  it("streams the stored bytes with the hardening and caching headers", async () => {
    const { key, bytes } = await uploaded();
    const res = await call(new Request(`${ORIGIN}/${key}`));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="${key}"`);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]+"$/);
    expect(res.headers.get("last-modified")).toBeTruthy();
  });

  it("supports HEAD without a body", async () => {
    const { key, bytes } = await uploaded();
    const res = await call(new Request(`${ORIGIN}/${key}`, { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.body).toBeNull();
  });

  it("answers a matching If-None-Match with 304", async () => {
    const { key } = await uploaded();
    const etag = (await call(new Request(`${ORIGIN}/${key}`, { method: "HEAD" }))).headers.get("etag")!;
    const res = await call(new Request(`${ORIGIN}/${key}`, { headers: { "if-none-match": etag } }));
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    const miss = await call(new Request(`${ORIGIN}/${key}`, { headers: { "if-none-match": '"nope"' } }));
    expect(miss.status).toBe(200);
  });

  it("returns 404 for unknown keys and malformed paths", async () => {
    for (const path of ["/0000000000000000.png", "/0000000000000000.svg", "/ABCDEF0000000000.png", "/foo", "/favicon.ico", "/admin"]) {
      expect((await call(new Request(`${ORIGIN}${path}`))).status, path).toBe(404);
    }
  });

});

describe("homepage", () => {
  const page = (init: RequestInit = {}, path = "/", overrides: Partial<Env> = {}) => call(new Request(`${ORIGIN}${path}`, init), overrides);
  const nonceOf = (res: Response) => /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1];

  it("has a nonce-based CSP that allows only its own inline script and style", async () => {
    const res = await page();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy")!;
    const nonce = nonceOf(res)!;
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(csp).toBe(`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toBe("Accept-Language");
    const html = await res.text();
    // Every executable script and every style element carries the nonce; the only other script is a JSON data block.
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    expect(scripts).toEqual([' type="application/json" id="i18n"', ` nonce="${nonce}"`]);
    expect([...html.matchAll(/<style\b([^>]*)>/g)].map((m) => m[1])).toEqual([` nonce="${nonce}"`]);
    // Inline handlers and style attributes would be blocked by the CSP, so the page must not rely on them.
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/<link\b|\ssrc=["']?https?:/i);
  });

  it("uses a fresh nonce per response", async () => {
    expect(nonceOf(await page())).not.toBe(nonceOf(await page()));
  });

  it("keeps the strict CSP on image responses", async () => {
    const res = await call(putUpload(pngBytes()));
    const key = new URL((await res.text()).trim()).pathname;
    expect((await page({}, key)).headers.get("content-security-policy")).toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  });

  it("defaults to English and picks Chinese from Accept-Language", async () => {
    const en = await page();
    expect(en.headers.get("content-language")).toBe("en");
    const enHtml = await en.text();
    expect(enHtml).toContain('<html lang="en">');
    expect(enHtml).toContain('href="/?lang=zh"');
    expect((await page({ headers: { "accept-language": "fr-FR,fr;q=0.9" } })).headers.get("content-language")).toBe("en");
    expect((await page({ headers: { "accept-language": "ja,en;q=0.8,zh;q=0.5" } })).headers.get("content-language")).toBe("en");

    const zh = await page({ headers: { "accept-language": "zh-TW,zh;q=0.9,en;q=0.8" } });
    expect(zh.headers.get("content-language")).toBe("zh-CN");
    const zhHtml = await zh.text();
    expect(zhHtml).toContain('<html lang="zh-CN">');
    expect(zhHtml).toContain('href="/?lang=en"');
  });

  it("lets ?lang= override Accept-Language", async () => {
    expect((await page({ headers: { "accept-language": "zh-CN" } }, "/?lang=en")).headers.get("content-language")).toBe("en");
    expect((await page({}, "/?lang=zh")).headers.get("content-language")).toBe("zh-CN");
    expect((await page({}, "/?lang=xx")).headers.get("content-language")).toBe("en");
  });

  it.each([
    ["en", "/?lang=en", ["public", "permanent", "personal information", "PNG, JPEG, WebP and GIF", "20 MB", "10 files per 60 seconds", "abuse@sugi.moe", "Drop images here"]],
    ["zh", "/?lang=zh", ["公开", "永久", "个人信息", "PNG、JPEG、WebP、GIF", "20 MB", "每 60 秒最多 10 次上传", "abuse@sugi.moe", "把图片拖到这里"]],
  ])("renders the %s page with the upload UI and all notices", async (_lang, path, needles) => {
    const html = await (await page({}, path)).text();
    for (const n of needles) expect(html, n).toContain(n);
    expect(html).toContain('id="drop"');
    expect(html).toContain('<input type="file" id="file" multiple');
    expect(html).toContain(`curl -F file=@image.png ${ORIGIN}/upload`);
    expect(html).not.toMatch(/msime|水杉|screenshot|截图/i);
  });

  it("embeds the browser messages as inert JSON that cannot break out of its script element", async () => {
    const html = await (await page({}, "/?lang=zh")).text();
    const json = /<script type="application\/json" id="i18n">([^<]*)<\/script>/.exec(html)![1];
    const msgs = JSON.parse(json);
    expect(msgs).toMatchObject({ gated: "暂未开放匿名上传。", maxBytes: MAX_BYTES });
    expect(msgs.rateLimited).toContain("{s}");
  });

  it("answers HEAD without a body", async () => {
    const res = await page({ method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});

describe("admin", () => {
  async function uploadFrom(ip: string): Promise<string> {
    const res = await call(putUpload(pngBytes(), { ip }));
    expect(res.status).toBe(201);
    return new URL((await res.text()).trim()).pathname.slice(1);
  }

  it("DELETE requires the admin token", async () => {
    const key = await uploadFrom(freshIp());
    expect((await call(new Request(`${ORIGIN}/${key}`, { method: "DELETE" }))).status).toBe(401);
    expect((await call(new Request(`${ORIGIN}/${key}`, { method: "DELETE", headers: UPLOAD_AUTH }))).status).toBe(401);
    expect((await call(new Request(`${ORIGIN}/${key}`, { method: "DELETE", headers: { authorization: "Bearer test-admin-tokenX" } }))).status).toBe(401);
    expect(await env.BUCKET.head(key)).not.toBeNull();

    const ok = await call(new Request(`${ORIGIN}/${key}`, { method: "DELETE", headers: ADMIN_AUTH }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deleted: [key], cache_purged: true });
    expect(await env.BUCKET.head(key)).toBeNull();
    expect((await call(new Request(`${ORIGIN}/${key}`))).status).toBe(404);
    expect((await call(new Request(`${ORIGIN}/${key}`, { method: "DELETE", headers: ADMIN_AUTH }))).status).toBe(404);
  });

  it("admin endpoints are disabled when ADMIN_TOKEN is unset", async () => {
    const key = await uploadFrom(freshIp());
    const res = await call(new Request(`${ORIGIN}/${key}`, { method: "DELETE", headers: ADMIN_AUTH }), { ADMIN_TOKEN: undefined });
    expect(res.status).toBe(403);
    expect(await env.BUCKET.head(key)).not.toBeNull();
  });

  it("info returns the stored source hash for a key", async () => {
    const ip = freshIp();
    const key = await uploadFrom(ip);
    expect((await call(new Request(`${ORIGIN}/admin/info/${key}`))).status).toBe(401);
    const res = await call(new Request(`${ORIGIN}/admin/info/${key}`, { headers: ADMIN_AUTH }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ key, type: "image/png", source: await hmacHex("test-ip-hash-secret", ip) });
  });

  it("purge-by-source requires auth, supports dry runs, and deletes only that source's objects", async () => {
    const badIp = freshIp();
    const goodIp = freshIp();
    const bad = [await uploadFrom(badIp), await uploadFrom(badIp), await uploadFrom(badIp)];
    const good = await uploadFrom(goodIp);
    const source = await hmacHex("test-ip-hash-secret", badIp);
    const purge = (body: unknown, headers: Record<string, string> = ADMIN_AUTH) =>
      call(new Request(`${ORIGIN}/admin/purge-by-source`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }));

    expect((await purge({ source }, {})).status).toBe(401);
    expect((await purge({ source }, UPLOAD_AUTH)).status).toBe(401);
    expect((await purge({ source: "not-hex" })).status).toBe(400);
    expect((await call(new Request(`${ORIGIN}/admin/purge-by-source`, { method: "POST", body: "{", headers: ADMIN_AUTH }))).status).toBe(400);

    const dry = await purge({ source, dry_run: true });
    const dryBody = await dry.json<{ count: number; matched: string[] }>();
    expect(dryBody.count).toBe(3);
    expect(dryBody.matched.sort()).toEqual([...bad].sort());
    for (const key of bad) expect(await env.BUCKET.head(key)).not.toBeNull();

    const real = await purge({ source: source.toUpperCase() });
    expect(real.status).toBe(200);
    const realBody = await real.json<{ count: number; deleted: string[] }>();
    expect(realBody.deleted.sort()).toEqual([...bad].sort());
    for (const key of bad) expect(await env.BUCKET.head(key)).toBeNull();
    expect(await env.BUCKET.head(good)).not.toBeNull();
  });
});

describe("trusted token", () => {
  const TRUSTED_AUTH = { authorization: "Bearer test-trusted-token" };

  it("bypasses the rate limiter", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await call(putUpload(pngBytes(), { ip, headers: TRUSTED_AUTH }))).status);
    expect(statuses).toEqual(Array(25).fill(201));
    // The same source without the trusted token is still limited: the trusted uploads did not count, so it gets exactly 10.
    const untrusted: number[] = [];
    for (let i = 0; i < 11; i++) untrusted.push((await call(putUpload(pngBytes(), { ip }))).status);
    expect(untrusted).toEqual([...Array(10).fill(201), 429]);
    expect((await call(putUpload(pngBytes(), { ip, headers: TRUSTED_AUTH }))).status).toBe(201);
  });

  it("a wrong or near-miss token does not bypass the limiter or the gate", async () => {
    const ip = freshIp();
    for (const authorization of ["Bearer test-trusted-tokenX", "Bearer test-trusted-toke", "Bearer TEST-TRUSTED-TOKEN", "test-trusted-token"]) {
      expect((await call(putUpload(pngBytes(), { ip, headers: { authorization } }))).status, authorization).toBe(401);
    }
    // With the gate off, a wrong trusted token is just an anonymous upload and is rate limited normally.
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await call(putUpload(pngBytes(), { ip, headers: { authorization: "Bearer test-trusted-tokenX" } }), { UPLOAD_TOKEN: undefined })).status);
    expect(statuses).toEqual([...Array(10).fill(201), 429]);
  });

  it("passes the upload gate", async () => {
    const res = await call(putUpload(pngBytes(), { headers: TRUSTED_AUTH }));
    expect(res.status).toBe(201);
  });

  it("is not an admin token", async () => {
    const res = await call(putUpload(pngBytes(), { headers: TRUSTED_AUTH }));
    const url = (await res.text()).trim();
    expect((await call(new Request(url.replace("https://sugi.test", ORIGIN), { method: "DELETE", headers: TRUSTED_AUTH }))).status).toBe(401);
  });

  it("does nothing when TRUSTED_TOKEN is unset", async () => {
    expect((await call(putUpload(pngBytes(), { headers: TRUSTED_AUTH }), { TRUSTED_TOKEN: undefined })).status).toBe(401);
  });
});

describe("cache-through serving and cache purge", () => {
  const CACHE = { CACHE_ORIGIN: "https://r2.sugi.test", ZONE_ID: "zone123", CF_PURGE_TOKEN: "test-purge-token" };
  const TRUSTED_AUTH = { authorization: "Bearer test-trusted-token" };

  type Call = { url: string; init?: RequestInit & { cf?: Record<string, unknown> } };
  // Stands in for the R2 custom domain (served from the bucket binding) and the zone purge API.
  function stubFetch(opts: { originStatus?: number; purgeOk?: boolean } = {}): Call[] {
    const calls: Call[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init: init as Call["init"] });
      if (url.startsWith(CACHE.CACHE_ORIGIN)) {
        if (opts.originStatus) return new Response("blocked", { status: opts.originStatus });
        const obj = await env.BUCKET.get(new URL(url).pathname.slice(1));
        return obj ? new Response(obj.body, { headers: { "content-type": "application/octet-stream" } }) : new Response("nope", { status: 404 });
      }
      if (url.startsWith("https://api.cloudflare.com/")) {
        return opts.purgeOk === false ? Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 }) : Response.json({ success: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    return calls;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function upload(bytes = pngBytes(500), ip = freshIp()): Promise<string> {
    const res = await call(putUpload(bytes, { ip, headers: TRUSTED_AUTH }));
    expect(res.status).toBe(201);
    return new URL((await res.text()).trim()).pathname.slice(1);
  }

  it("GET goes through the cache origin with cacheEverything and keeps sugi's own headers", async () => {
    const bytes = pngBytes(500);
    const key = await upload(bytes);
    const calls = stubFetch();
    const res = await call(new Request(`${ORIGIN}/${key}`), CACHE);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${CACHE.CACHE_ORIGIN}/${key}`);
    expect(calls[0].init?.cf).toMatchObject({ cacheEverything: true });
  });

  it("HEAD, 304 and unknown keys never touch the cache origin", async () => {
    const key = await upload();
    const calls = stubFetch();
    const head = await call(new Request(`${ORIGIN}/${key}`, { method: "HEAD" }), CACHE);
    expect(head.status).toBe(200);
    expect((await call(new Request(`${ORIGIN}/${key}`, { headers: { "if-none-match": head.headers.get("etag")! } }), CACHE)).status).toBe(304);
    expect((await call(new Request(`${ORIGIN}/0123456789abcdef.png`), CACHE)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("a deleted object is not served even if the cache still had it", async () => {
    const key = await upload();
    await env.BUCKET.delete(key);
    const calls = stubFetch();
    expect((await call(new Request(`${ORIGIN}/${key}`), CACHE)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("passes through a block from the cache layer instead of falling back to the bucket", async () => {
    const key = await upload();
    stubFetch({ originStatus: 451 });
    const res = await call(new Request(`${ORIGIN}/${key}`), CACHE);
    expect(res.status).toBe(451);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
  });

  it("DELETE purges the cached origin URL from the zone cache", async () => {
    const key = await upload();
    const calls = stubFetch();
    const res = await call(new Request(`${ORIGIN}/${key}`, { method: "DELETE", headers: ADMIN_AUTH }), CACHE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: [key], cache_purged: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/zones/zone123/purge_cache");
    expect(calls[0].init?.method).toBe("POST");
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Bearer test-purge-token");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ files: [`${CACHE.CACHE_ORIGIN}/${key}`] });
  });

  it("reports 502 when the purge fails, and a retried DELETE purges again", async () => {
    const key = await upload();
    stubFetch({ purgeOk: false });
    const res = await call(new Request(`${ORIGIN}/${key}`, { method: "DELETE", headers: ADMIN_AUTH }), CACHE);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ deleted: [key], cache_purged: false });
    expect(await env.BUCKET.head(key)).toBeNull();

    vi.restoreAllMocks();
    const calls = stubFetch();
    const retry = await call(new Request(`${ORIGIN}/${key}`, { method: "DELETE", headers: ADMIN_AUTH }), CACHE);
    expect(retry.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("reports 502 when cache-through is on but no purge token is configured", async () => {
    const key = await upload();
    stubFetch();
    const res = await call(new Request(`${ORIGIN}/${key}`, { method: "DELETE", headers: ADMIN_AUTH }), { ...CACHE, CF_PURGE_TOKEN: undefined });
    expect(res.status).toBe(502);
  });

  it("purge-by-source purges every deleted URL, 30 per request", async () => {
    const ip = freshIp();
    const keys: string[] = [];
    for (let i = 0; i < 31; i++) keys.push(await upload(pngBytes(), ip));
    const source = await hmacHex("test-ip-hash-secret", ip);
    const calls = stubFetch();
    const res = await call(
      new Request(`${ORIGIN}/admin/purge-by-source`, { method: "POST", body: JSON.stringify({ source }), headers: { "content-type": "application/json", ...ADMIN_AUTH } }),
      CACHE,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ count: 31, cache_purged: true });
    expect(calls).toHaveLength(2);
    const purged = calls.flatMap((c) => JSON.parse(String(c.init?.body)).files as string[]);
    expect(purged.sort()).toEqual(keys.map((k) => `${CACHE.CACHE_ORIGIN}/${k}`).sort());
    expect(JSON.parse(String(calls[0].init?.body)).files).toHaveLength(30);
  });

  it("without CACHE_ORIGIN nothing is fetched and deletes do not call the purge API", async () => {
    const key = await upload();
    const calls = stubFetch();
    expect((await call(new Request(`${ORIGIN}/${key}`))).status).toBe(200);
    expect((await call(new Request(`${ORIGIN}/${key}`, { method: "DELETE", headers: ADMIN_AUTH }))).status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});
