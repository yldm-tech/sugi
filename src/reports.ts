// Reports from visitors: the report form on file and album pages posts to /api/reports (scripts may post JSON). Reports are stored in D1, mailed to the abuse address as a digest at most once an hour, and handled by an admin with the list_reports and resolve_report MCP tools. A report never removes anything by itself.
import { albumUrl } from "./albums";
import { emailConfigured, sendEmail } from "./auth/email";
import { brand } from "./config";
import { hmacSha256Hex } from "./crypto";
import { findFile, pageUrl } from "./files";
import { HttpError, jsonResponse } from "./http";
import { auditLog, parseTarget, takedown, type Target } from "./moderation";

export const REPORT_REASONS = ["csam", "illegal", "copyright", "privacy", "spam", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_DETAILS_MAX = 2000;
export const REPORT_CONTACT_MAX = 254;
/** Per reporter (source HMAC): reports per hour and per day. */
export const REPORTS_PER_SOURCE_PER_HOUR = 5;
export const REPORTS_PER_SOURCE_PER_DAY = 20;
/** Whole site: reports per day, so a flood cannot fill the database or the abuse inbox. */
export const REPORTS_PER_DAY = 300;
/** The abuse address gets at most one digest per this interval. */
export const REPORT_DIGEST_EVERY_MS = 3600e3;
const SOURCE_KEEP_MS = 7 * 86400e3;
const RESOLVED_KEEP_MS = 365 * 86400e3;
const DIGEST_MAX = 50;

const REASON_LABEL: Record<ReportReason, string> = {
  csam: "child sexual abuse material",
  illegal: "other illegal content",
  copyright: "copyright infringement",
  privacy: "private information",
  spam: "spam or fraud",
  other: "other",
};

interface ReportRow {
  id: number;
  target: string;
  reason: ReportReason;
  details: string | null;
  contact: string | null;
  created_at: number;
  notified_at: number | null;
  resolved_at: number | null;
  resolution: string | null;
  note: string | null;
}

function targetKey(t: Target): string {
  return t.kind === "legacy" ? `legacy:${t.key}` : `${t.kind}:${t.id}`;
}

/** The public page (or link, for legacy files) of a stored target such as "file:abcd2345". */
export function targetLink(env: Env, target: string): string {
  const [kind, id] = [target.slice(0, target.indexOf(":")), target.slice(target.indexOf(":") + 1)];
  if (kind === "album") return albumUrl(env, id);
  if (kind === "legacy") return `${env.MAIN_ORIGIN}/${id}`;
  return pageUrl(env, id);
}

async function exists(env: Env, t: Target): Promise<boolean> {
  if (t.kind === "file") return (await findFile(env, t.id)) !== null;
  if (t.kind === "album") return (await env.DB.prepare("SELECT 1 FROM albums WHERE id = ?").bind(t.id).first()) !== null;
  return (await env.BUCKET.head(t.key)) !== null;
}

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

function clean(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  // Control characters (except newlines and tabs) have no place in a report.
  const v = raw.replace(/[^\P{Cc}\n\t]/gu, "").trim();
  return v ? v.slice(0, max) : null;
}

export interface ReportInput {
  target: unknown;
  reason: unknown;
  details?: unknown;
  contact?: unknown;
}

/** Validates and stores one report. Returns false when the same reporter already has an open report on the same target (nothing new is stored). */
export async function createReport(request: Request, env: Env, input: ReportInput, now = Date.now()): Promise<boolean> {
  if (!env.IP_HASH_SECRET) throw new HttpError(503, "reports are not configured");
  if (typeof input.target !== "string" || !input.target.trim()) throw new HttpError(400, "target is required");
  const t = parseTarget(input.target);
  if (!REPORT_REASONS.includes(input.reason as ReportReason)) throw new HttpError(400, `reason must be one of ${REPORT_REASONS.join(", ")}`);
  const details = clean(input.details, REPORT_DETAILS_MAX);
  const contact = clean(input.contact, REPORT_CONTACT_MAX);
  if (!(await exists(env, t))) throw new HttpError(404, "not found");
  const source = await hmacSha256Hex(env.IP_HASH_SECRET, request.headers.get("cf-connecting-ip") ?? "unknown");
  const target = targetKey(t);
  const counts = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE source = ? AND created_at > ?").bind(source, now - 3600e3),
    env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE source = ? AND created_at > ?").bind(source, now - 86400e3),
    env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE created_at > ?").bind(now - 86400e3),
    env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE source = ? AND target = ? AND resolved_at IS NULL").bind(source, target),
  ]);
  const [hour, day, site, dup] = counts.map((r) => (r.results[0] as { n: number }).n);
  if (dup > 0) return false;
  if (hour >= REPORTS_PER_SOURCE_PER_HOUR || day >= REPORTS_PER_SOURCE_PER_DAY || site >= REPORTS_PER_DAY)
    throw new HttpError(429, "too many reports; please try again later or write to the abuse address", { "retry-after": "3600" });
  await env.DB.prepare("INSERT INTO reports (target, reason, details, contact, source, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(target, input.reason, details, contact, source, now)
    .run();
  return true;
}

