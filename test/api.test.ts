import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepExpired } from "../src/files";
import worker from "../src/index";
import { ADMIN, avif, call, FILES, freshIp, hmacHex, jpeg, MAIN, mp4, png, put, TMP, TRUSTED, upload, UPLOAD_AUTH, webm } from "./helpers";

const MiB = 1024 * 1024;
const RANDOM_URL = /^https:\/\/files\.sugi\.moe\/[a-z0-9]{8}\.png$/;

afterEach(() => {
  vi.restoreAllMocks();
});

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("PUT /api/upload", () => {
  it("stores the raw body under f/<id> and returns the files.sugi.moe link as text", async () => {
    const bytes = png(300);
    const ip = freshIp();
    const res = await call(new Request(`${MAIN}/api/upload`, { method: "PUT", body: bytes, headers: { "cf-connecting-ip": ip, ...TRUSTED } }));
    expect(res.status).toBe(201);
    const url = (await res.text()).trim();
    expect(url).toMatch(RANDOM_URL);
    const id = url.split("/").pop()!.split(".")[0];
    const obj = await env.BUCKET.get(`f/${id}`);
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(bytes);
    expect(obj!.httpMetadata?.contentType).toBe("image/png");
    const m = obj!.customMetadata!;
    expect(m.source).toBe(await hmacHex("test-ip-hash-secret", ip));
    expect(m.ext).toBe("png");
    expect(m.expires).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain(ip);
  });

  it("returns JSON with a delete token whose hash, not the token, is stored", async () => {
    const r = await upload(png(), "?name=%E7%8C%AB.png");
    expect(r).toMatchObject({ url: expect.stringMatching(RANDOM_URL), page: `https://sugi.moe/f/${r.id}`, type: "image/png", name: "猫.png", expires_at: null });
    expect(r.delete_token).toMatch(/^d_[A-Za-z0-9_-]{32}$/);
    const obj = await env.BUCKET.head(`f/${r.id}`);
    expect(obj!.customMetadata!.del).toBe(await sha256Hex(r.delete_token));
    expect(JSON.stringify(obj!.customMetadata)).not.toContain(r.delete_token);
  });

  it("makes cute word ids on request and random ids by default", async () => {
    expect((await upload(png(), "?style=cute")).id).toMatch(/^[a-z]+-[a-z]+-[1-9][0-9]$/);
    expect((await upload(png())).id).toMatch(/^[a-z0-9]{8}$/);
    expect((await call(put("/api/upload?style=fancy", png()))).status).toBe(400);
  });

  it("puts expiring uploads under t/ and on tmp.sugi.moe", async () => {
    const before = Date.now();
    const r = await upload(png(), "?expire=1h");
    expect(r.url).toMatch(/^https:\/\/tmp\.sugi\.moe\/[a-z0-9]{8}\.png$/);
    const exp = Date.parse(r.expires_at!);
    expect(exp - before).toBeGreaterThanOrEqual(3600e3 - 1000);
    expect(exp - before).toBeLessThan(3600e3 + 5000);
    expect(await env.BUCKET.head(`t/${r.id}`)).not.toBeNull();
    expect(await env.BUCKET.head(`f/${r.id}`)).toBeNull();
    for (const e of ["12h", "72h", "3d"]) expect((await upload(png(), `?expire=${e}`)).expires_at).not.toBeNull();
    expect((await call(put("/api/upload?expire=5y", png()))).status).toBe(400);
  });

  it.each([
    ["jpeg", jpeg, "jpg", "image/jpeg"],
    ["avif", avif, "avif", "image/avif"],
    ["mp4", mp4, "mp4", "video/mp4"],
    ["webm", webm, "webm", "video/webm"],
  ])("accepts %s by its magic bytes", async (_n, make, ext, mime) => {
    const r = await upload(make(), "", { "content-type": "text/plain" });
    expect(r.url.endsWith(`.${ext}`)).toBe(true);
    expect(r.type).toBe(mime);
  });

  it.each([
    ["svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ["html", "<!doctype html><p>hi</p>"],
    ["pdf", "%PDF-1.7 ..."],
  ])("rejects %s with 415 and stores nothing", async (_n, content) => {
    const before = (await env.BUCKET.list({ prefix: "f/" })).objects.length;
    const res = await call(put("/api/upload", content, { "content-type": "image/png" }));
    expect(res.status).toBe(415);
    expect((await env.BUCKET.list({ prefix: "f/" })).objects.length).toBe(before);
  });

  it("rejects an empty body and a body without Content-Length", async () => {
    expect((await call(put("/api/upload", new Uint8Array(0)))).status).toBe(400);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(png());
        c.close();
      },
    });
    const req = new Request(`${MAIN}/api/upload`, { method: "PUT", body: stream, headers: { "cf-connecting-ip": freshIp(), ...TRUSTED, "x-test-raw": "1" }, duplex: "half" } as RequestInit);
    expect((await call(req)).status).toBe(411);
  });

  it("refuses single requests over 90 MB and points to the chunked API", async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(png());
        c.close();
      },
    });
    const req = new Request(`${MAIN}/api/upload`, { method: "PUT", body, headers: { "cf-connecting-ip": freshIp(), ...TRUSTED, "content-length": String(91 * MiB), "x-test-raw": "1" }, duplex: "half" } as RequestInit);
    const res = await call(req);
    expect(res.status).toBe(413);
    expect(await res.text()).toContain("chunked");
  });
});

