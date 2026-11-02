// Email login ("magic links"). The link opens a confirmation page and only the button on it logs in, so mail scanners that prefetch links cannot use up the token. Sending goes through Cloudflare Email Service when a `send_email` binding named EMAIL exists, otherwise through Resend's HTTP API (RESEND_API_KEY).
import { hmacSha256Hex } from "../crypto";
import { HttpError, jsonResponse } from "../http";
import { accountsOn, createSession, hashSecret, loginWithIdentity, resolvePrincipal, sameOrigin, secret } from "./core";

export const MAGIC_TTL_MS = 15 * 60 * 1000;
// Resend's free tier allows 100 emails a day and 3,000 a month; these limits keep well inside it and stop anyone from mail-bombing an address.
export const MAGIC_PER_EMAIL_PER_HOUR = 3;
export const MAGIC_PER_SOURCE_PER_HOUR = 5;
export const MAGIC_PER_DAY = 90;
export const MAIL_FROM = "sugi.moe <login@sugi.moe>";

interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

interface SendEmailBinding {
  send(message: { to: string; from: string; subject: string; text: string; html: string }): Promise<unknown>;
}

export function emailConfigured(env: Env): boolean {
  return Boolean((env as unknown as { EMAIL?: SendEmailBinding }).EMAIL || env.RESEND_API_KEY);
}

export class EmailQuotaError extends HttpError {
  constructor() {
    super(503, "the login email quota for today is used up; try again tomorrow or log in with a passkey, GitHub or Google");
  }
}

export async function sendEmail(env: Env, mail: Mail): Promise<void> {
  const binding = (env as unknown as { EMAIL?: SendEmailBinding }).EMAIL;
  if (binding) {
    await binding.send({ to: mail.to, from: MAIL_FROM.replace(/^.*<|>$/g, ""), subject: mail.subject, text: mail.text, html: mail.html });
    return;
  }
  if (!env.RESEND_API_KEY) throw new HttpError(503, "email login is not configured");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
  });
  if (res.ok) return;
  const body = await res.json<{ name?: string; message?: string }>().catch(() => ({}) as { name?: string });
  // Resend answers 429 both for its per-second rate limit and for daily/monthly quota errors.
  if (res.status === 429 || /quota/i.test(body.name ?? "")) throw new EmailQuotaError();
  throw new HttpError(502, "could not send the email");
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v.length > 254 || !/^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z0-9-]{2,}$/i.test(v)) return null;
  return v;
}

function loginMail(link: string, lang: "zh" | "en"): Omit<Mail, "to"> {
  if (lang === "zh") {
    return {
      subject: "登录 sugi.moe",
      text: `点下面的链接登录 sugi.moe（15 分钟内有效，只能用一次）：\n\n${link}\n\n如果不是你本人操作，忽略这封邮件就好。`,
      html: `<p>点下面的按钮登录 sugi.moe（15 分钟内有效，只能用一次）：</p><p><a href="${link}" style="display:inline-block;padding:10px 22px;border-radius:999px;background:#5E9E6E;color:#fff;text-decoration:none">登录 sugi.moe</a></p><p style="color:#7A8474;font-size:13px">如果按钮打不开，复制这个链接到浏览器：<br>${link}</p><p style="color:#7A8474;font-size:13px">如果不是你本人操作，忽略这封邮件就好。</p>`,
    };
  }
  return {
    subject: "Log in to sugi.moe",
    text: `Open this link to log in to sugi.moe (valid for 15 minutes, works once):\n\n${link}\n\nIf you did not ask for this, just ignore this email.`,
    html: `<p>Press the button to log in to sugi.moe (valid for 15 minutes, works once):</p><p><a href="${link}" style="display:inline-block;padding:10px 22px;border-radius:999px;background:#5E9E6E;color:#fff;text-decoration:none">Log in to sugi.moe</a></p><p style="color:#7A8474;font-size:13px">If the button does not work, copy this link into your browser:<br>${link}</p><p style="color:#7A8474;font-size:13px">If you did not ask for this, just ignore this email.</p>`,
  };
}

