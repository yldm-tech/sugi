import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { ADMIN, call, freshIp, MAIN, png, UPLOAD_AUTH } from "./helpers";

const ON: Partial<Env> = { FEATURE_ACCOUNTS: "1", ACCOUNT_FEATURES: "email", RESEND_API_KEY: "re_test_key" };
const ORIGIN = { origin: "https://sugi.moe" };

afterEach(() => {
  vi.restoreAllMocks();
});

interface Sent {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

/** Stubs Resend and records what would have been sent. */
function stubResend(status = 200): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://api.resend.com/emails");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer re_test_key");
    sent.push(JSON.parse(String(init?.body)));
    return status === 200 ? Response.json({ id: "x" }) : Response.json({ name: status === 429 ? "daily_quota_exceeded" : "error" }, { status });
  });
  return sent;
}

const askForLink = (email: string, ip = freshIp(), headers: Record<string, string> = ORIGIN) => {
  const form = new FormData();
  form.append("email", email);
  form.append("lang", "en");
  return call(new Request(`${MAIN}/auth/email`, { method: "POST", body: form, headers: { "cf-connecting-ip": ip, ...headers } }), ON);
};

const tokenFrom = (mail: Sent) => /verify\?token=([A-Za-z0-9_-]+)/.exec(mail.text)![1];

async function logIn(email: string): Promise<string> {
  const sent = stubResend();
  expect((await askForLink(email)).status).toBe(303);
  vi.restoreAllMocks();
  const form = new FormData();
  form.append("token", tokenFrom(sent[0]));
  const res = await call(new Request(`${MAIN}/auth/email/verify`, { method: "POST", body: form, headers: ORIGIN }), ON);
  expect(res.status).toBe(303);
  return /sugi_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1];
}