describe("POST /api/upload (multipart)", () => {
  function form(fields: Record<string, string | Blob>, filename = "cat.png"): Request {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v instanceof Blob) fd.append(k, v, filename);
      else fd.append(k, v);
    }
    return new Request(`${MAIN}/api/upload`, { method: "POST", body: fd, headers: { "cf-connecting-ip": freshIp(), ...TRUSTED, accept: "application/json" } });
  }

  it("takes file plus expire and uses the multipart filename as the name", async () => {
    const res = await call(form({ file: new Blob([png()], { type: "image/svg+xml" }), expire: "12h" }, "shot.png"));
    expect(res.status).toBe(201);
    const r = await res.json<{ url: string; name: string; expires_at: string }>();
    expect(r.url).toMatch(/^https:\/\/tmp\.sugi\.moe\//);
    expect(r.name).toBe("shot.png");
  });

  it("prefers an explicit name field and strips paths and control characters", async () => {
    const r = await (await call(form({ file: new Blob([png()]), name: "../../etc/pa\u0000ss‮.png" }))).json<{ name: string }>();
    expect(r.name).toBe("pass.png");
  });

  it("answers plain text by default", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([png()]), "a.png");
    const res = await call(new Request(`${MAIN}/api/upload`, { method: "POST", body: fd, headers: { "cf-connecting-ip": freshIp(), ...TRUSTED } }));
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect((await res.text()).trim()).toMatch(RANDOM_URL);
  });

  it("validates the form", async () => {
    expect((await call(form({ expire: "1h" }))).status).toBe(400);
    expect((await call(form({ file: new Blob([png()]), url: "https://example.com/a.png" }))).status).toBe(400);
    expect((await call(form({ file: new Blob(["<svg/>"]) }))).status).toBe(415);
    expect((await call(form({ file: new Blob([png()]), expire: "forever-and-ever" }))).status).toBe(400);
    const notMultipart = new Request(`${MAIN}/api/upload`, { method: "POST", body: png(), headers: { "cf-connecting-ip": freshIp(), ...TRUSTED, "content-type": "image/png" } });
    expect((await call(notMultipart)).status).toBe(415);
  });
});

