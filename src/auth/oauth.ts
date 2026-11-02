// GitHub and Google login (OAuth 2 authorization code flow via arctic; Google adds PKCE). The state, the PKCE verifier and where to go afterwards live in a short-lived HttpOnly cookie scoped to /auth.
import { decodeIdToken, generateCodeVerifier, generateState, GitHub, Google } from "arctic";
import { HttpError } from "../http";
import { accountsOn, cookie, createSession, loginWithIdentity, readCookies, resolvePrincipal } from "./core";

const OAUTH_COOKIE = "sugi_oauth";

export type Provider = "github" | "google";

export function providerConfigured(env: Env, p: Provider): boolean {
  return p === "github" ? Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) : Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

function callback(env: Env, p: Provider): string {
  return `${env.MAIN_ORIGIN}/auth/${p}/callback`;
}

function safeNext(raw: string | null): string {
  return raw && /^\/[a-z0-9/_-]*$/i.test(raw) && !raw.startsWith("//") ? raw : "/mine";
}

// GET /auth/github, /auth/google
export function handleOAuthStart(request: Request, env: Env, p: Provider): Response {
  if (!accountsOn(env) || !providerConfigured(env, p)) throw new HttpError(404, "not found");
  const state = generateState();
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  let url: URL;
  let verifier = "";
  if (p === "github") {
    url = new GitHub(env.GITHUB_CLIENT_ID!, env.GITHUB_CLIENT_SECRET!, callback(env, p)).createAuthorizationURL(state, ["read:user", "user:email"]);
  } else {
    verifier = generateCodeVerifier();
    url = new Google(env.GOOGLE_CLIENT_ID!, env.GOOGLE_CLIENT_SECRET!, callback(env, p)).createAuthorizationURL(state, verifier, ["openid", "email", "profile"]);
    url.searchParams.set("prompt", "select_account");
  }
  const value = [p, state, verifier, encodeURIComponent(next)].join(".");
  return new Response(null, { status: 302, headers: { location: url.toString(), "set-cookie": cookie(OAUTH_COOKIE, value, 600, "/auth"), "cache-control": "no-store" } });
}

interface ExternalIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

async function githubIdentity(accessToken: string): Promise<ExternalIdentity> {
  const headers = { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "sugi.moe" };
  const [userRes, emailsRes] = await Promise.all([fetch("https://api.github.com/user", { headers }), fetch("https://api.github.com/user/emails", { headers })]);
  if (!userRes.ok) throw new HttpError(502, "GitHub did not return the account");
  const user = await userRes.json<{ id: number; login: string; name: string | null }>();
  const emails = emailsRes.ok ? await emailsRes.json<{ email: string; primary: boolean; verified: boolean }[]>() : [];
  const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified) ?? null;
  return { subject: String(user.id), email: primary?.email ?? null, emailVerified: Boolean(primary), name: user.name || user.login };
}

function googleIdentity(idToken: string): ExternalIdentity {
  // The ID token comes straight from Google's token endpoint over TLS, so its claims can be read without verifying the signature (OpenID Connect Core 3.1.3.7).
  const claims = decodeIdToken(idToken) as { sub: string; email?: string; email_verified?: boolean; name?: string };
  return { subject: claims.sub, email: claims.email ?? null, emailVerified: claims.email_verified === true, name: claims.name ?? null };
}

function fail(env: Env, reason: string): Response {
  return new Response(null, { status: 302, headers: { location: `${env.MAIN_ORIGIN}/login?error=${reason}`, "set-cookie": cookie(OAUTH_COOKIE, "", 0, "/auth"), "cache-control": "no-store" } });
}

// GET /auth/github/callback, /auth/google/callback
export async function handleOAuthCallback(request: Request, env: Env, p: Provider): Promise<Response> {
  if (!accountsOn(env) || !providerConfigured(env, p)) throw new HttpError(404, "not found");
  const url = new URL(request.url);
  const [cp, state, verifier, next] = (readCookies(request).get(OAUTH_COOKIE) ?? "").split(".");
  const code = url.searchParams.get("code");
  if (!code || !state || cp !== p || url.searchParams.get("state") !== state) return fail(env, "oauth");
  let identity: ExternalIdentity;
  try {
    if (p === "github") {
      const tokens = await new GitHub(env.GITHUB_CLIENT_ID!, env.GITHUB_CLIENT_SECRET!, callback(env, p)).validateAuthorizationCode(code);
      identity = await githubIdentity(tokens.accessToken());
    } else {
      const tokens = await new Google(env.GOOGLE_CLIENT_ID!, env.GOOGLE_CLIENT_SECRET!, callback(env, p)).validateAuthorizationCode(code, verifier);
      identity = googleIdentity(tokens.idToken());
    }
  } catch {
    return fail(env, "oauth");
  }
  const current = await resolvePrincipal(request, env);
  let userId: string;
  try {
    userId = (await loginWithIdentity(env, p, identity.subject, identity.email, identity.emailVerified, identity.name, current)).id;
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) return fail(env, "taken");
    throw err;
  }
  const headers = new Headers({ location: `${env.MAIN_ORIGIN}${safeNext(decodeURIComponent(next ?? ""))}`, "cache-control": "no-store" });
  headers.append("set-cookie", cookie(OAUTH_COOKIE, "", 0, "/auth"));
  if (!current) headers.append("set-cookie", await createSession(env, userId, p));
  return new Response(null, { status: 302, headers });
}
