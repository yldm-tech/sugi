// Accounts (FEATURE_ACCOUNTS): users, sessions, API tokens, and who owns which upload. Every secret handed to a browser or a client (session cookie, API token, magic link token) is stored only as its SHA-256.
import { sha256Hex } from "../crypto";
import { bearerToken, HttpError } from "../http";
import { base64url, randomId } from "../ids";

export const SESSION_COOKIE = "sugi_session";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const API_TOKEN_PREFIX = "sugi_";

export interface User {
  id: string;
  email: string | null;
  name: string | null;
  created_at: number;
}

export interface Principal {
  user: User;
  /** How this request is authenticated. */
  via: "session" | "token";
  /** Login method of the session ("email", "github", "google", "passkey"); null for API tokens. */
  method: string | null;
  sessionHash: string | null;
}

export function accountsOn(env: Env): boolean {
  return env.FEATURE_ACCOUNTS === "1";
}

/** A live account feature (ACCOUNT_FEATURES): email, github, google, passkey, sync, tokens. */
export function accountFeature(env: Env, name: string): boolean {
  return accountsOn(env) && (env.ACCOUNT_FEATURES ?? "").split(",").some((s) => s.trim() === name);
}

export function secret(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hashSecret(s: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(s));
}

export function readCookies(request: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, maxAge: number, path = "/"): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/** Browsers send Origin on every cross-site write; a cookie-authenticated write is only honoured when it comes from our own pages. */
export function sameOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return origin === env.MAIN_ORIGIN || origin === new URL(request.url).origin;
}

export function isWrite(request: Request): boolean {
  return request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
}

export async function createSession(env: Env, userId: string, method: string): Promise<string> {
  const token = secret();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id_hash, user_id, via, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await hashSecret(token), userId, method, now, now + SESSION_TTL_MS)
    .run();
  return cookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1000);
}

export function clearSessionCookie(): string {
  return cookie(SESSION_COOKIE, "", 0);
}

const USER_COLUMNS = "u.id AS id, u.email AS email, u.name AS name, u.created_at AS created_at";

/**
 * Who is making this request: an API token (`Authorization: Bearer sugi_…`) or the session cookie. Cookie sessions only count for writes that come from our own origin. Returns null for anonymous requests; throws 401 for an API token that does not exist.
 */
export async function resolvePrincipal(request: Request, env: Env): Promise<Principal | null> {
  if (!accountsOn(env)) return null;
  const bearer = bearerToken(request);
  if (bearer?.startsWith(API_TOKEN_PREFIX) && accountFeature(env, "tokens")) {
    const hash = await hashSecret(bearer);
    const row = await env.DB.prepare(
      `SELECT ${USER_COLUMNS}, t.id AS token_id, t.last_used_at AS last_used_at FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
    )
      .bind(hash)
      .first<User & { token_id: string; last_used_at: number | null }>();
    if (!row) throw new HttpError(401, "invalid API token", { "www-authenticate": 'Bearer realm="sugi"' });
    // Record use at most once an hour to keep writes down.
    if (!row.last_used_at || Date.now() - row.last_used_at > 3600e3)
      await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(Date.now(), row.token_id).run();
    return { user: { id: row.id, email: row.email, name: row.name, created_at: row.created_at }, via: "token", method: null, sessionHash: null };
  }
  const token = readCookies(request).get(SESSION_COOKIE);
  if (!token) return null;
  if (isWrite(request) && !sameOrigin(request, env)) return null;
  const hash = await hashSecret(token);
  const row = await env.DB.prepare(
    `SELECT ${USER_COLUMNS}, s.via AS via FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?`,
  )
    .bind(hash, Date.now())
    .first<User & { via: string }>();
  if (!row) return null;
  return { user: { id: row.id, email: row.email, name: row.name, created_at: row.created_at }, via: "session", method: row.via, sessionHash: hash };
}

export async function requirePrincipal(request: Request, env: Env): Promise<Principal> {
  if (!accountsOn(env)) throw new HttpError(404, "not found");
  const p = await resolvePrincipal(request, env);
  if (!p) throw new HttpError(401, "log in first");
  return p;
}

export function displayName(user: User): string {
  return user.name || (user.email ? user.email.split("@")[0] : "sugi");
}

export async function createUser(env: Env, email: string | null, name: string | null, id = randomId(12)): Promise<User> {
  const user: User = { id, email, name, created_at: Date.now() };
  await env.DB.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").bind(user.id, user.email, user.name, user.created_at).run();
  return user;
}

export async function getUser(env: Env, id: string): Promise<User | null> {
  return env.DB.prepare("SELECT id, email, name, created_at FROM users WHERE id = ?").bind(id).first<User>();
}

/**
 * Finds or creates the account for an external identity. Order: an existing identity wins; otherwise the identity is linked to the account the visitor is already logged in to; otherwise to the account with the same verified email; otherwise a new account is created.
 */
export async function loginWithIdentity(
  env: Env,
  provider: string,
  subject: string,
  email: string | null,
  emailVerified: boolean,
  name: string | null,
  current: Principal | null,
): Promise<User> {
  const known = await env.DB.prepare("SELECT user_id FROM identities WHERE provider = ? AND subject = ?").bind(provider, subject).first<{ user_id: string }>();
  if (known) {
    if (current && current.user.id !== known.user_id) throw new HttpError(409, "that login already belongs to another sugi account");
    return (await getUser(env, known.user_id))!;
  }
  const verifiedEmail = emailVerified && email ? email.toLowerCase() : null;
  let user: User | null = current?.user ?? null;
  if (!user && verifiedEmail) user = await env.DB.prepare("SELECT id, email, name, created_at FROM users WHERE email = ?").bind(verifiedEmail).first<User>();
  if (!user) {
    const taken = verifiedEmail ? await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(verifiedEmail).first() : null;
    user = await createUser(env, taken ? null : verifiedEmail, name);
  } else if (!user.email && verifiedEmail && !(await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(verifiedEmail).first())) {
    await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind(verifiedEmail, user.id).run();
    user.email = verifiedEmail;
  }
  if (!user.name && name) {
    await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, user.id).run();
    user.name = name;
  }
  await env.DB.prepare("INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(provider, subject, user.id, email, Date.now())
    .run();
  return user;
}

/** Records that an upload belongs to an account. */
export async function ownFile(env: Env, userId: string | undefined, key: string): Promise<void> {
  if (!userId) return;
  await env.DB.prepare("INSERT OR IGNORE INTO user_files (user_id, file_key, created_at) VALUES (?, ?, ?)").bind(userId, key, Date.now()).run();
}

export async function ownAlbum(env: Env, userId: string | undefined, albumId: string): Promise<void> {
  if (!userId) return;
  await env.DB.prepare("INSERT OR IGNORE INTO user_albums (user_id, album_id, created_at) VALUES (?, ?, ?)").bind(userId, albumId, Date.now()).run();
}

export async function ownsFile(env: Env, userId: string, key: string): Promise<boolean> {
  return Boolean(await env.DB.prepare("SELECT 1 FROM user_files WHERE user_id = ? AND file_key = ?").bind(userId, key).first());
}

export async function ownsAlbum(env: Env, userId: string, albumId: string): Promise<boolean> {
  return Boolean(await env.DB.prepare("SELECT 1 FROM user_albums WHERE user_id = ? AND album_id = ?").bind(userId, albumId).first());
}

/** Drops ownership rows for deleted objects. */
export async function forgetFiles(env: Env, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    await env.DB.prepare(`DELETE FROM user_files WHERE file_key IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .run();
  }
}