describe("upload gate, trusted token and rate limit on /api routes", () => {
  it("rejects anonymous uploads while UPLOAD_TOKEN is set, accepts the upload and trusted tokens", async () => {
    const anon = new Request(`${MAIN}/api/upload`, { method: "PUT", body: png(), headers: { "cf-connecting-ip": freshIp() } });
    expect((await call(anon)).status).toBe(401);
    expect((await call(put("/api/upload", png(), UPLOAD_AUTH))).status).toBe(201);
    expect((await call(put("/api/upload", png(), TRUSTED))).status).toBe(201);
    const anonOpen = new Request(`${MAIN}/api/upload`, { method: "PUT", body: png(), headers: { "cf-connecting-ip": freshIp() } });
    expect((await call(anonOpen, { UPLOAD_TOKEN: undefined })).status).toBe(201);
  });

  it("rate limits normal uploads per source but never the trusted token", async () => {
    const ip = freshIp();
    const normal: number[] = [];
    for (let i = 0; i < 11; i++) normal.push((await call(put("/api/upload", png(), { ...UPLOAD_AUTH, "cf-connecting-ip": ip }))).status);
    expect(normal).toEqual([...Array(10).fill(201), 429]);
    const trusted: number[] = [];
    for (let i = 0; i < 12; i++) trusted.push((await call(put("/api/upload", png(), { ...TRUSTED, "cf-connecting-ip": ip }))).status);
    expect(trusted.every((s) => s === 201)).toBe(true);
  });
});

