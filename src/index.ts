import { handleAlbumCreate, handleAlbumDelete, handleAlbumGet } from "./albums";
import { handleChunkAbort, handleChunkComplete, handleChunkCreate, handleChunkPart } from "./chunked";
import { handleFileDelete, handleFileInfo, handleFileServe, handleUploadPost, handleUploadPut, sweepExpired } from "./files";
import { errorResponse, HttpError, methodNotAllowed } from "./http";
import { handleInfo, handleLegacyDelete, handleLegacyServe, handleLegacyUpload, handlePurgeBySource, LEGACY_KEY_RE } from "./legacy";
import { LEGACY_MAX_BYTES } from "./limits";
import { handleSite } from "./site";

/** Size limit of the legacy /upload endpoint (kept as the module's export for existing callers and tests). */
export const MAX_BYTES = LEGACY_MAX_BYTES;

const ADMIN_KEY_RE = /^(?:[0-9a-f]{16}\.(?:png|jpg|webp|gif)|[ft]\/[a-z0-9-]{1,64})$/;

function hostOf(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

// files.sugi.moe and tmp.sugi.moe serve uploaded files and nothing else.
async function routeFileHost(request: Request, env: Env, temporary: boolean): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") throw methodNotAllowed("GET, HEAD");
  if (pathname === "/") return Response.redirect(env.MAIN_ORIGIN + "/", 302);
  if (pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
  return handleFileServe(request, env, temporary, pathname.slice(1));
}

async function serveStatic(request: Request, env: Env, pathname: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") throw methodNotAllowed("GET, HEAD");
  const res = await env.ASSETS.fetch(request);
  if (res.status === 404) throw new HttpError(404, "not found");
  const out = new Response(res.body, res);
  out.headers.set("x-content-type-options", "nosniff");
  // Build output carries a content hash in its file name; everything else may change in place.
  out.headers.set("cache-control", pathname.startsWith("/static/build/") ? "public, max-age=31536000, immutable" : "public, max-age=86400");
  return out;
}

async function routeApi(request: Request, env: Env, pathname: string): Promise<Response> {
  const method = request.method;
  if (pathname === "/api/upload") {
    if (method === "POST") return handleUploadPost(request, env);
    if (method === "PUT") return handleUploadPut(request, env);
    throw methodNotAllowed("POST, PUT");
  }
  if (pathname === "/api/uploads") {
    if (method === "POST") return handleChunkCreate(request, env);
    if (method === "DELETE") return handleChunkAbort(request, env);
    throw methodNotAllowed("POST, DELETE");
  }
  if (pathname === "/api/uploads/complete") {
    if (method === "POST") return handleChunkComplete(request, env);
    throw methodNotAllowed("POST");
  }
  const part = /^\/api\/uploads\/(\d{1,5})$/.exec(pathname);
  if (part) {
    if (method === "PUT") return handleChunkPart(request, env, Number(part[1]));
    throw methodNotAllowed("PUT");
  }
  const file = /^\/api\/files\/([^/]+)$/.exec(pathname);
  if (file) {
    if (method === "GET") return handleFileInfo(env, file[1]);
    if (method === "DELETE") return handleFileDelete(request, env, file[1]);
    throw methodNotAllowed("GET, DELETE");
  }
  if (pathname === "/api/albums") {
    if (method === "POST") return handleAlbumCreate(request, env);
    throw methodNotAllowed("POST");
  }
  const album = /^\/api\/albums\/([^/]+)$/.exec(pathname);
  if (album) {
    if (method === "GET") return handleAlbumGet(env, album[1]);
    if (method === "DELETE") return handleAlbumDelete(request, env, album[1]);
    throw methodNotAllowed("GET, DELETE");
  }
  throw new HttpError(404, "no such endpoint");
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;
  const host = url.hostname;
  if (host === hostOf(env.FILES_ORIGIN)) return routeFileHost(request, env, false);
  if (host === hostOf(env.TMP_ORIGIN)) return routeFileHost(request, env, true);

  if (pathname.startsWith("/static/")) return serveStatic(request, env, pathname);
  if (pathname === "/favicon.ico") return Response.redirect(new URL("/static/favicon.svg", url).toString(), 301);
  if (pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /api/\nDisallow: /admin/\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
  if (pathname.startsWith("/api/")) return routeApi(request, env, pathname);
  if (pathname === "/upload") {
    if (method === "POST" || method === "PUT") return handleLegacyUpload(request, env);
    throw methodNotAllowed("POST, PUT");
  }
  if (pathname === "/admin/purge-by-source") {
    if (method === "POST") return handlePurgeBySource(request, env);
    throw methodNotAllowed("POST");
  }
  if (pathname.startsWith("/admin/info/")) {
    const key = pathname.slice("/admin/info/".length);
    if (!ADMIN_KEY_RE.test(key)) throw new HttpError(404, "not found");
    if (method === "GET") return handleInfo(request, env, key);
    throw methodNotAllowed("GET");
  }
  const key = pathname.slice(1);
  if (LEGACY_KEY_RE.test(key)) {
    if (method === "GET" || method === "HEAD") return handleLegacyServe(request, env, key);
    if (method === "DELETE") return handleLegacyDelete(request, env, key);
    throw methodNotAllowed("GET, HEAD, DELETE");
  }
  if (method === "GET" || method === "HEAD") return handleSite(request, env, pathname);
  if (pathname === "/") throw methodNotAllowed("GET, HEAD");
  throw new HttpError(404, "not found");
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(request, err);
      throw err;
    }
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(sweepExpired(env).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
