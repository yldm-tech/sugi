// Account endpoints: who am I, my files and albums across devices (sync), claiming uploads made before logging in, passkey removal, deleting the account, and logging out.
import { purgeCache } from "../cache";
import { HttpError, jsonResponse } from "../http";
import { albumUrl } from "../albums";
import { constantTimeEqual, sha256Hex } from "../crypto";
import { describe, fileKey, publicInfo, tokenMatches } from "../files";
import { isFileId } from "../ids";
import { accountFeature, clearSessionCookie, displayName, forgetFiles, ownAlbum, ownFile, type Principal, requirePrincipal, sameOrigin } from "./core";

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

// GET /api/me/files: the account's files that still exist (missing ones are forgotten on the way).
export async function handleMyFiles(request: Request, env: Env): Promise<Response> {
  const p = await requirePrincipal(request, env);
  if (!accountFeature(env, "sync")) throw new HttpError(404, "not found");
  const { results } = await env.DB.prepare("SELECT file_key, created_at FROM user_files WHERE user_id = ? ORDER BY created_at DESC LIMIT 2000")
    .bind(p.user.id)
    .all<{ file_key: string; created_at: number }>();
  const now = Date.now();
  const files = [];
  const gone: string[] = [];
  for (let i = 0; i < results.length; i += 50) {
    const heads = await Promise.all(results.slice(i, i + 50).map(async (r) => [r.file_key, await env.BUCKET.head(r.file_key)] as const));
    for (const [key, obj] of heads) {
      const f = obj && describe(key, obj);
      if (!f) gone.push(key);
      else files.push({ ...publicInfo(env, f), expired: f.expires !== null && f.expires <= now });
    }
  }
  if (gone.length) await forgetFiles(env, gone);
  return jsonResponse({ files });
}

// GET /api/me/albums
export async function handleMyAlbums(request: Request, env: Env): Promise<Response> {
  const p = await requirePrincipal(request, env);
  if (!accountFeature(env, "sync")) throw new HttpError(404, "not found");
  const { results } = await env.DB.prepare(
    "SELECT a.id AS id, a.title AS title, a.created_at AS created_at, (SELECT COUNT(*) FROM album_files f WHERE f.album_id = a.id) AS files FROM user_albums ua JOIN albums a ON a.id = ua.album_id WHERE ua.user_id = ? ORDER BY a.created_at DESC",
  )
    .bind(p.user.id)
    .all<{ id: string; title: string; created_at: number; files: number }>();
  const albums = await Promise.all(
    results.map(async (a) => {
      const { results: keys } = await env.DB.prepare("SELECT file_key FROM album_files WHERE album_id = ? ORDER BY position LIMIT 3")
        .bind(a.id)
        .all<{ file_key: string }>();
      const covers = (await Promise.all(keys.map(async (k) => [k.file_key, await env.BUCKET.head(k.file_key)] as const))).flatMap(([key, obj]) => {
        const f = obj && describe(key, obj);
        return f && f.type.kind === "image" ? [publicInfo(env, f).url] : [];
      });
      return { id: a.id, url: albumUrl(env, a.id), title: a.title, created_at: new Date(a.created_at).toISOString(), files: a.files, covers };
    }),
  );
  return jsonResponse({ albums });
}

// POST /api/me/claim {"files": [{"id", "token"}], "albums": [{"id", "token"}]}: attaches uploads made before logging in, proven by their delete tokens.
export async function handleClaim(request: Request, env: Env): Promise<Response> {
  const p = await requirePrincipal(request, env);
  if (!accountFeature(env, "sync")) throw new HttpError(404, "not found");
  if (p.via === "session" && !sameOrigin(request, env)) throw new HttpError(403, "cross-site request refused");
  let body: { files?: unknown; albums?: unknown };
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "expected JSON");
  }
  const files = (Array.isArray(body.files) ? body.files : []).slice(0, MAX_CLAIM) as { id?: unknown; token?: unknown }[];
  const albums = (Array.isArray(body.albums) ? body.albums : []).slice(0, MAX_CLAIM) as { id?: unknown; token?: unknown }[];
  const claimed: string[] = [];
  const claimedAlbums: string[] = [];
  for (const f of files) {
    if (typeof f.id !== "string" || typeof f.token !== "string" || !isFileId(f.id)) continue;
    for (const temporary of [false, true]) {
      const key = fileKey(f.id, temporary);
      const obj = await env.BUCKET.head(key);
      if (obj && (await tokenMatches(obj, f.token))) {
        await ownFile(env, p.user.id, key);
        claimed.push(f.id);
        break;
      }
    }
  }
  for (const a of albums) {
    if (typeof a.id !== "string" || typeof a.token !== "string") continue;
    const row = await env.DB.prepare("SELECT delete_hash FROM albums WHERE id = ?").bind(a.id).first<{ delete_hash: string }>();
    if (row && (await constantTimeEqual(await sha256Hex(new TextEncoder().encode(a.token)), row.delete_hash))) {
      await ownAlbum(env, p.user.id, a.id);
      claimedAlbums.push(a.id);
    }
  }
  return jsonResponse({ files: claimed, albums: claimedAlbums });
}

const MAX_CLAIM = 500;

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
