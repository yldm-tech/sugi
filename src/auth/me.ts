// Account endpoints that are live: who am I, and logging out. Further endpoints (my files and albums, claiming earlier uploads, API tokens, passkeys, deleting the account) are developed on the accounts branch and arrive with their ACCOUNT_FEATURES.
import { HttpError, jsonResponse } from "../http";
import { clearSessionCookie, displayName, Principal, requirePrincipal, sameOrigin } from "./core";

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
