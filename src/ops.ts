// Operations: counters for server errors, /healthz, a daily report and threshold alerts emailed to OPS_EMAIL. Everything is off unless OPS_EMAIL and a mail sender (MAIL_FROM plus Resend or a send_email binding) are configured; counters and /healthz always work.
import { emailConfigured, sendEmail } from "./auth/email";
import { brand } from "./config";
import { jsonResponse } from "./http";
import { quotas, today } from "./quota";

export const DAILY_REPORT_CRON = "5 0 * * *";
const ALERT_EVERY_MS = 6 * 3600 * 1000;

function hourOf(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 13);
}

/** Counts something for the current hour (e.g. "5xx"). Cheap enough for error paths; never throws. */
export async function countOps(env: Env, name: string, now = Date.now()): Promise<void> {
  await env.DB.prepare("INSERT INTO ops_counters (hour, name, count) VALUES (?, ?, 1) ON CONFLICT (hour, name) DO UPDATE SET count = count + 1")
    .bind(hourOf(now), name)
    .run()
    .catch(() => undefined);
}

async function sumOps(env: Env, name: string, fromHour: string, toHour: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM ops_counters WHERE name = ? AND hour >= ? AND hour <= ?")
    .bind(name, fromHour, toHour)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// GET /healthz: the database and the bucket answer.
export async function handleHealthz(env: Env): Promise<Response> {
  const check = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  };
  const d1 = await check(() => env.DB.prepare("SELECT 1").first());
  const r2 = await check(() => env.BUCKET.head("healthz"));
  return jsonResponse({ ok: d1 && r2, d1, r2, time: new Date().toISOString() }, d1 && r2 ? 200 : 503);
}

function opsOn(env: Env): boolean {
  return Boolean(env.OPS_EMAIL) && emailConfigured(env);
}

const fmtBytes = (b: number) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;

async function storageUsed(env: Env): Promise<{ objects: number; bytes: number }> {
  let objects = 0;
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ limit: 1000, cursor });
    for (const o of page.objects) {
      objects++;
      bytes += o.size;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { objects, bytes };
}

/** The numbers of one UTC day, for the daily report (and tests). */
export async function dailyNumbers(env: Env, day: string): Promise<Record<string, number | null>> {
  const usage = await env.DB.prepare("SELECT bytes, uploads, rejected FROM usage_daily WHERE day = ? AND scope = 'global'")
    .bind(day)
    .first<{ bytes: number; uploads: number; rejected: number }>();
  const start = Date.parse(`${day}T00:00:00Z`);
  const end = start + 86400e3;
  const one = async (sql: string, ...args: unknown[]) =>
    (
      await env.DB.prepare(sql)
        .bind(...args)
        .first<{ n: number }>()
        .catch(() => null)
    )?.n ?? null;
  const storage = await storageUsed(env);
  return {
    uploads: usage?.uploads ?? 0,
    upload_bytes: usage?.bytes ?? 0,
    quota_rejections: usage?.rejected ?? 0,
    server_errors: await sumOps(env, "5xx", `${day}T00`, `${day}T23`),
    cache_origin_errors: await one(
      "SELECT COALESCE(SUM(count), 0) AS n FROM ops_counters WHERE name LIKE 'cache\\_%' ESCAPE '\\' AND hour >= ? AND hour <= ?",
      `${day}T00`,
      `${day}T23`,
    ),
    takedowns: await one("SELECT COUNT(*) AS n FROM admin_log WHERE action IN ('takedown', 'takedown_by_source') AND at >= ? AND at < ?", start, end),
    new_reports: await one("SELECT COUNT(*) AS n FROM reports WHERE created_at >= ? AND created_at < ?", start, end),
    open_reports: await one("SELECT COUNT(*) AS n FROM reports WHERE resolved_at IS NULL"),
    login_emails: await one("SELECT COUNT(*) AS n FROM magic_links WHERE created_at >= ? AND created_at < ?", start, end),
    storage_objects: storage.objects,
    storage_bytes: storage.bytes,
  };
}