// POST /api/reports: JSON {"target", "reason", "details"?, "contact"?} from scripts and the page script, or the page's plain form (same fields plus "back"), which is answered with a redirect back to the page.
export async function handleReport(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== env.MAIN_ORIGIN && origin !== new URL(request.url).origin) throw new HttpError(403, "cross-site request refused");
  const isJson = (request.headers.get("content-type") ?? "").includes("application/json");
  let input: ReportInput;
  if (isJson) {
    try {
      input = await request.json();
    } catch {
      throw new HttpError(400, "expected JSON");
    }
  } else {
    const form = await request.formData().catch(() => null);
    input = { target: form?.get("target"), reason: form?.get("reason"), details: form?.get("details"), contact: form?.get("contact") };
  }
  if (isJson) {
    await createReport(request, env, input);
    await notifyReports(env).catch(() => undefined);
    return jsonResponse({ received: true }, 202);
  }
  // Without the page script: back to the reported page with the outcome in the query.
  let back = `${env.MAIN_ORIGIN}/`;
  try {
    const t = parseTarget(String(input.target ?? ""));
    if (t.kind !== "legacy") back = t.kind === "album" ? albumUrl(env, t.id) : pageUrl(env, t.id);
  } catch {}
  try {
    await createReport(request, env, input);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return Response.redirect(`${back}?report=${err.status === 429 ? "rate" : "failed"}#report`, 303);
  }
  await notifyReports(env).catch(() => undefined);
  return Response.redirect(`${back}?report=sent#report`, 303);
}

// ---- digest email ----

/** Mails reports not yet sent to the abuse address, at most once per REPORT_DIGEST_EVERY_MS. Called after each report and from the cron, so a report waits at most about an hour. Off without an abuse address or a mail sender. */
export async function notifyReports(env: Env, now = Date.now()): Promise<number> {
  const to = brand(env).abuseEmail;
  if (!to || !emailConfigured(env)) return 0;
  const last = await env.DB.prepare("SELECT MAX(notified_at) AS t FROM reports").first<{ t: number | null }>();
  if (last?.t && now - last.t < REPORT_DIGEST_EVERY_MS) return 0;
  const rows = (
    await env.DB.prepare("SELECT * FROM reports WHERE notified_at IS NULL AND resolved_at IS NULL ORDER BY id LIMIT ?").bind(DIGEST_MAX).all<ReportRow>()
  ).results;
  if (!rows.length) return 0;
  const site = brand(env).siteName;
  const urgent = rows.some((r) => r.reason === "csam");
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE resolved_at IS NULL").first<{ n: number }>();
  const lines = [
    `${rows.length} new report${rows.length === 1 ? "" : "s"} on ${site} (${open?.n ?? rows.length} open in total).`,
    "",
    ...rows.flatMap((r) => [
      `#${r.id}  ${REASON_LABEL[r.reason] ?? r.reason}  ${iso(r.created_at)}`,
      `  ${targetLink(env, r.target)}`,
      ...(r.details ? [`  "${r.details.slice(0, 500).replace(/\s+/g, " ")}"`] : []),
      ...(r.contact ? [`  contact: ${r.contact}`] : []),
      "",
    ]),
    "Handle them with the admin MCP tools: list_reports, inspect, then resolve_report (action takedown or dismiss).",
  ];
  const text = lines.join("\n");
  const html = `<pre style="font:14px/1.6 ui-monospace,Menlo,monospace;white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</pre>`;
  await sendEmail(env, { to, subject: `[${site}] ${urgent ? "URGENT: " : ""}${rows.length} new report${rows.length === 1 ? "" : "s"}`, text, html });
  await env.DB.prepare(`UPDATE reports SET notified_at = ? WHERE id IN (${rows.map(() => "?").join(",")})`)
    .bind(now, ...rows.map((r) => r.id))
    .run();
  return rows.length;
}

