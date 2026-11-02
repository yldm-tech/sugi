import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call, freshIp, MAIN, png, TRUSTED, UPLOAD_AUTH } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

// Each test runs on its own made-up day so the shared daily counters start at zero.
let dayOffset = 1000;
function freshDay(): void {
  const t = Date.UTC(2030, 0, 1) + dayOffset++ * 86400e3;
  vi.spyOn(Date, "now").mockReturnValue(t);
}

const put = (bytes: Uint8Array, headers: Record<string, string>, overrides: Partial<Env>) =>
  call(new Request(`${MAIN}/api/upload`, { method: "PUT", body: bytes, headers: { accept: "application/json", ...headers } }), overrides);

describe("daily upload quotas", () => {
  it("stop an anonymous source at its daily bytes, with a clear message, but never trusted uploads", async () => {
    freshDay();
    const q = { QUOTA_ANON_BYTES_PER_DAY: "1000" };
    const ip = freshIp();
    expect((await put(png(600), { ...UPLOAD_AUTH, "cf-connecting-ip": ip }, q)).status).toBe(201);
    const over = await put(png(600), { ...UPLOAD_AUTH, "cf-connecting-ip": ip }, q);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await over.json<{ error: string }>()).error).toMatch(/daily upload quota used up .* log in for 5 GB per day/);
    // Another source still has its own allowance; the trusted token has none.
    expect((await put(png(600), { ...UPLOAD_AUTH, "cf-connecting-ip": freshIp() }, q)).status).toBe(201);
    expect((await put(png(600), { ...TRUSTED, "cf-connecting-ip": ip }, q)).status).toBe(201);
  });

  it("closes the site to everyone but trusted uploads once the global cap is reached", async () => {
    freshDay();
    const q = { QUOTA_GLOBAL_BYTES_PER_DAY: "1500" };
    expect((await put(png(1000), { ...UPLOAD_AUTH, "cf-connecting-ip": freshIp() }, q)).status).toBe(201);
    const full = await put(png(1000), { ...UPLOAD_AUTH, "cf-connecting-ip": freshIp() }, q);
    expect(full.status).toBe(507);
    expect((await full.json<{ error: string }>()).error).toContain("today's upload limit");
    expect((await put(png(1000), { ...TRUSTED, "cf-connecting-ip": freshIp() }, q)).status).toBe(201);
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    const global = await env.DB.prepare("SELECT bytes, uploads, rejected FROM usage_daily WHERE day = ? AND scope = 'global'").bind(day).first();
    expect(global).toEqual({ bytes: 2000, uploads: 2, rejected: 1 });
  });

  it("charges a chunked upload's full size when it starts, and the legacy endpoint too", async () => {
    freshDay();
    const q = { QUOTA_ANON_BYTES_PER_DAY: String(6 * 1024 * 1024) };
    const ip = freshIp();
    const start = await call(
      new Request(`${MAIN}/api/uploads?size=${8 * 1024 * 1024}`, {
        method: "POST",
        body: png(5 * 1024 * 1024),
        headers: { ...UPLOAD_AUTH, "cf-connecting-ip": ip },
      }),
      q,
    );
    expect(start.status).toBe(429);
    const small = { QUOTA_ANON_BYTES_PER_DAY: "500" };
    expect(
      (await call(new Request(`${MAIN}/upload`, { method: "PUT", body: png(600), headers: { ...UPLOAD_AUTH, "cf-connecting-ip": ip } }), small)).status,
    ).toBe(429);
  });

  it("0 means unlimited", async () => {
    freshDay();
    const q = { QUOTA_ANON_BYTES_PER_DAY: "0", QUOTA_GLOBAL_BYTES_PER_DAY: "0" };
    const ip = freshIp();
    for (let i = 0; i < 3; i++) expect((await put(png(2000), { ...UPLOAD_AUTH, "cf-connecting-ip": ip }, q)).status).toBe(201);
  });
});
