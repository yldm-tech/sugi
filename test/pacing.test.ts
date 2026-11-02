import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSession } from "../src/auth/core";
import { ACCOUNT_RATE_LIMIT, RATE_LIMIT, WAF_LIMIT, WAF_PERIOD_SECONDS } from "../src/limits";
import { call, freshIp, MAIN, png } from "./helpers";

const ACCOUNTS: Partial<Env> = { FEATURE_ACCOUNTS: "1", ACCOUNT_FEATURES: "email", UPLOAD_TOKEN: "" };
const ORIGIN = { origin: "https://sugi.moe" };

async function session(): Promise<string> {
  const id = `p${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, NULL, ?)").bind(id, `${id}@example.org`, Date.now()).run();
  return (await createSession(env, id, "email")).split(";")[0];
}

const put = (ip: string, headers: Record<string, string> = {}) =>
  call(
    new Request(`${MAIN}/api/upload`, { method: "PUT", body: png(), headers: { "cf-connecting-ip": ip, accept: "application/json", ...headers } }),
    ACCOUNTS,
  );

function config(html: string): { user: boolean; limits: { rate: number; ratePeriod: number; waf: { limit: number; period: number } | null } } {
  return JSON.parse(/<script type="application\/json" id="sugi-config">(.*?)<\/script>/s.exec(html)![1]);
}

describe("upload pacing", () => {
  it("logged-in accounts get their own, larger allowance", async () => {
    const ip = freshIp();
    const cookie = await session();
    // More uploads than an anonymous visitor may make in a minute, all from one IP.
    for (let i = 0; i < RATE_LIMIT + 5; i++) expect((await put(ip, { cookie, ...ORIGIN })).status).toBe(201);
    // The same IP without the session is still limited per source.
    const anon = freshIp();
    let limited = false;
    for (let i = 0; i < RATE_LIMIT + 1 && !limited; i++) limited = (await put(anon)).status === 429;
    expect(limited).toBe(true);
  });

  it("tells the page which limits apply, so it can pace its queue", async () => {
    const anon = config(await (await call(new Request(`${MAIN}/?lang=zh`, { headers: { accept: "text/html" } }), ACCOUNTS)).text());
    expect(anon.limits).toMatchObject({ rate: RATE_LIMIT, ratePeriod: 60, waf: { limit: WAF_LIMIT, period: WAF_PERIOD_SECONDS } });
    const cookie = await session();
    const user = config(await (await call(new Request(`${MAIN}/?lang=zh`, { headers: { accept: "text/html", cookie } }), ACCOUNTS)).text());
    expect(user.user).toBe(true);
    // The zone WAF rule skips requests with a session cookie, so only the account limit applies.
    expect(user.limits).toMatchObject({ rate: ACCOUNT_RATE_LIMIT, waf: null });
  });
});
