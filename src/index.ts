import { handleAlbumCreate, handleAlbumDelete, handleAlbumGet } from "./albums";
import { handleChunkAbort, handleChunkComplete, handleChunkCreate, handleChunkPart } from "./chunked";
import { handleFileDelete, handleFileInfo, sweepExpired } from "./files";
import { handleFileServe } from "./serve";
import { handleUploadPost, handleUploadPut } from "./upload";
import { errorResponse, HttpError, methodNotAllowed } from "./http";
import { handleInfo, handleLegacyDelete, handleLegacyServe, handleLegacyUpload, handlePurgeBySource, LEGACY_KEY_RE } from "./legacy";
import { handleSite } from "./site";
import { withDefaults } from "./config";
import { ensureSchema } from "./migrate";
import { ICONS } from "./site/og-images";
import { fileHostRobotsTxt, robotsTxt, sitemapXml, webManifest } from "./site/seo";
import { eraseOldFingerprints } from "./moderation";
import { handleLinkUpload } from "./links";
import { installScript } from "./site/install";
import { handleMcp } from "./mcp";
import { checkAlerts, countOps, DAILY_REPORT_CRON, handleHealthz, sendDailyReport, sweepOps } from "./ops";
import { sweepUsage } from "./quota";
import { handleReport, notifyReports, sweepReports } from "./reports";
import { handleInboxRead, receiveEmail, sweepInbox } from "./inbox";
import { handleMagicRequest, handleMagicVerify } from "./auth/email";
import {
  handleClaim,
  handleCreateToken,
  handleDeleteAccount,
  handleDeleteToken,
  handleDeletePasskey,
  handleLogout,
  handleMe,
  handleMyAlbums,
  handleMyFiles,
} from "./auth/me";
import { handlePasskeyLoginOptions, handlePasskeyLoginVerify, handlePasskeyRegisterOptions, handlePasskeyRegisterVerify } from "./auth/passkey";
import { handleOAuthCallback, handleOAuthStart, type Provider } from "./auth/oauth";

// Only the default handler may be exported from this module: workerd treats every named export of the main module as an entrypoint.

const ADMIN_KEY_RE = /^(?:[0-9a-f]{16}\.(?:png|jpg|webp|gif)|[ft]\/[a-z0-9-]{1,64})$/;

// FILES_ORIGIN and TMP_ORIGIN are normally hostnames of their own (files.sugi.moe, tmp.sugi.moe) that serve uploaded files and nothing else. An origin with a path (e.g. http://localhost:8787/_files) is served under that path on any host instead, which is how local development works: `wrangler dev` rewrites every request's host to the first route.
function matchFileOrigin(env: Env, url: URL): { temporary: boolean; name: string; dedicatedHost: boolean } | null {
  for (const [origin, temporary] of [
    [env.FILES_ORIGIN, false],
    [env.TMP_ORIGIN, true],
  ] as const) {
    if (!origin) continue;
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      continue;
    }
    const prefix = o.pathname.replace(/\/$/, "");
    if (prefix) {
      if (url.pathname.startsWith(`${prefix}/`)) return { temporary, name: url.pathname.slice(prefix.length + 1), dedicatedHost: false };
    } else if (url.hostname === o.hostname) {
      return { temporary, name: url.pathname.slice(1), dedicatedHost: true };
    }
  }
  return null;
}

async function routeFileHost(request: Request, env: Env, m: { temporary: boolean; name: string; dedicatedHost: boolean }): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") throw methodNotAllowed("GET, HEAD");
  if (m.dedicatedHost && m.name === "") return Response.redirect(`${env.MAIN_ORIGIN}/`, 302);
  if (m.dedicatedHost && m.name === "robots.txt") return fileHostRobotsTxt();
  // Uploads are never meant to be found through search engines.
  const res = await handleFileServe(request, env, m.temporary, m.name).catch((err) => {
    if (err instanceof HttpError) return errorResponse(request, err);
    throw err;
  });
  const out = new Response(res.body, res);
  out.headers.set("x-robots-tag", "noindex");
  return out;
}