async function mail(env: Env, subject: string, lines: string[]): Promise<void> {
  const text = lines.join("\n");
  const html = `<pre style="font:14px/1.6 ui-monospace,Menlo,monospace">${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</pre>`;
  await sendEmail(env, { to: env.OPS_EMAIL!, subject, text, html });
  await countOps(env, "ops_email");
}

/** Cron, once a day just after midnight UTC: yesterday's numbers. */
export async function sendDailyReport(env: Env, now = Date.now()): Promise<boolean> {
  if (!opsOn(env)) return false;
  const day = today(now - 86400e3);
  const n = await dailyNumbers(env, day);
  const q = quotas(env);
  const site = brand(env).siteName;
  await mail(env, `[${site}] daily report ${day}`, [
    `${site}, ${day} (UTC)`,
    "",
    `uploads            ${n.uploads} (${fmtBytes(Number(n.upload_bytes))})${q.global ? ` of ${fmtBytes(q.global)} daily cap` : ""}`,
    `quota rejections   ${n.quota_rejections}`,
    `server errors      ${n.server_errors}`,
    `cache origin errors ${n.cache_origin_errors ?? "-"} (unexpected statuses from CACHE_ORIGIN, each retried once)`,
    `takedowns          ${n.takedowns ?? "-"}`,
    `new reports        ${n.new_reports ?? "-"} (open: ${n.open_reports ?? "-"})`,
    `login emails sent  ${n.login_emails ?? "-"}  (plus this report; Resend free tier: 100 a day)`,
    `storage            ${n.storage_objects} objects, ${fmtBytes(Number(n.storage_bytes))}`,
    "",
    `${env.MAIN_ORIGIN}/healthz`,
  ]);
  return true;
}

async function shouldAlert(env: Env, name: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT last_sent FROM ops_alerts WHERE name = ?").bind(name).first<{ last_sent: number }>();
  if (row && now - row.last_sent < ALERT_EVERY_MS) return false;
  await env.DB.prepare("INSERT INTO ops_alerts (name, last_sent) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET last_sent = excluded.last_sent")
    .bind(name, now)
    .run();
  return true;
}

/** Cron, every 10 minutes: emails at most one alert of each kind per 6 hours. */
export async function checkAlerts(env: Env, now = Date.now()): Promise<string[]> {
  if (!opsOn(env)) return [];
  const sent: string[] = [];
  const site = brand(env).siteName;
  const errLimit = Number(env.ALERT_5XX_PER_HOUR || 20);
  const errors = await sumOps(env, "5xx", hourOf(now - 3600e3), hourOf(now));
  if (errLimit > 0 && errors >= errLimit && (await shouldAlert(env, "5xx", now))) {
    await mail(env, `[${site}] alert: ${errors} server errors in the last hour`, [
      `${errors} server errors (5xx) in the last hour (threshold ${errLimit}).`,
      "",
      `${env.MAIN_ORIGIN}/healthz`,
    ]);
    sent.push("5xx");
  }
  const usage = await env.DB.prepare("SELECT bytes, rejected FROM usage_daily WHERE day = ? AND scope = 'global'")
    .bind(today(now))
    .first<{ bytes: number; rejected: number }>();
  const q = quotas(env);
  if (q.global && usage && usage.bytes >= q.global && (await shouldAlert(env, "cap", now))) {
    await mail(env, `[${site}] alert: daily upload cap reached`, [
      `Today's uploads reached the site-wide cap (${fmtBytes(q.global)}); only trusted and admin uploads are taken until midnight UTC.`,
    ]);
    sent.push("cap");
  }
  const growth = Number(env.ALERT_DAILY_UPLOAD_BYTES || 0);
  if (growth > 0 && usage && usage.bytes >= growth && (await shouldAlert(env, "growth", now))) {
    await mail(env, `[${site}] alert: ${fmtBytes(usage.bytes)} uploaded today`, [`Today's uploads passed ${fmtBytes(growth)} (ALERT_DAILY_UPLOAD_BYTES).`]);
    sent.push("growth");
  }
  return sent;
}

/** Cron: drop counters older than two weeks. */
export async function sweepOps(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM ops_counters WHERE hour < ?")
    .bind(hourOf(now - 14 * 86400e3))
    .run();
}
