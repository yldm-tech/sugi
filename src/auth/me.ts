// Account endpoints that are live: who am I, and logging out. Further endpoints (my files and albums, claiming earlier uploads, API tokens, passkeys, deleting the account) are developed on the accounts branch and arrive with their ACCOUNT_FEATURES.
import { purgeCache } from "../cache";
import { HttpError, jsonResponse } from "../http";
import { clearSessionCookie, displayName, type Principal, requirePrincipal, sameOrigin } from "./core";

export async function meSummary(_env: Env, p: Principal) {
  return {
    id: p.user.id,
    email: p.user.email,
    name: displayName(p.user),
    created_at: new Date(p.user.created_at).toISOString(),
    via: p.method,
  };
}

// GET /api/me
export async function handleMe(request: Request, env: Env): Promise<Response> {
  return jsonResponse(await meSummary(env, await requirePrincipal(request, env)));
}

// DELETE /api/me/passkeys/:id, from the account page.
export async function handleDeletePasskey(request: Request, env: Env, id: string): Promise<Response> {
  const p = await requirePrincipal(request, env);
  if (p.via !== "session" || !sameOrigin(request, env)) throw new HttpError(403, "manage passkeys from the website");
  const r = await env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?").bind(id, p.user.id).run();
  if (!r.meta.changes) throw new HttpError(404, "not found");
  return jsonResponse({ deleted: [id] });
}

// DELETE /api/me {"delete_files": true|false}: removes the account, its logins, passkeys, sessions and tokens; with delete_files also every file and album it owns.
export async function handleDeleteAccount(request: Request, env: Env): Promise<Response> {
  const p = await requirePrincipal(request, env);
  if (p.via !== "session") throw new HttpError(403, "delete the account from the website");
  if (!sameOrigin(request, env)) throw new HttpError(403, "cross-site request refused");
  const body = (await request.json().catch(() => ({}))) as { delete_files?: unknown };
  let deletedFiles = 0;
  let cachePurged = true;
  if (body.delete_files === true) {
    const { results } = await env.DB.prepare("SELECT file_key FROM user_files WHERE user_id = ?").bind(p.user.id).all<{ file_key: string }>();
    const keys = results.map((r) => r.file_key);
    for (let i = 0; i < keys.length; i += 1000) await env.BUCKET.delete(keys.slice(i, i + 1000));
    deletedFiles = keys.length;
    cachePurged = await purgeCache(env, keys);
    const { results: albums } = await env.DB.prepare("SELECT album_id FROM user_albums WHERE user_id = ?").bind(p.user.id).all<{ album_id: string }>();
    if (albums.length)
      await env.DB.batch(
        albums.flatMap((a) => [
          env.DB.prepare("DELETE FROM album_files WHERE album_id = ?").bind(a.album_id),
          env.DB.prepare("DELETE FROM albums WHERE id = ?").bind(a.album_id),
        ]),
      );
  }
  // Child rows are removed explicitly as well as by ON DELETE CASCADE, so nothing depends on foreign key enforcement.
  await env.DB.batch(
    ["user_files", "user_albums", "api_tokens", "passkeys", "sessions", "identities"]
      .map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(p.user.id))
      .concat(env.DB.prepare("DELETE FROM users WHERE id = ?").bind(p.user.id)),
  );
  return jsonResponse({ deleted: true, deleted_files: deletedFiles, cache_purged: cachePurged }, 200, { "set-cookie": clearSessionCookie() });
}

// POST /auth/logout
export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const p = await requirePrincipal(request, env).catch(() => null);
  if (p?.sessionHash) {
    if (!sameOrigin(request, env)) throw new HttpError(403, "cross-site request refused");
    await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(p.sessionHash).run();
  }
  const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
  if (wantsHtml) return new Response(null, { status: 303, headers: { location: `${env.MAIN_ORIGIN}/`, "set-cookie": clearSessionCookie() } });
  return jsonResponse({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}
