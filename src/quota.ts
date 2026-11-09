// Daily upload quotas, counted in D1 per UTC day: one row per source (anonymous uploads), per account (logged-in uploads) and one global row. Checking costs two point reads; recording, one batched upsert. Trusted and admin uploads are never limited but still counted.
import { HttpError, type Uploader } from "./http";

const GiB = 1024 * 1024 * 1024;

export interface Quotas {
  anon: number;
  account: number;
  global: number;
}

/** Bytes per day; 0 means unlimited. */
export function quotas(env: Env): Quotas {
  const n = (v: string | undefined, fallback: number) => {
    const x = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(x) && x >= 0 ? x : fallback;
  };
  return {
    anon: n(env.QUOTA_ANON_BYTES_PER_DAY, GiB),
    account: n(env.QUOTA_ACCOUNT_BYTES_PER_DAY, 5 * GiB),
    global: n(env.QUOTA_GLOBAL_BYTES_PER_DAY, 50 * GiB),
  };
}

export function today(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function scopeOf(u: Uploader): string {
  return u.userId ? `user:${u.userId}` : `src:${u.source}`;
}

const fmtGB = (b: number) => `${Math.round((b / GiB) * 10) / 10} GB`;

/** The daily byte quota was used up (per uploader). */
export class QuotaError extends HttpError {
  constructor(limit: number, account: boolean, accountLimit: number) {
    super(
      429,
      account || !accountLimit
        ? `daily upload quota used up (${fmtGB(limit)} per day); try again tomorrow`
        : `daily upload quota used up (${fmtGB(limit)} per day without an account); try again tomorrow, or log in for ${fmtGB(accountLimit)} per day`,
      { "retry-after": String(secondsToMidnight()) },
    );
  }
}

/** The site-wide daily cap was reached; only trusted and admin uploads are taken until midnight UTC. */
export class CapacityError extends HttpError {
  constructor() {
    super(507, "the site has reached today's upload limit; please try again tomorrow", { "retry-after": String(secondsToMidnight()) });
  }
}

function secondsToMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Math.max(60, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000));
}

/** Throws QuotaError or CapacityError when `bytes` more would go over today's limits. */
export async function checkQuota(env: Env, u: Uploader, bytes: number): Promise<void> {
  if (u.trusted) return;
  const q = quotas(env);
  const day = today();
  const scope = scopeOf(u);
  const rows = await env.DB.prepare("SELECT scope, bytes FROM usage_daily WHERE day = ? AND scope IN (?, 'global')")
    .bind(day, scope)
    .all<{ scope: string; bytes: number }>();
  const used = (s: string) => rows.results.find((r) => r.scope === s)?.bytes ?? 0;
  const limit = u.userId ? q.account : q.anon;
  let err: HttpError | null = null;
  if (q.global && used("global") + bytes > q.global) err = new CapacityError();
  else if (limit && used(scope) + bytes > limit) err = new QuotaError(limit, Boolean(u.userId), q.account);
  if (err) {
    await env.DB.batch(
      [scope, "global"].map((s) =>
        env.DB.prepare("INSERT INTO usage_daily (day, scope, rejected) VALUES (?, ?, 1) ON CONFLICT (day, scope) DO UPDATE SET rejected = rejected + 1").bind(
          day,
          s,
        ),
      ),
    );
    throw err;
  }
}

/** Adds a stored upload to today's totals. */
export async function recordUsage(env: Env, u: Uploader, bytes: number): Promise<void> {
  const day = today();
  await env.DB.batch(
    [scopeOf(u), "global"].map((s) =>
      env.DB.prepare(
        "INSERT INTO usage_daily (day, scope, bytes, uploads) VALUES (?, ?, ?, 1) ON CONFLICT (day, scope) DO UPDATE SET bytes = bytes + excluded.bytes, uploads = uploads + 1",
      ).bind(day, s, bytes),
    ),
  );
}

/** Cron: keep a week of per-source and per-account totals, and 90 days of the site-wide one (one row a day) for the admin dashboard's charts. */
export async function sweepUsage(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM usage_daily WHERE day < ? AND (scope != 'global' OR day < ?)")
    .bind(today(now - 7 * 86400e3), today(now - 90 * 86400e3))
    .run();
}