// ---- admin ----

export async function listReports(env: Env, status: "open" | "resolved" | "all" = "open", offset = 0, limit = 50): Promise<Record<string, unknown>> {
  const where = status === "open" ? "WHERE resolved_at IS NULL" : status === "resolved" ? "WHERE resolved_at IS NOT NULL" : "";
  const n = Math.min(Math.max(1, limit), 200);
  const rows = (await env.DB.prepare(`SELECT * FROM reports ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(n, Math.max(0, offset)).all<ReportRow>()).results;
  const open = await env.DB.prepare("SELECT target, COUNT(*) AS n FROM reports WHERE resolved_at IS NULL GROUP BY target").all<{ target: string; n: number }>();
  const perTarget = new Map(open.results.map((r) => [r.target, r.n]));
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reports ${where}`).first<{ n: number }>();
  return {
    status,
    total: total?.n ?? 0,
    open: [...perTarget.values()].reduce((a, b) => a + b, 0),
    reports: rows.map((r) => ({
      id: r.id,
      target: r.target,
      link: targetLink(env, r.target),
      reason: r.reason,
      details: r.details,
      contact: r.contact,
      created_at: iso(r.created_at),
      emailed_at: iso(r.notified_at),
      open_reports_on_target: perTarget.get(r.target) ?? 0,
      resolved_at: iso(r.resolved_at),
      resolution: r.resolution,
      note: r.note,
    })),
  };
}

/** Resolves a report and every other open report on the same target: "takedown" removes the target (see moderation.takedown), "dismiss" leaves it up. */
export async function resolveReport(
  env: Env,
  id: number,
  action: "takedown" | "dismiss",
  opts: { note?: string | null; blockContent?: boolean } = {},
): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare("SELECT * FROM reports WHERE id = ?").bind(id).first<ReportRow>();
  if (!row) throw new HttpError(404, `no report #${id}`);
  if (row.resolved_at) throw new HttpError(409, `report #${id} was already resolved (${row.resolution}) at ${iso(row.resolved_at)}`);
  const reason = `report #${id} (${row.reason})${opts.note ? `: ${opts.note}` : ""}`;
  let result: unknown = null;
  if (action === "takedown") {
    try {
      result = await takedown(env, targetLink(env, row.target), { reason, blockContent: opts.blockContent, via: "report" });
    } catch (err) {
      // Already gone (deleted by its owner, expired or removed earlier): the report is settled all the same.
      if (!(err instanceof HttpError) || err.status !== 404) throw err;
      result = { already_gone: true };
    }
  } else {
    await (await auditLog(env, "dismiss_report", row.target, reason, { report: id })).run();
  }
  const now = Date.now();
  const resolution = action === "takedown" ? "removed" : "dismissed";
  const updated = await env.DB.prepare("UPDATE reports SET resolved_at = ?, resolution = ?, note = ? WHERE target = ? AND resolved_at IS NULL RETURNING id")
    .bind(now, resolution, opts.note ?? null, row.target)
    .all<{ id: number }>();
  return { target: row.target, resolution, resolved_reports: updated.results.map((r) => r.id).sort((a, b) => a - b), takedown: result };
}

/** Cron: erase reporters' source HMACs after 7 days and delete reports resolved more than a year ago. */
export async function sweepReports(env: Env, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE reports SET source = NULL WHERE source IS NOT NULL AND created_at < ?").bind(now - SOURCE_KEEP_MS),
    env.DB.prepare("DELETE FROM reports WHERE resolved_at IS NOT NULL AND resolved_at < ?").bind(now - RESOLVED_KEEP_MS),
  ]);
}