async function serveStatic(request: Request, env: Env, pathname: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") throw methodNotAllowed("GET, HEAD");
  const res = await env.ASSETS.fetch(request);
  if (res.status === 404) throw new HttpError(404, "not found");
  const out = new Response(res.body, res);
  out.headers.set("x-content-type-options", "nosniff");
  // Build output, OG images and icons carry a content hash in their file names. The CLI must match the hash in install.sh, so it is never cached.
  const hashed = pathname.startsWith("/static/build/") || pathname.startsWith("/static/og/") || pathname.startsWith("/static/icons/");
  out.headers.set("cache-control", hashed ? "public, max-age=31536000, immutable" : pathname.startsWith("/static/cli/") ? "no-cache" : "public, max-age=86400");
  if (pathname.startsWith("/static/cli/")) out.headers.set("content-type", "text/plain; charset=utf-8");
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
  const link = /^\/api\/upload\/([A-Za-z0-9_-]+\.[0-9a-f]{64})$/.exec(pathname);
  if (link) {
    if (method === "PUT" || method === "POST") return handleLinkUpload(request, env, link[1]);
    throw methodNotAllowed("PUT, POST");
  }
  const file = /^\/api\/files\/([^/]+)$/.exec(pathname);
  if (file) {
    if (method === "GET") return handleFileInfo(env, file[1]);
    if (method === "DELETE") return handleFileDelete(request, env, file[1]);
    throw methodNotAllowed("GET, DELETE");
  }
  if (pathname === "/api/me/files" || pathname === "/api/me/albums") {
    if (method === "GET") return pathname.endsWith("files") ? handleMyFiles(request, env) : handleMyAlbums(request, env);
    throw methodNotAllowed("GET");
  }
  if (pathname === "/api/me/claim") {
    if (method === "POST") return handleClaim(request, env);
    throw methodNotAllowed("POST");
  }
  if (pathname === "/api/me/tokens") {
    if (method === "POST") return handleCreateToken(request, env);
    throw methodNotAllowed("POST");
  }
  const myToken = /^\/api\/me\/tokens\/([a-z0-9]{10})$/.exec(pathname);
  if (myToken) {
    if (method === "DELETE") return handleDeleteToken(request, env, myToken[1]);
    throw methodNotAllowed("DELETE");
  }
  const myPasskey = /^\/api\/me\/passkeys\/([A-Za-z0-9_-]{1,512})$/.exec(pathname);
  if (myPasskey) {
    if (method === "DELETE") return handleDeletePasskey(request, env, myPasskey[1]);
    throw methodNotAllowed("DELETE");
  }
  if (pathname === "/api/me") {
    if (method === "GET") return handleMe(request, env);
    if (method === "DELETE") return handleDeleteAccount(request, env);
    throw methodNotAllowed("GET, DELETE");
  }
  if (pathname === "/api/reports") {
    if (method === "POST") return handleReport(request, env);
    throw methodNotAllowed("POST");
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
  const fileMatch = matchFileOrigin(env, url);
  if (fileMatch) return routeFileHost(request, env, fileMatch);

  if (pathname.startsWith("/static/")) return serveStatic(request, env, pathname);
  // Everything past this point may touch D1; make sure the schema exists (a no-op after the first request of an isolate).
  await ensureSchema(env.DB).catch(() => undefined);
  if (pathname === "/favicon.ico") return serveStatic(new Request(new URL(ICONS.png32, url), request), env, ICONS.png32);
  if (pathname === "/apple-touch-icon.png" || pathname === "/apple-touch-icon-precomposed.png")
    return serveStatic(new Request(new URL(ICONS.apple, url), request), env, ICONS.apple);
  if (pathname === "/robots.txt") return robotsTxt(env);
  if (pathname === "/healthz") return handleHealthz(env);
  if (pathname === "/sitemap.xml") return sitemapXml(env);
  if (pathname === "/manifest.webmanifest") return webManifest(env);
  if (pathname.startsWith("/api/")) return routeApi(request, env, pathname);
  if (env.FEATURE_CLI === "1") {
    if (pathname === "/mcp") return handleMcp(request, env);
    if (pathname === "/install.sh") {
      if (method !== "GET" && method !== "HEAD") throw methodNotAllowed("GET, HEAD");
      return new Response(method === "HEAD" ? null : installScript(env), {
        headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-cache" },
      });
    }
  }
  if (pathname === "/upload") {
    if (method === "POST" || method === "PUT") return handleLegacyUpload(request, env);
    throw methodNotAllowed("POST, PUT");
  }
  const passkey = /^\/auth\/passkey\/(login|register)\/(options|verify)$/.exec(pathname);
  if (passkey) {
    if (method !== "POST") throw methodNotAllowed("POST");
    if (passkey[1] === "login") return passkey[2] === "options" ? handlePasskeyLoginOptions(request, env) : handlePasskeyLoginVerify(request, env);
    return passkey[2] === "options" ? handlePasskeyRegisterOptions(request, env) : handlePasskeyRegisterVerify(request, env);
  }
  const oauth = /^\/auth\/(github|google)(\/callback)?$/.exec(pathname);
  if (oauth) {
    if (method !== "GET" && method !== "HEAD") throw methodNotAllowed("GET");
    const provider = oauth[1] as Provider;
    return oauth[2] ? handleOAuthCallback(request, env, provider) : handleOAuthStart(request, env, provider);
  }
  if (pathname === "/auth/email" || pathname === "/auth/email/verify" || pathname === "/auth/logout") {
    if (method === "POST")
      return pathname === "/auth/email"
        ? handleMagicRequest(request, env)
        : pathname === "/auth/logout"
          ? handleLogout(request, env)
          : handleMagicVerify(request, env);
    if (pathname !== "/auth/email/verify" || (method !== "GET" && method !== "HEAD")) throw methodNotAllowed("POST");
  }
  if (pathname === "/admin/e2e-inbox") {
    if (method === "GET") return handleInboxRead(request, env);
    throw methodNotAllowed("GET");
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
    if (method === "GET" || method === "HEAD") {
      const res = await handleLegacyServe(request, env, key);
      const out = new Response(res.body, res);
      out.headers.set("x-robots-tag", "noindex");
      return out;
    }
    if (method === "DELETE") return handleLegacyDelete(request, env, key);
    throw methodNotAllowed("GET, HEAD, DELETE");
  }
  if (method === "GET" || method === "HEAD") return handleSite(request, env, pathname);
  if (pathname === "/") throw methodNotAllowed("GET, HEAD");
  throw new HttpError(404, "not found");
}

export default {
  async fetch(request, rawEnv, ctx): Promise<Response> {
    const env = withDefaults(rawEnv, request);
    try {
      return await route(request, env);
    } catch (err) {
      // Server errors are counted per hour for the daily report and the alert emails.
      if (!(err instanceof HttpError) || err.status >= 500) ctx.waitUntil(countOps(env, "5xx"));
      if (err instanceof HttpError) return errorResponse(request, err);
      throw err;
    }
  },
  async email(message, rawEnv): Promise<void> {
    const env = rawEnv as Env;
    await ensureSchema(env.DB);
    await receiveEmail(message, env);
  },
  async scheduled(controller, env, ctx): Promise<void> {
    if (controller.cron === DAILY_REPORT_CRON) {
      ctx.waitUntil(ensureSchema(env.DB).then(() => sendDailyReport(env)));
      return;
    }
    ctx.waitUntil(
      (async () => {
        await sweepExpired(env);
        // The cron may fire before the first request on a fresh deployment.
        await ensureSchema(env.DB);
        await eraseOldFingerprints(env);
        await sweepInbox(env);
        await sweepUsage(env);
        await sweepOps(env);
        await sweepReports(env);
        await checkAlerts(env);
        // A failed digest stays unsent and is retried on the next run.
        await notifyReports(env).catch(() => undefined);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
