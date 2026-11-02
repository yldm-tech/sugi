// Albums ("打包链接"): an ordered set of uploaded files behind https://sugi.moe/a/<id>. Metadata lives in D1; the files themselves stay where they are, and deleting an album never deletes its files.
import { constantTimeEqual, sha256Hex } from "./crypto";
import { describe, fileKey, publicInfo, type StoredFile } from "./files";
import { ownAlbum, ownsAlbum, resolvePrincipal } from "./auth/core";
import { authorizeUpload, HttpError, isAdmin, jsonResponse, wantsJson, textResponse, type Uploader } from "./http";
import { albumDeleteToken, isFileId, randomId } from "./ids";
import { ALBUM_MAX_FILES, ALBUM_TITLE_MAX } from "./limits";
import { assertAlbumNotRemoved, isTombstone, takedown } from "./moderation";

export interface Album {
  id: string;
  title: string;
  created_at: number;
  files: StoredFile[];
}

export function albumUrl(env: Env, id: string): string {
  return `${env.MAIN_ORIGIN}/a/${id}`;
}

function cleanTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return Array.from(
    raw
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
      .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, ALBUM_TITLE_MAX)
    .join("");
}

async function readInput(request: Request): Promise<{ files: string[]; title: unknown }> {
  const ct = request.headers.get("content-type") ?? "";
  let filesRaw: unknown;
  let titleRaw: unknown;
  if (ct.includes("application/json")) {
    let body: { files?: unknown; title?: unknown };
    try {
      body = await request.json();
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
    filesRaw = body.files;
    titleRaw = body.title;
  } else {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new HttpError(400, 'expected form fields "files" and optional "title", or a JSON body');
    }
    filesRaw = form.getAll("files").flatMap((v) => (typeof v === "string" ? v.split(",") : []));
    titleRaw = form.get("title");
  }
  const list = (Array.isArray(filesRaw) ? filesRaw : typeof filesRaw === "string" ? filesRaw.split(",") : []).map((v) => (typeof v === "string" ? v : ""));
  return { files: list, title: titleRaw };
}

// POST /api/albums
export interface CreatedAlbum {
  id: string;
  url: string;
  title: string;
  files: number;
  delete_token: string;
}

/** Validates the file ids and stores the album. Shared by the HTTP API and the MCP tool. */
export async function createAlbum(env: Env, uploader: Uploader, rawIds: string[], rawTitle: unknown): Promise<CreatedAlbum> {
  // Accept bare ids as well as full links such as https://files.sugi.moe/<id>.png.
  const files = [
    ...new Set(
      rawIds
        .map((v) =>
          v
            .trim()
            .replace(/^.*\//, "")
            .replace(/\.[a-z0-9]+$/i, ""),
        )
        .filter(Boolean),
    ),
  ];
  const title = cleanTitle(rawTitle);
  if (files.length === 0) throw new HttpError(400, 'give at least one file id in "files"');
  if (files.length > ALBUM_MAX_FILES) throw new HttpError(400, `an album holds at most ${ALBUM_MAX_FILES} files`);
  const keys: string[] = [];
  for (const id of files) {
    if (!isFileId(id)) throw new HttpError(400, `not a file id: ${id}`);
    const heads = await Promise.all([env.BUCKET.head(fileKey(id, false)), env.BUCKET.head(fileKey(id, true))]);
    const [perm, tmp] = heads.map((o) => (isTombstone(o) ? null : o));
    if (!perm && !tmp) throw new HttpError(404, `file not found: ${id}`);
    keys.push(fileKey(id, !perm));
  }
  let id = randomId();
  // Ids of taken-down albums are never handed out again.
  for (
    let i = 0;
    i < 5 && (await env.DB.prepare("SELECT 1 FROM albums WHERE id = ? UNION SELECT 1 FROM tombstones WHERE target = ?").bind(id, `album:${id}`).first());
    i++
  )
    id = randomId();
  const token = albumDeleteToken();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO albums (id, title, created_at, delete_hash, source) VALUES (?, ?, ?, ?, ?)").bind(
      id,
      title,
      Date.now(),
      await sha256Hex(new TextEncoder().encode(token)),
      uploader.source,
    ),
    ...keys.map((k, i) => env.DB.prepare("INSERT INTO album_files (album_id, position, file_key) VALUES (?, ?, ?)").bind(id, i, k)),
  ]);
  await ownAlbum(env, uploader.userId, id);
  return { id, url: albumUrl(env, id), title, files: files.length, delete_token: token };
}

