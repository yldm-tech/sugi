import { loadAlbum } from "../albums";
import { findFile } from "../files";
import { assertAlbumNotRemoved, assertFileNotRemoved } from "../moderation";
import { randomNonce } from "../http";
import { pickLang, readCookie } from "./i18n";
import { Ctx, documentHtml, flagsOf, Page, pageCsp } from "./layout";
import { albumPage, filePage, minePage } from "./pages/files";
import { homePage } from "./pages/home";
import { privacyPage } from "./pages/privacy";
import { devPage, donatePage, faqPage, loginPage, notFoundPage, termsPage } from "./pages/info";

export const LANG_COOKIE = "sugi_lang";

export function makeCtx(request: Request, env: Env): { ctx: Ctx; setCookie: string | null } {
  const url = new URL(request.url);
  const q = url.searchParams.get("lang");
  const lang = pickLang(q, readCookie(request.headers.get("cookie"), LANG_COOKIE), request.headers.get("accept-language"));
  const setCookie = q === "en" || q === "zh" ? `${LANG_COOKIE}=${q}; Path=/; Max-Age=31536000; SameSite=Lax; Secure` : null;
  return { ctx: { env, lang, nonce: randomNonce(), gated: Boolean(env.UPLOAD_TOKEN), flags: flagsOf(env), path: url.pathname }, setCookie };
}

async function resolvePage(ctx: Ctx, pathname: string): Promise<Page> {
  switch (pathname) {
    case "/":
      return homePage(ctx);
    case "/mine":
      return minePage(ctx);
    case "/dev":
      return devPage(ctx);
    case "/faq":
      return faqPage(ctx);
    case "/terms":
      return termsPage(ctx);
    case "/privacy":
      return privacyPage(ctx);
    case "/login":
      return ctx.flags.accounts ? loginPage(ctx) : notFoundPage(ctx);
    case "/donate":
      return ctx.flags.donate ? donatePage(ctx) : notFoundPage(ctx);
  }
  const file = /^\/f\/([a-z0-9-]{1,64})$/.exec(pathname);
  if (file) {
    const found = await findFile(ctx.env, file[1]);
    if (!found) await assertFileNotRemoved(ctx.env, file[1]);
    return found ? filePage(ctx, found.file) : notFoundPage(ctx);
  }
  const album = /^\/a\/([a-z0-9]{1,16})$/.exec(pathname);
  if (album) {
    const a = await loadAlbum(ctx.env, album[1]);
    if (!a) await assertAlbumNotRemoved(ctx.env, album[1]);
    return a ? albumPage(ctx, a) : notFoundPage(ctx);
  }
  return notFoundPage(ctx);
}

/** Renders a site page. With `X-Sugi-Partial: 1` it returns only the page's main content as JSON, which the browser script swaps in without a full reload so running uploads keep going. */
export async function handleSite(request: Request, env: Env, pathname: string): Promise<Response> {
  const { ctx, setCookie } = makeCtx(request, env);
  const page = await resolvePage(ctx, pathname);
  const headers: Record<string, string> = {
    ...(page.noindex ? { "x-robots-tag": "noindex" } : {}),
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-language": ctx.lang === "zh" ? "zh-CN" : "en",
    // Each response carries a fresh CSP nonce, so shared caches must not reuse it across visitors.
    "cache-control": "private, no-cache",
    vary: "Accept-Language, Cookie, X-Sugi-Partial",
  };
  if (setCookie) headers["set-cookie"] = setCookie;
  if (request.headers.get("x-sugi-partial") === "1") {
    return new Response(JSON.stringify({ page: page.id, title: page.title, html: page.main, lang: ctx.lang }), { status: page.status ?? 200, headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
  }
  const html = documentHtml(ctx, page);
  return new Response(request.method === "HEAD" ? null : html, {
    status: page.status ?? 200,
    headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": pageCsp(env, ctx.nonce), "x-frame-options": "DENY" },
  });
}

/** 404 page for unknown paths on any host, as HTML for browsers and plain text otherwise. */
export function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}