describe("serving files", () => {
  it("serves permanent files on files.sugi.moe with hardening headers", async () => {
    const bytes = png(500);
    const r = await upload(bytes);
    const res = await call(new Request(r.url));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="${r.id}.png"`);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("500");
  });

  it("serves video with a media CSP and supports byte ranges", async () => {
    const bytes = mp4(1000);
    const r = await upload(bytes);
    const full = await call(new Request(r.url, { method: "HEAD" }));
    expect(full.headers.get("content-security-policy")).toBe("default-src 'none'; media-src 'self'; style-src 'unsafe-inline'");
    const part = await call(new Request(r.url, { headers: { range: "bytes=10-19" } }));
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(10, 20));
    const tail = await call(new Request(r.url, { headers: { range: "bytes=-5" } }));
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.slice(995));
    const open = await call(new Request(r.url, { headers: { range: "bytes=990-" } }));
    expect(open.headers.get("content-range")).toBe("bytes 990-999/1000");
    const bad = await call(new Request(r.url, { headers: { range: "bytes=5000-" } }));
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */1000");
  });

  it("answers HEAD and If-None-Match", async () => {
    const r = await upload(png(222));
    const head = await call(new Request(r.url, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("content-length")).toBe("222");
    expect((await call(new Request(r.url, { headers: { "if-none-match": head.headers.get("etag")! } }))).status).toBe(304);
  });

  it("keeps namespaces apart and checks the extension", async () => {
    const perm = await upload(png());
    const tmp = await upload(png(), "?expire=1h");
    expect((await call(new Request(`${TMP}/${perm.id}.png`))).status).toBe(404);
    expect((await call(new Request(`${FILES}/${tmp.id}.png`))).status).toBe(404);
    expect((await call(new Request(`${FILES}/${perm.id}.jpg`))).status).toBe(404);
    expect((await call(new Request(`${FILES}/zzzzzzzz.png`))).status).toBe(404);
    expect((await call(new Request(`${FILES}/../../etc/passwd`))).status).toBe(404);
    expect((await call(new Request(tmp.url))).status).toBe(200);
    expect((await call(new Request(tmp.url))).headers.get("cache-control")).toMatch(/^public, max-age=3[0-9]{3}$/);
  });

  it("file hosts serve nothing but files", async () => {
    const root = await call(new Request(`${FILES}/`));
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("https://sugi.moe/");
    expect((await call(new Request(`${FILES}/api/upload`, { method: "PUT", body: png() }))).status).toBe(405);
    expect((await call(new Request(`${FILES}/mine`))).status).toBe(404);
  });

  it("legacy links on the main origin keep working next to the new ones", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([png()]), "x.png");
    const res = await call(new Request(`${MAIN}/upload`, { method: "POST", body: fd, headers: { "cf-connecting-ip": freshIp(), ...TRUSTED } }));
    expect(res.status).toBe(201);
    const url = (await res.text()).trim();
    expect(url).toMatch(/^https:\/\/sugi\.test\/[0-9a-f]{16}\.png$/);
    expect((await call(new Request(url))).status).toBe(200);
  });
});

describe("temporary files expire", () => {
  async function backdate(id: string) {
    const obj = await env.BUCKET.get(`t/${id}`);
    await env.BUCKET.put(`t/${id}`, await obj!.arrayBuffer(), { httpMetadata: obj!.httpMetadata, customMetadata: { ...obj!.customMetadata, expires: String(Date.now() - 1000) } });
  }

  it("stop being served the moment they expire and are swept by the cron", async () => {
    const r = await upload(png(), "?expire=1h");
    const keep = await upload(png(), "?expire=1h");
    const perm = await upload(png());
    await backdate(r.id);
    expect((await call(new Request(r.url))).status).toBe(404);
    expect((await call(new Request(`${MAIN}/api/files/${r.id}`))).status).toBe(404);
    expect((await call(new Request(`${MAIN}/f/${r.id}`))).status).toBe(404);

    const swept = await sweepExpired(env);
    expect(swept.deleted).toContain(`t/${r.id}`);
    expect(swept.deleted).not.toContain(`t/${keep.id}`);
    expect(await env.BUCKET.head(`t/${r.id}`)).toBeNull();
    expect(await env.BUCKET.head(`t/${keep.id}`)).not.toBeNull();
    expect(await env.BUCKET.head(`f/${perm.id}`)).not.toBeNull();
  });

  it("the scheduled handler runs the sweep", async () => {
    const r = await upload(png(), "?expire=1h");
    await backdate(r.id);
    const waits: Promise<unknown>[] = [];
    await worker.scheduled!({ cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env, { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext);
    await Promise.all(waits);
    expect(await env.BUCKET.head(`t/${r.id}`)).toBeNull();
  });
});

describe("GET/DELETE /api/files/:id", () => {
  it("returns public info only", async () => {
    const r = await upload(png(), "?name=a.png");
    const res = await call(new Request(`${MAIN}/api/files/${r.id}`));
    const info = await res.json<Record<string, unknown>>();
    expect(info).toMatchObject({ id: r.id, url: r.url, page: r.page, name: "a.png", type: "image/png", expires_at: null });
    expect(JSON.stringify(info)).not.toMatch(/delete|source|del"/);
  });

  it("deletes with the right Sugi-Token only", async () => {
    const r = await upload(png());
    const del = (headers: Record<string, string>) => call(new Request(`${MAIN}/api/files/${r.id}`, { method: "DELETE", headers }));
    expect((await del({})).status).toBe(401);
    expect((await del({ "sugi-token": "d_wrong" })).status).toBe(403);
    expect((await del(TRUSTED)).status).toBe(401);
    const ok = await del({ "sugi-token": r.delete_token });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deleted: [r.id], cache_purged: true });
    expect((await call(new Request(r.url))).status).toBe(404);
    expect((await del({ "sugi-token": r.delete_token })).status).toBe(404);
  });

  it("one uploader's delete never touches another upload of the same bytes", async () => {
    const bytes = png();
    const a = await upload(bytes);
    const b = await upload(bytes);
    expect(a.id).not.toBe(b.id);
    await call(new Request(`${MAIN}/api/files/${a.id}`, { method: "DELETE", headers: { "sugi-token": a.delete_token } }));
    expect((await call(new Request(b.url))).status).toBe(200);
    expect((await call(new Request(`${MAIN}/api/files/${b.id}`, { method: "DELETE", headers: { "sugi-token": a.delete_token } }))).status).toBe(403);
  });

  it("admin can delete anything, temporary files included", async () => {
    const r = await upload(png(), "?expire=12h");
    expect((await call(new Request(`${MAIN}/api/files/${r.id}`, { method: "DELETE", headers: ADMIN }))).status).toBe(200);
    expect((await env.BUCKET.head(`t/${r.id}`))?.customMetadata?.tomb).toBe("1");
    expect((await call(new Request(r.url))).status).toBe(451);
    const info = await call(new Request(`${MAIN}/admin/info/f/${(await upload(png())).id}`, { headers: ADMIN }));
    expect(await info.json()).toMatchObject({ type: "image/png", source: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("purges the cached origin copy on delete when cache-through is on", async () => {
    const r = await upload(png());
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${String(input)} ${init?.body ?? ""}`);
      return Response.json({ success: true });
    });
    const res = await call(new Request(`${MAIN}/api/files/${r.id}`, { method: "DELETE", headers: { "sugi-token": r.delete_token } }), { CACHE_ORIGIN: "https://r2.sugi.test", ZONE_ID: "z", CF_PURGE_TOKEN: "p" });
    expect(res.status).toBe(200);
    expect(calls).toEqual([`https://api.cloudflare.com/client/v4/zones/z/purge_cache {"files":["https://r2.sugi.test/f/${r.id}"]}`]);
  });

  it("serves through the cache origin with the Range header forwarded", async () => {
    const bytes = mp4(400);
    const r = await upload(bytes);
    const seen: { url: string; range: string | null; cf: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit & { cf?: unknown }) => {
      seen.push({ url: String(input), range: new Headers(init?.headers).get("range"), cf: init?.cf });
      return new Response(bytes.slice(0, 10), { status: 206, headers: { "content-range": "bytes 0-9/400", "content-length": "10" } });
    });
    const res = await call(new Request(r.url, { headers: { range: "bytes=0-9" } }), { CACHE_ORIGIN: "https://r2.sugi.test" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-9/400");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(seen).toEqual([{ url: `https://r2.sugi.test/f/${r.id}`, range: "bytes=0-9", cf: expect.objectContaining({ cacheEverything: true }) }]);
  });
});