describe("email login", () => {
  it("is off unless FEATURE_ACCOUNTS is on", async () => {
    expect((await call(new Request(`${MAIN}/login`))).status).toBe(404);
    expect((await call(new Request(`${MAIN}/auth/email`, { method: "POST", body: "{}", headers: ORIGIN }))).status).toBe(404);
    expect(await (await call(new Request(`${MAIN}/`))).text()).not.toContain('href="/login"');
  });

  it("shows only the live login methods", async () => {
    const page = await (await call(new Request(`${MAIN}/login?lang=en`), ON)).text();
    expect(page).toContain('action="/auth/email"');
    expect(page).not.toMatch(/GitHub|Google|passkey/i);
    const privacy = await (await call(new Request(`${MAIN}/privacy?lang=en`), ON)).text();
    expect(privacy).toContain("your email (when you log in with email)");
    expect(privacy).not.toMatch(/GitHub|Google|passkey|API token/);
  });

  it("sends a link, confirms on a page, logs in, records uploads and logs out", async () => {
    const sent = stubResend();
    const res = await askForLink("Cat@Example.com");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://sugi.moe/login?sent=1");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: "sugi.moe <login@sugi.moe>", to: ["cat@example.com"], subject: "Log in to sugi.moe" });
    const token = tokenFrom(sent[0]);
    vi.restoreAllMocks();

    // Opening the link only shows a button; mail scanners that prefetch it do not log anyone in.
    const confirm = await (await call(new Request(`${MAIN}/auth/email/verify?token=${token}&lang=en`), ON)).text();
    expect(confirm).toContain(`name="token" value="${token}"`);
    expect(confirm).toContain("noindex");

    const form = new FormData();
    form.append("token", token);
    expect((await call(new Request(`${MAIN}/auth/email/verify`, { method: "POST", body: form }), ON)).status).toBe(403);
    const done = await call(new Request(`${MAIN}/auth/email/verify`, { method: "POST", body: form, headers: ORIGIN }), ON);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("https://sugi.moe/account?welcome=1");
    const setCookie = done.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/sugi_session=[^;]+; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax/);
    const cookie = `sugi_session=${/sugi_session=([^;]+)/.exec(setCookie)![1]}`;

    const again = new FormData();
    again.append("token", token);
    const reused = await call(new Request(`${MAIN}/auth/email/verify`, { method: "POST", body: again, headers: ORIGIN }), ON);
    expect(reused.headers.get("location")).toBe("https://sugi.moe/login?error=link");

    const account = await (await call(new Request(`${MAIN}/account?lang=en`, { headers: { cookie } }), ON)).text();
    expect(account).toContain("cat@example.com");
    expect(account).toContain('href="/account"');
    expect(await (await call(new Request(`${MAIN}/api/me`, { headers: { cookie } }), ON)).json()).toMatchObject({ email: "cat@example.com" });

    // Uploads made while logged in belong to the account.
    const up = await call(
      new Request(`${MAIN}/api/upload`, {
        method: "PUT",
        body: png(),
        headers: { cookie, ...ORIGIN, ...UPLOAD_AUTH, accept: "application/json", "cf-connecting-ip": freshIp() },
      }),
      ON,
    );
    expect(up.status).toBe(201);
    const { id } = await up.json<{ id: string }>();
    const me = await (await call(new Request(`${MAIN}/api/me`, { headers: { cookie } }), ON)).json<{ id: string }>();
    expect(await env.DB.prepare("SELECT 1 FROM user_files WHERE user_id = ? AND file_key = ?").bind(me.id, `f/${id}`).first()).not.toBeNull();

    const out = await call(new Request(`${MAIN}/auth/logout`, { method: "POST", headers: { cookie, ...ORIGIN, accept: "text/html" } }), ON);
    expect(out.status).toBe(303);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call(new Request(`${MAIN}/api/me`, { headers: { cookie } }), ON)).status).toBe(401);
  });

  it("logging in again with the same address reaches the same account", async () => {
    const a = await logIn("same@example.com");
    const b = await logIn("SAME@example.com");
    const idOf = async (c: string) =>
      (await (await call(new Request(`${MAIN}/api/me`, { headers: { cookie: `sugi_session=${c}` } }), ON)).json<{ id: string }>()).id;
    expect(await idOf(a)).toBe(await idOf(b));
  });

  it("refuses cross-site requests, bad addresses, and too many emails", async () => {
    stubResend();
    expect((await askForLink("x@example.com", freshIp(), {})).status).toBe(403);
    expect((await askForLink("not an email")).headers.get("location")).toBe("https://sugi.moe/login?error=invalid");
    for (let i = 0; i < 3; i++) expect((await askForLink("busy@example.com")).headers.get("location")).toBe("https://sugi.moe/login?sent=1");
    expect((await askForLink("busy@example.com")).headers.get("location")).toBe("https://sugi.moe/login?error=rate");
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await askForLink(`n${i}@example.com`, ip);
    expect((await askForLink("n9@example.com", ip)).headers.get("location")).toBe("https://sugi.moe/login?error=rate");
    const json = await call(
      new Request(`${MAIN}/auth/email`, {
        method: "POST",
        body: JSON.stringify({ email: "busy@example.com" }),
        headers: { ...ORIGIN, "content-type": "application/json", "cf-connecting-ip": freshIp() },
      }),
      ON,
    );
    expect(json.status).toBe(429);
  });

  it("tells the user when the provider's quota is used up, and keeps no link for an unsent mail", async () => {
    stubResend(429);
    expect((await askForLink("quota@example.com")).headers.get("location")).toBe("https://sugi.moe/login?error=quota");
    expect(await env.DB.prepare("SELECT 1 FROM magic_links WHERE email = 'quota@example.com'").first()).toBeNull();
  });

  it("the login page explains what happened", async () => {
    expect(await (await call(new Request(`${MAIN}/login?sent=1&lang=en`), ON)).text()).toContain("We sent a login link");
    expect(await (await call(new Request(`${MAIN}/login?error=rate&lang=en`), ON)).text()).toContain("Too many login emails");
  });
});

