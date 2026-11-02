import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkAlerts, countOps, dailyNumbers, sendDailyReport } from "../src/ops";
import { call, freshIp, MAIN, png, TRUSTED } from "./helpers";

const OPS: Partial<Env> = { OPS_EMAIL: "ops@example.org", RESEND_API_KEY: "re_test" };

afterEach(() => {
  vi.restoreAllMocks();
});

function stubResend(): { subject: string; text: string; to: string[] }[] {
  const sent: { subject: string; text: string; to: string[] }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://api.resend.com/emails");
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "x" });
  });
  return sent;
}

describe("operations", () => {
  it("/healthz checks the database and the bucket", async () => {
    const res = await call(new Request(`${MAIN}/healthz`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, d1: true, r2: true });
  });

  it("counts server errors per hour", async () => {
    const hour = new Date().toISOString().slice(0, 13);
    const before = (await env.DB.prepare("SELECT count FROM ops_counters WHERE hour = ? AND name = '5xx'").bind(hour).first<{ count: number }>())?.count ?? 0;
    const res = await call(new Request(`${MAIN}/api/upload`, { method: "PUT", body: png(), headers: { "cf-connecting-ip": freshIp(), ...TRUSTED } }), {
      IP_HASH_SECRET: undefined,
    });
    expect(res.status).toBe(503);
    await new Promise((r) => setTimeout(r, 50));
    const after = (await env.DB.prepare("SELECT count FROM ops_counters WHERE hour = ? AND name = '5xx'").bind(hour).first<{ count: number }>())?.count ?? 0;
    expect(after).toBe(before + 1);
  });

  it("emails a daily report of yesterday's numbers, only when OPS_EMAIL is set", async () => {
    const yesterday = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
    await env.DB.prepare("INSERT OR REPLACE INTO usage_daily (day, scope, bytes, uploads, rejected) VALUES (?, 'global', ?, 42, 3)")
      .bind(yesterday, 5 * 1024 * 1024)
      .run();
    const n = await dailyNumbers(env, yesterday);
    expect(n).toMatchObject({ uploads: 42, upload_bytes: 5 * 1024 * 1024, quota_rejections: 3 });
    expect(await sendDailyReport({ ...env, OPS_EMAIL: undefined } as Env)).toBe(false);
    const sent = stubResend();
    expect(await sendDailyReport({ ...env, ...OPS } as Env)).toBe(true);
    expect(sent[0].to).toEqual(["ops@example.org"]);
    expect(sent[0].subject).toBe(`[sugi.moe] daily report ${yesterday}`);
    expect(sent[0].text).toMatch(/uploads +42 \(5\.0 MB\)/);
    expect(sent[0].text).toMatch(/quota rejections +3/);
    expect(sent[0].text).toContain("storage");
  });

  it("alerts on a burst of server errors at most once every six hours", async () => {
    const now = Date.UTC(2031, 5, 1, 12, 30);
    for (let i = 0; i < 25; i++) await countOps(env, "5xx", now);
    const sent = stubResend();
    expect(await checkAlerts({ ...env, ...OPS } as Env, now)).toContain("5xx");
    expect(sent[0].subject).toContain("25 server errors");
    expect(await checkAlerts({ ...env, ...OPS } as Env, now + 3600e3)).not.toContain("5xx");
    expect(await checkAlerts({ ...env, ...OPS } as Env, now + 7 * 3600e3)).toEqual([]);
  });
});