describe("URL import", () => {
  function stubRemote(handler: (url: string) => Response) {
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      seen.push(url);
      return handler(url);
    });
    return seen;
  }
  function importReq(url: string, extra: Record<string, string> = {}): Request {
    const fd = new FormData();
    fd.append("url", url);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return new Request(`${MAIN}/api/upload`, { method: "POST", body: fd, headers: { "cf-connecting-ip": freshIp(), ...TRUSTED, accept: "application/json" } });
  }

  it("fetches the link, sniffs it and names it after the path", async () => {
    const bytes = png(700);
    stubRemote(() => new Response(bytes, { headers: { "content-length": "700", "content-type": "text/html" } }));
    const res = await call(importReq("https://example.com/pics/%E7%8C%AB.png?x=1", { expire: "1h" }));
    expect(res.status).toBe(201);
    const r = await res.json<{ url: string; name: string; size: number }>();
    expect(r).toMatchObject({ name: "猫.png", size: 700 });
    expect(r.url).toMatch(/^https:\/\/tmp\.sugi\.moe\//);
  });

  it("follows http(s) redirects by hand and refuses other schemes and our own hosts", async () => {
    const seen = stubRemote((url) => (url.endsWith("/start") ? new Response(null, { status: 302, headers: { location: "/final.png" } }) : new Response(png(), { headers: { "content-length": "128" } })));
    expect((await call(importReq("https://example.com/start"))).status).toBe(201);
    expect(seen).toEqual(["https://example.com/start", "https://example.com/final.png"]);
    stubRemote(() => new Response(null, { status: 301, headers: { location: "file:///etc/passwd" } }));
    expect((await call(importReq("https://example.com/x"))).status).toBe(400);
    expect((await call(importReq("ftp://example.com/a.png"))).status).toBe(400);
    expect((await call(importReq("https://files.sugi.moe/abcdefgh.png"))).status).toBe(400);
    expect((await call(importReq("http://user:pw@example.com/a.png"))).status).toBe(400);
  });

  it("maps remote failures", async () => {
    stubRemote(() => new Response("nope", { status: 404 }));
    expect((await call(importReq("https://example.com/a.png"))).status).toBe(502);
    stubRemote(() => new Response("<html></html>", { headers: { "content-length": "13" } }));
    expect((await call(importReq("https://example.com/a.png"))).status).toBe(415);
    stubRemote(() => new Response(png(), { headers: { "content-length": String(300 * MiB) } }));
    expect((await call(importReq("https://example.com/a.png"))).status).toBe(413);
  });

  it("buffers bodies without a Content-Length up to a cap", async () => {
    const bytes = png(2000);
    stubRemote(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(bytes);
              c.close();
            },
          }),
        ),
    );
    const res = await call(importReq("https://example.com/a"));
    expect(res.status).toBe(201);
    expect((await res.json<{ size: number }>()).size).toBe(2000);
  });
});