describe("end-to-end test inbox", () => {
  const message = (to: string, raw: string) => {
    const rejected: string[] = [];
    return {
      rejected,
      msg: {
        from: "login@sugi.moe",
        to,
        headers: new Headers({ subject: "Log in to sugi.moe" }),
        raw: new Response(raw).body!,
        rawSize: raw.length,
        setReject: (r: string) => rejected.push(r),
        forward: async () => undefined,
        reply: async () => undefined,
      } as unknown as ForwardableEmailMessage,
    };
  };

  it("keeps only mail to the test address, readable by admins only, with quoted-printable links decoded", async () => {
    const other = message("someone@sugi.moe", "hello");
    await worker.email!(other.msg, env);
    expect(other.rejected).toEqual(["unknown address"]);

    const raw = "Subject: Log in\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nOpen https://sugi.moe/auth/email/verify?token=3Dabc_DEF-12=\r\n34 now";
    const mine = message("E2E-TESTINBOX@sugi.moe", raw);
    await worker.email!(mine.msg, env);
    expect(mine.rejected).toEqual([]);

    expect((await call(new Request(`${MAIN}/admin/e2e-inbox`))).status).toBe(401);
    const res = await call(new Request(`${MAIN}/admin/e2e-inbox`, { headers: ADMIN }));
    expect(await res.json()).toMatchObject({ subject: "Log in to sugi.moe", links: ["https://sugi.moe/auth/email/verify?token=abc_DEF-1234"] });
  });

  it("holds at most 50 messages for an hour", async () => {
    const { sweepInbox, INBOX_TTL_MS } = await import("../src/inbox");
    for (let i = 0; i < 55; i++) await worker.email!(message("e2e-testinbox@sugi.moe", `m${i}`).msg, env);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM e2e_inbox").first<{ n: number }>())!.n).toBe(50);
    await sweepInbox(env, Date.now() + INBOX_TTL_MS + 1000);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM e2e_inbox").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("GitHub login", () => {
  const GH: Partial<Env> = { ...ON, ACCOUNT_FEATURES: "email,github", GITHUB_CLIENT_ID: "gh-client", GITHUB_CLIENT_SECRET: "gh-secret" };

  function stubGitHub(user = { id: 4242, login: "octocat", name: "Octo Cat" }, emails = [{ email: "Octo@Example.com", primary: true, verified: true }]) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://github.com/login/oauth/access_token")
        return Response.json({ access_token: "gho_test", token_type: "bearer", scope: "read:user,user:email" });
      if (url === "https://api.github.com/user") return Response.json(user);
      if (url === "https://api.github.com/user/emails") return Response.json(emails);
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  async function start(extra: Record<string, string> = {}) {
    const res = await call(new Request(`${MAIN}/auth/github`, { headers: extra }), GH);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    const cookie = /sugi_oauth=([^;]+)/.exec(res.headers.get("set-cookie")!)![1];
    return { location, cookie, state: location.searchParams.get("state")! };
  }

  it("redirects to GitHub with the callback on our origin, and only when configured", async () => {
    const { location } = await start();
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("gh-client");
    expect(location.searchParams.get("redirect_uri")).toBe("https://sugi.moe/auth/github/callback");
    expect(location.searchParams.get("scope")).toBe("read:user user:email");
    expect((await call(new Request(`${MAIN}/auth/github`), ON)).status).toBe(404);
    expect((await call(new Request(`${MAIN}/auth/google`), GH)).status).toBe(404);
  });

  it("shows the button only when github is in ACCOUNT_FEATURES", async () => {
    expect(await (await call(new Request(`${MAIN}/login?lang=en`), GH)).text()).toContain('href="/auth/github"');
    expect(await (await call(new Request(`${MAIN}/login?lang=en`), { ...GH, ACCOUNT_FEATURES: "email" })).text()).not.toContain("/auth/github");
    expect(await (await call(new Request(`${MAIN}/privacy?lang=en`), GH)).text()).toContain("your GitHub user id");
  });

  it("logs in with the verified primary email, and refuses a forged state", async () => {
    const { cookie, state } = await start();
    stubGitHub();
    const bad = await call(new Request(`${MAIN}/auth/github/callback?code=abc&state=nope`, { headers: { cookie: `sugi_oauth=${cookie}` } }), GH);
    expect(bad.headers.get("location")).toBe("https://sugi.moe/login?error=oauth");
    const ok = await call(new Request(`${MAIN}/auth/github/callback?code=abc&state=${state}`, { headers: { cookie: `sugi_oauth=${cookie}` } }), GH);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("https://sugi.moe/account");
    const session = /sugi_session=([^;]+)/.exec(ok.headers.get("set-cookie")!)![1];
    vi.restoreAllMocks();
    const me = await (await call(new Request(`${MAIN}/api/me`, { headers: { cookie: `sugi_session=${session}` } }), GH)).json<{
      email: string;
      name: string;
    }>();
    expect(me).toMatchObject({ email: "octo@example.com", name: "Octo Cat" });
    const account = await (await call(new Request(`${MAIN}/account?lang=en`, { headers: { cookie: `sugi_session=${session}` } }), GH)).text();
    expect(account).toContain("Log in with: GitHub");
    expect(account).not.toContain('href="/auth/github"');
  });

  it("links GitHub to the account you are logged in to", async () => {
    const session = await logIn("linker@example.com");
    const { cookie, state } = await start({ cookie: `sugi_session=${session}` });
    stubGitHub({ id: 777, login: "linker", name: "" }, [{ email: "other@example.com", primary: true, verified: true }]);
    const res = await call(
      new Request(`${MAIN}/auth/github/callback?code=abc&state=${state}`, { headers: { cookie: `sugi_oauth=${cookie}; sugi_session=${session}` } }),
      GH,
    );
    expect(res.headers.get("location")).toBe("https://sugi.moe/account");
    expect(res.headers.get("set-cookie")).not.toContain("sugi_session=");
    vi.restoreAllMocks();
    const account = await (await call(new Request(`${MAIN}/account?lang=en`, { headers: { cookie: `sugi_session=${session}` } }), GH)).text();
    expect(account).toContain("linker@example.com");
    expect(account).toContain("Email · GitHub");
  });
});

describe("Google login", () => {
  const GO: Partial<Env> = { ...ON, ACCOUNT_FEATURES: "email,google", GOOGLE_CLIENT_ID: "go-client", GOOGLE_CLIENT_SECRET: "go-secret" };
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  function stubGoogle(claims: Record<string, unknown>) {
    const bodies: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== "https://oauth2.googleapis.com/token") throw new Error(`unexpected fetch ${url}`);
      bodies.push(String(input instanceof Request ? await input.text() : init?.body));
      return Response.json({ access_token: "ya29.test", token_type: "Bearer", expires_in: 3600, id_token: `${b64({ alg: "RS256" })}.${b64(claims)}.sig` });
    });
    return bodies;
  }

  it("uses PKCE, asks to pick an account, and logs in with the verified email", async () => {
    const res = await call(new Request(`${MAIN}/auth/google`), GO);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("redirect_uri")).toBe("https://sugi.moe/auth/google/callback");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("prompt")).toBe("select_account");
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    const cookie = /sugi_oauth=([^;]+)/.exec(res.headers.get("set-cookie")!)![1];
    const state = location.searchParams.get("state")!;
    const bodies = stubGoogle({ sub: "g-123", email: "Goo@Example.com", email_verified: true, name: "Goo" });
    const done = await call(new Request(`${MAIN}/auth/google/callback?code=abc&state=${state}`, { headers: { cookie: `sugi_oauth=${cookie}` } }), GO);
    expect(done.headers.get("location")).toBe("https://sugi.moe/account");
    expect(bodies[0]).toContain("code_verifier=");
    const session = /sugi_session=([^;]+)/.exec(done.headers.get("set-cookie")!)![1];
    vi.restoreAllMocks();
    expect(await (await call(new Request(`${MAIN}/api/me`, { headers: { cookie: `sugi_session=${session}` } }), GO)).json()).toMatchObject({
      email: "goo@example.com",
      name: "Goo",
    });
    expect(await (await call(new Request(`${MAIN}/login?lang=en`), GO)).text()).toContain('href="/auth/google"');
    expect(await (await call(new Request(`${MAIN}/privacy?lang=en`), GO)).text()).toContain("your Google user id");
  });

  it("does not take an unverified email", async () => {
    const res = await call(new Request(`${MAIN}/auth/google`), GO);
    const cookie = /sugi_oauth=([^;]+)/.exec(res.headers.get("set-cookie")!)![1];
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    stubGoogle({ sub: "g-456", email: "unverified@example.com", email_verified: false, name: "U" });
    const done = await call(new Request(`${MAIN}/auth/google/callback?code=abc&state=${state}`, { headers: { cookie: `sugi_oauth=${cookie}` } }), GO);
    const session = /sugi_session=([^;]+)/.exec(done.headers.get("set-cookie")!)![1];
    vi.restoreAllMocks();
    expect(await (await call(new Request(`${MAIN}/api/me`, { headers: { cookie: `sugi_session=${session}` } }), GO)).json()).toMatchObject({
      email: null,
      name: "U",
    });
  });
});