// POST /auth/email {"email": "...", "lang": "zh" | "en"}
export async function handleMagicRequest(request: Request, env: Env): Promise<Response> {
  if (!accountsOn(env) || !emailConfigured(env)) throw new HttpError(404, "not found");
  if (!sameOrigin(request, env)) throw new HttpError(403, "cross-site request refused");
  if (!env.IP_HASH_SECRET) throw new HttpError(503, "not configured");
  let body: { email?: unknown; lang?: unknown };
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "expected JSON");
  }
  const email = normalizeEmail(body.email);
  if (!email) throw new HttpError(400, "that email address does not look right");
  const lang = body.lang === "zh" ? "zh" : "en";
  const source = await hmacSha256Hex(env.IP_HASH_SECRET, request.headers.get("cf-connecting-ip") ?? "unknown");
  const now = Date.now();
  const counts = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE email = ? AND created_at > ?").bind(email, now - 3600e3),
    env.DB.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE source = ? AND created_at > ?").bind(source, now - 3600e3),
    env.DB.prepare("SELECT COUNT(*) AS n FROM magic_links WHERE created_at > ?").bind(now - 86400e3),
  ]);
  const [perEmail, perSource, perDay] = counts.map((r) => (r.results[0] as { n: number }).n);
  if (perEmail >= MAGIC_PER_EMAIL_PER_HOUR || perSource >= MAGIC_PER_SOURCE_PER_HOUR) throw new HttpError(429, "too many login emails; wait a while or use another way to log in", { "retry-after": "3600" });
  if (perDay >= MAGIC_PER_DAY) throw new EmailQuotaError();

  const token = secret();
  const hash = await hashSecret(token);
  await env.DB.prepare("INSERT INTO magic_links (token_hash, email, source, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(hash, email, source, now, now + MAGIC_TTL_MS).run();
  const link = `${env.MAIN_ORIGIN}/auth/email/verify?token=${token}`;
  try {
    await sendEmail(env, { to: email, ...loginMail(link, lang) });
  } catch (err) {
    await env.DB.prepare("DELETE FROM magic_links WHERE token_hash = ?").bind(hash).run();
    throw err;
  }
  // Old rows only matter for the rate limits above.
  await env.DB.prepare("DELETE FROM magic_links WHERE created_at < ?").bind(now - 2 * 86400e3).run();
  return jsonResponse({ sent: true, expires_in: MAGIC_TTL_MS / 1000 });
}

/** Consumes a magic link token; returns the user or null if the link is unknown, used or expired. */
export async function consumeMagicLink(env: Env, token: string): Promise<{ email: string } | null> {
  const hash = await hashSecret(token);
  const now = Date.now();
  // Single UPDATE so two clicks cannot both succeed.
  const row = await env.DB.prepare("UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email").bind(now, hash, now).first<{ email: string }>();
  return row ?? null;
}

// POST /auth/email/verify (form field "token"), sent by the confirmation page.
export async function handleMagicVerify(request: Request, env: Env): Promise<Response> {
  if (!accountsOn(env)) throw new HttpError(404, "not found");
  if (!sameOrigin(request, env)) throw new HttpError(403, "cross-site request refused");
  const form = await request.formData().catch(() => null);
  const token = form?.get("token");
  if (typeof token !== "string" || !token) throw new HttpError(400, "missing token");
  const used = await consumeMagicLink(env, token);
  if (!used) return Response.redirect(`${env.MAIN_ORIGIN}/login?error=link`, 303);
  const current = await resolvePrincipal(request, env);
  const user = await loginWithIdentity(env, "email", used.email, used.email, true, null, current);
  const headers = new Headers({ location: `${env.MAIN_ORIGIN}/mine?welcome=1` });
  headers.append("set-cookie", await createSession(env, user.id, "email"));
  return new Response(null, { status: 303, headers });
}

export function magicLinkValid(env: Env, token: string): Promise<boolean> {
  return hashSecret(token).then(async (h) => Boolean(await env.DB.prepare("SELECT 1 FROM magic_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").bind(h, Date.now()).first()));
}