// POST /api/albums
export async function handleAlbumCreate(request: Request, env: Env): Promise<Response> {
  const uploader = await authorizeUpload(request, env, "album");
  const { files, title } = await readInput(request);
  const album = await createAlbum(env, uploader, files, title);
  if (!wantsJson(request)) return textResponse(album.url, 201);
  return jsonResponse(album, 201);
}

// Loads an album with the files that still exist (deleted and expired ones are skipped).
export async function loadAlbum(env: Env, id: string, now = Date.now()): Promise<Album | null> {
  if (!/^[a-z0-9]{8}$/.test(id)) return null;
  const row = await env.DB.prepare("SELECT id, title, created_at FROM albums WHERE id = ?").bind(id).first<{ id: string; title: string; created_at: number }>();
  if (!row) return null;
  const { results } = await env.DB.prepare("SELECT file_key FROM album_files WHERE album_id = ? ORDER BY position").bind(id).all<{ file_key: string }>();
  const heads = await Promise.all(results.map(async (r) => [r.file_key, await env.BUCKET.head(r.file_key)] as const));
  const files = heads.flatMap(([key, obj]) => {
    const f = obj && describe(key, obj);
    return f && (f.expires === null || f.expires > now) ? [f] : [];
  });
  return { id: row.id, title: row.title, created_at: row.created_at, files };
}

// GET /api/albums/:id
export async function handleAlbumGet(env: Env, id: string): Promise<Response> {
  const album = await loadAlbum(env, id);
  if (!album) {
    await assertAlbumNotRemoved(env, id);
    throw new HttpError(404, "not found");
  }
  return jsonResponse({
    id: album.id,
    url: albumUrl(env, album.id),
    title: album.title,
    created_at: new Date(album.created_at).toISOString(),
    files: album.files.map((f) => publicInfo(env, f)),
  });
}

// DELETE /api/albums/:id with `Sugi-Token: <delete_token>` (or the admin bearer token, which makes it a takedown). Files are left alone.
export async function handleAlbumDelete(request: Request, env: Env, id: string): Promise<Response> {
  const row = /^[a-z0-9]{8}$/.test(id) ? await env.DB.prepare("SELECT delete_hash FROM albums WHERE id = ?").bind(id).first<{ delete_hash: string }>() : null;
  if (!row) throw new HttpError(404, "not found");
  const admin = await isAdmin(request, env);
  if (admin) {
    const reason = new URL(request.url).searchParams.get("reason") ?? "admin DELETE /api/albums";
    await takedown(env, `a/${id}`, { reason, via: "http" });
    return jsonResponse({ deleted: [id] });
  }
  const token = request.headers.get("sugi-token");
  if (token) {
    if (!(await constantTimeEqual(await sha256Hex(new TextEncoder().encode(token)), row.delete_hash))) throw new HttpError(403, "wrong delete token");
  } else {
    // Signed-in owners may delete their albums without the token.
    const principal = await resolvePrincipal(request, env);
    if (!principal) throw new HttpError(401, "missing Sugi-Token header (the delete_token returned when the album was created)");
    if (!(await ownsAlbum(env, principal.user.id, id))) throw new HttpError(403, "this album does not belong to your account");
  }
  await env.DB.batch([env.DB.prepare("DELETE FROM album_files WHERE album_id = ?").bind(id), env.DB.prepare("DELETE FROM albums WHERE id = ?").bind(id)]);
  return jsonResponse({ deleted: [id] });
}