describe("chunked uploads", () => {
  const PART = 5 * MiB;

  async function start(first: Uint8Array, size: number, query = ""): Promise<Response> {
    return call(new Request(`${MAIN}/api/uploads?size=${size}${query}`, { method: "POST", body: first, headers: { "cf-connecting-ip": freshIp(), ...TRUSTED } }));
  }

  it("assembles parts into one file that is served intact", async () => {
    const total = 2 * PART + 1234;
    const all = new Uint8Array(total);
    all.set(mp4(64));
    for (let i = 64; i < total; i += 4096) all[i] = i & 0xff;
    const res = await start(all.slice(0, PART), total, "&expire=72h&name=clip.mp4");
    expect(res.status).toBe(201);
    const s = await res.json<{ upload: string; part_size: number; parts: number; id: string; etag: string }>();
    expect(s).toMatchObject({ part_size: PART, parts: 3 });
    const etags = [s.etag];
    for (const n of [2, 3]) {
      const body = all.slice((n - 1) * PART, n * PART);
      const r = await call(new Request(`${MAIN}/api/uploads/${n}`, { method: "PUT", body, headers: { "sugi-upload": s.upload } }));
      expect(r.status).toBe(200);
      etags.push((await r.json<{ etag: string }>()).etag);
    }
    const done = await call(new Request(`${MAIN}/api/uploads/complete`, { method: "POST", body: JSON.stringify({ etags }), headers: { "sugi-upload": s.upload, accept: "application/json", "content-type": "application/json" } }));
    expect(done.status).toBe(201);
    const r = await done.json<{ url: string; size: number; type: string; name: string; delete_token: string; expires_at: string }>();
    expect(r).toMatchObject({ size: total, type: "video/mp4", name: "clip.mp4" });
    expect(r.url).toBe(`https://tmp.sugi.moe/${s.id}.mp4`);
    const got = await call(new Request(r.url));
    const digest = async (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b)), (x) => x.toString(16).padStart(2, "0")).join("");
    const back = await got.arrayBuffer();
    expect(back.byteLength).toBe(total);
    // Compare digests: a deep equality diff of 10 MB arrays would exhaust the test runner's memory.
    expect(await digest(back)).toBe(await digest(all));
    expect((await call(new Request(`${MAIN}/api/files/${s.id}`, { method: "DELETE", headers: { "sugi-token": r.delete_token } }))).status).toBe(200);
  });

  it("sniffs the first part and checks sizes", async () => {
    expect((await start(new Uint8Array(PART).fill(0x41), 3 * PART)).status).toBe(415);
    expect((await start(png(1024), 3 * PART)).status).toBe(400);
    expect((await start(png(PART), 201 * MiB)).status).toBe(413);
    expect((await start(png(PART), 0)).status).toBe(400);
    const anon = new Request(`${MAIN}/api/uploads?size=${3 * PART}`, { method: "POST", body: png(PART), headers: { "cf-connecting-ip": freshIp() } });
    expect((await call(anon)).status).toBe(401);
  });

  it("checks the session, part numbers, part lengths and etags", async () => {
    const res = await start(png(PART), 2 * PART + 10);
    const s = await res.json<{ upload: string; etag: string }>();
    const partReq = (n: number, body: Uint8Array, session = s.upload) => call(new Request(`${MAIN}/api/uploads/${n}`, { method: "PUT", body, headers: { "sugi-upload": session } }));
    expect((await partReq(2, new Uint8Array(10), s.upload.replace(/.$/, (c) => (c === "a" ? "b" : "a")))).status).toBe(401);
    expect((await partReq(2, new Uint8Array(10), "garbage")).status).toBe(401);
    expect((await partReq(1, new Uint8Array(PART))).status).toBe(400);
    expect((await partReq(4, new Uint8Array(10))).status).toBe(400);
    expect((await partReq(3, new Uint8Array(11))).status).toBe(400);
    const complete = (etags: unknown) => call(new Request(`${MAIN}/api/uploads/complete`, { method: "POST", body: JSON.stringify({ etags }), headers: { "sugi-upload": s.upload } }));
    expect((await complete([s.etag])).status).toBe(400);
    const abort = await call(new Request(`${MAIN}/api/uploads`, { method: "DELETE", headers: { "sugi-upload": s.upload } }));
    expect(abort.status).toBe(200);
  });
});

