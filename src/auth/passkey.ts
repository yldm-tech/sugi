// Passkeys (WebAuthn) via @simplewebauthn/server. Logging in uses discoverable credentials, so no user name is needed. Registering works both for a logged-in account (adds a passkey) and for a visitor without an account (creates a passkey-only account).
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture, RegistrationResponseJSON } from "@simplewebauthn/server";
import { HttpError, jsonResponse } from "../http";
import { base64url, randomId } from "../ids";
import { accountsOn, cookie, createSession, createUser, displayName, getUser, readCookies, resolvePrincipal, sameOrigin } from "./core";

const CHALLENGE_COOKIE = "sugi_chal";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function rp(env: Env): { rpID: string; origin: string } {
  return { rpID: new URL(env.MAIN_ORIGIN).hostname, origin: env.MAIN_ORIGIN };
}

function guard(request: Request, env: Env) {
  if (!accountsOn(env)) throw new HttpError(404, "not found");
  if (!sameOrigin(request, env)) throw new HttpError(403, "cross-site request refused");
}

async function saveChallenge(env: Env, challenge: string, kind: "login" | "register", userId: string | null): Promise<string> {
  const id = randomId(16);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").bind(now),
    env.DB.prepare("INSERT INTO auth_challenges (id, challenge, kind, user_id, expires_at) VALUES (?, ?, ?, ?, ?)").bind(id, challenge, kind, userId, now + CHALLENGE_TTL_MS),
  ]);
  return cookie(CHALLENGE_COOKIE, id, CHALLENGE_TTL_MS / 1000, "/auth/passkey");
}

async function takeChallenge(request: Request, env: Env, kind: "login" | "register"): Promise<{ challenge: string; user_id: string | null }> {
  const id = readCookies(request).get(CHALLENGE_COOKIE);
  if (!id) throw new HttpError(400, "no passkey challenge; start again");
  const row = await env.DB.prepare("DELETE FROM auth_challenges WHERE id = ? AND kind = ? AND expires_at > ? RETURNING challenge, user_id").bind(id, kind, Date.now()).first<{ challenge: string; user_id: string | null }>();
  if (!row) throw new HttpError(400, "the passkey challenge expired; start again");
  return row;
}

// POST /auth/passkey/login/options
export async function handlePasskeyLoginOptions(request: Request, env: Env): Promise<Response> {
  guard(request, env);
  const options = await generateAuthenticationOptions({ rpID: rp(env).rpID, userVerification: "preferred" });
  return jsonResponse(options, 200, { "set-cookie": await saveChallenge(env, options.challenge, "login", null) });
}

// POST /auth/passkey/login/verify
export async function handlePasskeyLoginVerify(request: Request, env: Env): Promise<Response> {
  guard(request, env);
  const { challenge } = await takeChallenge(request, env, "login");
  const response = (await request.json().catch(() => null)) as AuthenticationResponseJSON | null;
  if (!response?.id) throw new HttpError(400, "missing passkey response");
  const row = await env.DB.prepare("SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE id = ?").bind(response.id).first<{ id: string; user_id: string; public_key: ArrayBuffer; counter: number; transports: string | null }>();
  if (!row) throw new HttpError(404, "this passkey is not registered with sugi");
  const { rpID, origin } = rp(env);
  let verified = false;
  let newCounter = row.counter;
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: (row.transports ? JSON.parse(row.transports) : undefined) as AuthenticatorTransportFuture[] | undefined },
    });
    verified = result.verified;
    newCounter = result.authenticationInfo.newCounter;
  } catch {
    verified = false;
  }
  if (!verified) throw new HttpError(401, "passkey check failed");
  await env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").bind(newCounter, Date.now(), row.id).run();
  return jsonResponse({ ok: true }, 200, { "set-cookie": await createSession(env, row.user_id, "passkey") });
}

// POST /auth/passkey/register/options
export async function handlePasskeyRegisterOptions(request: Request, env: Env): Promise<Response> {
  guard(request, env);
  const current = await resolvePrincipal(request, env);
  const userId = current?.user.id ?? randomId(12);
  const existing = current ? (await env.DB.prepare("SELECT id, transports FROM passkeys WHERE user_id = ?").bind(userId).all<{ id: string; transports: string | null }>()).results : [];
  const label = current ? current.user.email ?? displayName(current.user) : `sugi-${userId.slice(0, 6)}`;
  const options = await generateRegistrationOptions({
    rpName: "sugi.moe",
    rpID: rp(env).rpID,
    userName: label,
    userDisplayName: label,
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  return jsonResponse(options, 200, { "set-cookie": await saveChallenge(env, options.challenge, "register", userId) });
}

// POST /auth/passkey/register/verify
export async function handlePasskeyRegisterVerify(request: Request, env: Env): Promise<Response> {
  guard(request, env);
  const { challenge, user_id } = await takeChallenge(request, env, "register");
  const response = (await request.json().catch(() => null)) as RegistrationResponseJSON | null;
  if (!response?.id || !user_id) throw new HttpError(400, "missing passkey response");
  const { rpID, origin } = rp(env);
  let info;
  try {
    const result = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID });
    if (!result.verified) throw new Error("not verified");
    info = result.registrationInfo;
  } catch {
    throw new HttpError(400, "passkey registration failed");
  }
  const current = await resolvePrincipal(request, env);
  if (current && current.user.id !== user_id) throw new HttpError(409, "you logged in as someone else meanwhile; start again");
  const isNew = !(await getUser(env, user_id));
  if (isNew) await createUser(env, null, null, user_id);
  const cred = info.credential;
  await env.DB.prepare("INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(cred.id, user_id, cred.publicKey, cred.counter, cred.transports ? JSON.stringify(cred.transports) : null, info.credentialDeviceType === "multiDevice" ? "synced passkey" : "device passkey", Date.now())
    .run();
  const extra: Record<string, string> = {};
  if (!current) extra["set-cookie"] = await createSession(env, user_id, "passkey");
  return jsonResponse({ ok: true, created_account: isNew }, 200, extra);
}

export { base64url };
