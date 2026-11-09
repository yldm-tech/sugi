// Sessions of the admin dashboard. Signing in with ADMIN_TOKEN, or with a personal API token whose role is "admin", gives an HttpOnly, SameSite=Strict cookie scoped to the admin origin (its own host, or the /_admin path on the main host). The session keeps the SHA-256 of the token it was opened with and checks it again on every request, so rotating ADMIN_TOKEN or revoking the personal token ends its sessions at once.
import { sha256Hex } from "../crypto";
import { readCookies, secret } from "../auth/core";
import { adminTokenLabel, HttpError } from "../http";

export const ADMIN_COOKIE = "sugi_admin";
export const ADMIN_SESSION_TTL_MS = 12 * 3600e3;

export interface AdminSession {
  idHash: string;
  /** Which token the session was opened with, shown in the header. */
  label: string;
  /** SHA-256 of the token the session was opened with. */
  tokenHash: string;
  expiresAt: number;
}

const hash = (s: string) => sha256Hex(new TextEncoder().encode(s));

/** Where the dashboard lives: the admin origin's own origin and its path prefix ("" on a dedicated host, "/_admin" when mounted on the main host). */
export function adminBase(env: Env): { origin: string; prefix: string } {
  const u = new URL(env.ADMIN_ORIGIN);
  return { origin: u.origin, prefix: u.pathname.replace(/\/$/, "") };
}

export function adminCookie(env: Env, name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=${adminBase(env).prefix || "/"}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

/** Signs in with an admin token; returns the Set-Cookie value, or null when the token is not an admin token. */
export async function openAdminSession(env: Env, token: string, now = Date.now()): Promise<string | null> {
  const label = await adminTokenLabel(env, token);
  if (!label) return null;
  const id = secret();
  await env.DB.prepare("INSERT INTO admin_sessions (id_hash, token_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await hash(id), await hash(token), label, now, now + ADMIN_SESSION_TTL_MS)
    .run();
  return adminCookie(env, ADMIN_COOKIE, id, ADMIN_SESSION_TTL_MS / 1000);
}

/** The token a session was opened with still grants admin: it is the current ADMIN_TOKEN, or a personal token still marked admin (with accounts and tokens still on). */
async function tokenStillAdmin(env: Env, tokenHash: string): Promise<boolean> {
  if (env.ADMIN_TOKEN && (await hash(env.ADMIN_TOKEN)) === tokenHash) return true;
  if (env.FEATURE_ACCOUNTS !== "1" || !(env.ACCOUNT_FEATURES ?? "").split(",").some((f) => f.trim() === "tokens")) return false;
  const row = await env.DB.prepare("SELECT role FROM api_tokens WHERE token_hash = ?").bind(tokenHash).first<{ role: string }>();
  return row?.role === "admin";
}

export async function readAdminSession(request: Request, env: Env, now = Date.now()): Promise<AdminSession | null> {
  const id = readCookies(request).get(ADMIN_COOKIE);
  if (!id) return null;
  const idHash = await hash(id);
  const row = await env.DB.prepare("SELECT token_hash, label, expires_at FROM admin_sessions WHERE id_hash = ? AND expires_at > ?")
    .bind(idHash, now)
    .first<{ token_hash: string; label: string; expires_at: number }>();
  if (!row) return null;
  if (!(await tokenStillAdmin(env, row.token_hash))) {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE id_hash = ?").bind(idHash).run();
    return null;
  }
  return { idHash, label: row.label, tokenHash: row.token_hash, expiresAt: row.expires_at };
}

export async function closeAdminSession(env: Env, session: AdminSession): Promise<string> {
  await env.DB.prepare("DELETE FROM admin_sessions WHERE id_hash = ?").bind(session.idHash).run();
  return adminCookie(env, ADMIN_COOKIE, "", 0);
}

/** Every write must come from the dashboard's own pages (the cookie is SameSite=Strict as well). */
export function assertAdminOrigin(request: Request, env: Env): void {
  const origin = request.headers.get("origin");
  if (origin && (origin === adminBase(env).origin || origin === new URL(request.url).origin)) return;
  throw new HttpError(403, "cross-site request refused");
}

/** Cron: drop expired sessions. */
export async function sweepAdminSessions(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").bind(now).run();
}