describe("albums", () => {
  async function make(files: string[], title = "", headers: Record<string, string> = {}): Promise<Response> {
    return call(new Request(`${MAIN}/api/albums`, { method: "POST", body: JSON.stringify({ files, title }), headers: { "cf-connecting-ip": freshIp(), ...TRUSTED, "content-type": "application/json", accept: "application/json", ...headers } }));
  }

  it("creates, lists and deletes an album without touching its files", async () => {
    const a = await upload(png(), "?name=a.png");
    const b = await upload(mp4(), "?expire=1h");
    const res = await make([a.id, b.url, a.id], "  周报\u0000配图  ");
    expect(res.status).toBe(201);
    const al = await res.json<{ id: string; url: string; title: string; files: number; delete_token: string }>();
    expect(al).toMatchObject({ url: `https://sugi.moe/a/${al.id}`, title: "周报配图", files: 2 });
    expect(al.delete_token).toMatch(/^a_/);

    const got = await (await call(new Request(`${MAIN}/api/albums/${al.id}`))).json<{ title: string; files: { id: string; url: string; type: string }[] }>();
    expect(got.title).toBe("周报配图");
    expect(got.files.map((f) => f.id)).toEqual([a.id, b.id]);
    expect(got.files[1]).toMatchObject({ url: b.url, type: "video/mp4" });

    await call(new Request(`${MAIN}/api/files/${a.id}`, { method: "DELETE", headers: { "sugi-token": a.delete_token } }));
    const after = await (await call(new Request(`${MAIN}/api/albums/${al.id}`))).json<{ files: { id: string }[] }>();
    expect(after.files.map((f) => f.id)).toEqual([b.id]);

    const del = (headers: Record<string, string>) => call(new Request(`${MAIN}/api/albums/${al.id}`, { method: "DELETE", headers }));
    expect((await del({})).status).toBe(401);
    expect((await del({ "sugi-token": "a_nope" })).status).toBe(403);
    expect((await del({ "sugi-token": al.delete_token })).status).toBe(200);
    expect((await call(new Request(`${MAIN}/api/albums/${al.id}`))).status).toBe(404);
    expect((await call(new Request(b.url))).status).toBe(200);
  });

  it("accepts form fields and answers with the link as text by default", async () => {
    const a = await upload(png());
    const fd = new FormData();
    fd.append("files", `${a.id}`);
    fd.append("title", "hi");
    const res = await call(new Request(`${MAIN}/api/albums`, { method: "POST", body: fd, headers: { "cf-connecting-ip": freshIp(), ...TRUSTED } }));
    expect(res.status).toBe(201);
    expect((await res.text()).trim()).toMatch(/^https:\/\/sugi\.moe\/a\/[a-z0-9]{8}$/);
  });

  it("validates input, the gate and its own rate limit", async () => {
    expect((await make([])).status).toBe(400);
    expect((await make(["zzzzzzzz"])).status).toBe(404);
    expect((await make(["not an id!"])).status).toBe(400);
    expect((await make(Array.from({ length: 101 }, (_, i) => `abcdef${String(i).padStart(2, "0")}`))).status).toBe(400);
    const a = await upload(png());
    const anon = await call(new Request(`${MAIN}/api/albums`, { method: "POST", body: JSON.stringify({ files: [a.id] }), headers: { "cf-connecting-ip": freshIp(), "content-type": "application/json" } }));
    expect(anon.status).toBe(401);
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await make([a.id], "", { ...UPLOAD_AUTH, "cf-connecting-ip": ip })).status);
    expect(statuses).toEqual([...Array(10).fill(201), 429]);
    // Uploads from the same source are counted separately.
    expect((await call(put("/api/upload", png(), { ...UPLOAD_AUTH, "cf-connecting-ip": ip }))).status).toBe(201);
  });

  it("purge-by-source removes the source's new uploads and albums too", async () => {
    const ip = freshIp();
    const mine = await upload(png(), "", { "cf-connecting-ip": ip });
    const theirs = await upload(png());
    const al = await (await make([mine.id], "x", { "cf-connecting-ip": ip })).json<{ id: string }>();
    const source = await hmacHex("test-ip-hash-secret", ip);
    const res = await call(new Request(`${MAIN}/admin/purge-by-source`, { method: "POST", body: JSON.stringify({ source }), headers: { ...ADMIN, "content-type": "application/json" } }));
    expect(res.status).toBe(200);
    const body = await res.json<{ deleted: string[]; albums: string[] }>();
    expect(body.deleted).toContain(`f/${mine.id}`);
    expect(body.albums).toEqual([al.id]);
    expect((await call(new Request(mine.url))).status).toBe(451);
    expect((await call(new Request(theirs.url))).status).toBe(200);
    expect((await call(new Request(`${MAIN}/api/albums/${al.id}`))).status).toBe(451);
  });
});

describe("api routing", () => {
  it("unknown endpoints and methods", async () => {
    expect((await call(new Request(`${MAIN}/api/nope`))).status).toBe(404);
    expect((await call(new Request(`${MAIN}/api/upload`))).status).toBe(405);
    expect((await call(new Request(`${MAIN}/api/albums`))).status).toBe(405);
    expect((await call(new Request(`${MAIN}/api/files/abc`))).status).toBe(404);
  });
});

describe("path-based file origins (local development)", () => {
  it("serves files under the origin's path on any host when the origin has a path", async () => {
    const dev = { FILES_ORIGIN: "http://localhost:8787/_files", TMP_ORIGIN: "http://localhost:8787/_tmp", MAIN_ORIGIN: "http://localhost:8787" };
    const res = await call(put("/api/upload?expire=1h", png(), { accept: "application/json" }), dev);
    const r = await res.json<{ id: string; url: string }>();
    expect(r.url).toBe(`http://localhost:8787/_tmp/${r.id}.png`);
    expect((await call(new Request(`${MAIN}/_tmp/${r.id}.png`), dev)).status).toBe(200);
    expect((await call(new Request(`${MAIN}/_files/${r.id}.png`), dev)).status).toBe(404);
    // With dedicated hosts configured (production), those paths are ordinary site paths.
    expect((await call(new Request(`${MAIN}/_tmp/${r.id}.png`))).status).toBe(404);
  });
});
