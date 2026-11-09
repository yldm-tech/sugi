// System views: health, background jobs, settings at a glance and the dashboard's own sessions; the backup and restore page; and the sign-in page.
import { backupStatus } from "../../backup";
import { lastIndexPass } from "../../fileindex";
import { videoPolicy } from "../../http";
import { quotas } from "../../quota";
import { esc } from "../../site/i18n";
import { errorSeries } from "../data";
import { badge, barChart, empty, fmtAgo, fmtBytes, fmtNum, fmtTime, hidden, postForm, tr, type View } from "../view";
import type { Rendered } from "./common";

async function ping(fn: () => Promise<unknown>): Promise<{ ok: boolean; ms: number }> {
  const start = Date.now();
  try {
    await fn();
    return { ok: true, ms: Date.now() - start };
  } catch {
    return { ok: false, ms: Date.now() - start };
  }
}

const JOBS: Record<string, [string, string]> = {
  index_cursor: ["文件索引对账（每 10 分钟一批）", "File index reconcile (a batch every 10 minutes)"],
  index_pass: ["文件索引上次完整对账", "Last full file index pass"],
  backup_cursor: ["备份复制（每 10 分钟一批）", "Backup copy (a batch every 10 minutes)"],
  backup_gc_cursor: ["备份清理（每 10 分钟一批）", "Backup clean-up (a batch every 10 minutes)"],
  storage: ["存储统计（捐赠页）", "Storage numbers (donate page)"],
};

export async function systemPage(v: View, currentSession: string): Promise<Rendered> {
  const t = tr(v);
  const env = v.env;
  const now = Date.now();
  const [d1, r2, indexRows, pass, state, errors, cacheErrors, sessions] = await Promise.all([
    ping(() => env.DB.prepare("SELECT 1").first()),
    ping(() => env.BUCKET.head("healthz")),
    env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM file_index").first<{ n: number; bytes: number }>(),
    lastIndexPass(env),
    env.DB.prepare("SELECT name, at FROM ops_state ORDER BY name").all<{ name: string; at: number }>(),
    errorSeries(env, 48, now),
    env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM ops_counters WHERE name LIKE 'cache\\_%' ESCAPE '\\' AND hour >= ?")
      .bind(new Date(now - 24 * 3600e3).toISOString().slice(0, 13))
      .first<{ n: number }>(),
    env.DB.prepare("SELECT id_hash, label, created_at, expires_at FROM admin_sessions WHERE expires_at > ? ORDER BY created_at DESC")
      .bind(now)
      .all<{ id_hash: string; label: string; created_at: number; expires_at: number }>(),
  ]);
  const health = (ok: boolean, ms: number) =>
    `<span class="health${ok ? "" : " bad"}"><i></i>${ok ? t("正常", "OK") : t("异常", "failing")} <span class="muted small">${ms} ms</span></span>`;
  const q = quotas(env);
  const on = (x: unknown) => (x ? badge(t("开", "on"), "ok") : badge(t("关", "off")));
  const config: [string, string][] = [
    [t("主站", "Main site"), `<code>${esc(env.MAIN_ORIGIN)}</code>`],
    [t("永久文件", "Permanent files"), `<code>${esc(env.FILES_ORIGIN)}</code>`],
    [t("临时文件", "Temporary files"), `<code>${esc(env.TMP_ORIGIN)}</code>`],
    [t("后台", "Dashboard"), `<code>${esc(env.ADMIN_ORIGIN)}</code>`],
    [t("缓存回源", "Cache origin"), env.CACHE_ORIGIN ? `<code>${esc(env.CACHE_ORIGIN)}</code>` : badge(t("关", "off"))],
    [t("账号", "Accounts"), `${on(env.FEATURE_ACCOUNTS === "1")} <span class="muted small">${esc(env.ACCOUNT_FEATURES ?? "")}</span>`],
    [
      t("谁能上传视频", "Who may upload videos"),
      badge({ anyone: t("任何人", "anyone"), account: t("有账号的人", "accounts"), trusted: t("只有可信令牌", "trusted tokens only") }[videoPolicy(env)]),
    ],
    [t("备份", "Backup"), on(env.BACKUP)],
    [t("运维邮件", "Ops email"), on(env.OPS_EMAIL)],
    [
      t("每日上传上限", "Daily upload caps"),
      t(
        `全站 ${fmtBytes(q.global)} · 每个账号 ${fmtBytes(q.account)} · 每个匿名来源 ${fmtBytes(q.anon)}`,
        `site ${fmtBytes(q.global)} · per account ${fmtBytes(q.account)} · per anonymous source ${fmtBytes(q.anon)}`,
      ),
    ],
    [t("搜索引擎", "Search engines"), env.NOINDEX === "1" ? badge(t("不收录", "noindex"), "warn") : badge(t("收录", "indexed"), "ok")],
  ];
  const jobs = state.results
    .filter((s) => JOBS[s.name])
    .map((s) => `<li><span class="grow">${esc(t(...JOBS[s.name]))}</span><span class="muted small">${fmtAgo(t, s.at, now)}</span></li>`)
    .join("");
  const sessionRows = sessions.results
    .map((s) => {
      const mine = s.id_hash === currentSession;
      return `<tr><td>${esc(s.label)}${mine ? ` ${badge(t("当前", "this one"), "info")}` : ""}</td><td>${fmtAgo(t, s.created_at, now)}</td><td>${fmtAgo(t, s.expires_at, now)}</td><td>${
        mine ? "" : postForm(env, "/sessions/end", `${hidden("session", s.id_hash)}<button class="ghost small">${t("结束", "End")}</button>`)
      }</td></tr>`;
    })
    .join("");
  const errors24 = errors.slice(-24).reduce((a, p) => a + p.n, 0);
  return {
    title: t("状态", "Status"),
    main: `<h1>${t("状态", "Status")}</h1>
<p class="lede">${t("健康检查、后台任务、设置和后台登录会话。", "Health, background jobs, settings and dashboard sessions.")}</p>
<div class="stats">
<div class="stat"><span class="stat-label">D1</span><b class="small-b">${health(d1.ok, d1.ms)}</b></div>
<div class="stat"><span class="stat-label">R2</span><b class="small-b">${health(r2.ok, r2.ms)}</b></div>
<div class="stat${errors24 ? " warn" : ""}"><span class="stat-label">${t("24 小时服务器错误", "Server errors, 24 h")}</span><b>${fmtNum(errors24)}</b></div>
<div class="stat${cacheErrors?.n ? " warn" : ""}"><span class="stat-label">${t("24 小时缓存回源错误", "Cache origin errors, 24 h")}</span><b>${fmtNum(cacheErrors?.n ?? 0)}</b></div>
<div class="stat"><span class="stat-label">${t("文件索引", "File index")}</span><b>${fmtNum(indexRows?.n ?? 0)}</b><span class="stat-sub">${fmtBytes(indexRows?.bytes ?? 0)} · ${
      pass ? t(`上次完整对账 ${fmtAgo(t, pass, now)}`, `full pass ${fmtAgo(t, pass, now)}`) : t("还没完成第一次对账", "first pass not done yet")
    }</span></div>
</div>
<div class="cols">
<div class="card"><h2>${t("服务器错误（48 小时）", "Server errors, 48 hours")}</h2>${barChart(
      errors.map((p) => ({ label: `${p.hour.slice(11)}:00`, value: p.n, tip: `${p.hour.replace("T", " ")}:00 UTC: ${p.n}` })),
      fmtNum,
      "bad",
    )}</div>
<div class="card"><h2>${t("后台任务", "Background jobs")}</h2>${jobs ? `<ul class="list">${jobs}</ul>` : empty(t("还没有运行记录。", "No runs yet."))}<p class="muted small">${t(
      "这些任务由每 10 分钟一次的 cron 执行，时间是最近一次写入进度的时间。",
      "The 10-minute cron runs these; the time is when each last saved its progress.",
    )}</p></div>
</div>
<div class="section"><h2>${t("设置", "Settings")}</h2><span class="muted small">${t("在 wrangler 配置里修改", "Change them in the wrangler config")}</span></div>
<div class="card"><table class="kv"><tbody>${config.map(([k, val]) => `<tr><th>${k}</th><td>${val}</td></tr>`).join("")}</tbody></table></div>
<div class="section"><h2>${t("后台登录会话", "Dashboard sessions")}</h2></div>
<div class="card flush scroll">${
      sessionRows
        ? `<table><thead><tr><th>${t("令牌", "Token")}</th><th>${t("登录", "Signed in")}</th><th>${t("到期", "Expires")}</th><th></th></tr></thead><tbody>${sessionRows}</tbody></table>`
        : empty("–")
    }</div>
<p class="muted small">${t("轮换 ADMIN_TOKEN 会立刻结束用它登录的全部会话。", "Rotating ADMIN_TOKEN ends every session opened with it at once.")}</p>`,
  };
}

export async function backupPage(v: View, restore: { keys: string; result: Record<string, unknown> } | null): Promise<Rendered> {
  const t = tr(v);
  const title = t("备份", "Backup");
  const s = (await backupStatus(v.env)) as {
    enabled: boolean;
    objects?: number;
    bytes?: number;
    deleted_waiting?: number;
    oldest_deleted_since?: string | null;
    grace_days?: number;
  };
  if (!s.enabled)
    return {
      title,
      main: `<h1>${title}</h1><div class="card">${empty(t("没有配置备份存储桶（BACKUP 绑定）。", "No backup bucket is configured (the BACKUP binding)."))}</div>`,
    };
  const r = restore?.result as
    | { dry_run: boolean; would_restore?: string[]; restored?: string[]; skipped: { key: string; why: string }[]; present: number }
    | undefined;
  const list = (keys: string[]) => (keys.length ? keys.map((k) => `<code>${esc(k)}</code>`).join("<br>") : "–");
  const result = r
    ? `<div class="card"><h2>${r.dry_run ? t("预演结果", "Dry run") : t("已恢复", "Restored")}</h2>
<table class="kv"><tbody>
<tr><th>${r.dry_run ? t("会恢复", "Would restore") : t("已恢复", "Restored")}</th><td>${list((r.dry_run ? r.would_restore : r.restored) ?? [])}</td></tr>
<tr><th>${t("跳过", "Skipped")}</th><td>${r.skipped.length ? r.skipped.map((x) => `<code>${esc(x.key)}</code> ${badge(x.why)}`).join("<br>") : "–"}</td></tr>
<tr><th>${t("仍然存在", "Still there")}</th><td>${r.present}</td></tr>
</tbody></table>
${
  r.dry_run && (r.would_restore?.length ?? 0) > 0
    ? postForm(
        v.env,
        "/backup/restore",
        `<textarea name="keys" hidden>${esc(restore!.keys)}</textarea><div class="row"><button>${t("确认恢复", "Restore them")}</button></div>`,
      )
    : ""
}</div>`
    : "";
  return {
    title,
    main: `<h1>${title}</h1>
<p class="lede">${t("永久文件每 10 分钟分批复制到备份存储桶。被删除的文件副本保留一段时间，被下架的立刻删除。", "Permanent files are copied to the backup bucket in batches every 10 minutes. Copies of deleted files are kept for a while; taken-down ones go at once.")}</p>
<div class="stats">
<div class="stat"><span class="stat-label">${t("备份对象", "Objects in the backup")}</span><b>${fmtNum(s.objects ?? 0)}</b></div>
<div class="stat"><span class="stat-label">${t("备份大小", "Backup size")}</span><b>${fmtBytes(s.bytes)}</b></div>
<div class="stat"><span class="stat-label">${t(`已删除、保留 ${s.grace_days} 天的副本`, `Deleted, kept ${s.grace_days} days`)}</span><b>${fmtNum(s.deleted_waiting ?? 0)}</b></div>
<div class="stat"><span class="stat-label">${t("最早的已删除副本", "Oldest deleted copy")}</span><b class="small-b">${s.oldest_deleted_since ? fmtTime(s.oldest_deleted_since) : "–"}</b></div>
</div>
${result}
<div class="card"><h2>${t("从备份恢复", "Restore from the backup")}</h2>${postForm(
      v.env,
      "/backup/restore",
      `<p class="muted">${t(
        "每行一个键：f/<id> 或旧链接的 <16 位十六进制>.<扩展名>。先预演，确认后再恢复。已下架的文件不会恢复，已存在的文件不会被覆盖。",
        "One key per line: f/<id>, or a legacy <16 hex>.<ext>. This is a dry run first; you confirm the restore after it. Taken-down files are never restored and nothing that exists is overwritten.",
      )}</p>
<textarea name="keys" required placeholder="f/k3x9qa2m">${esc(restore?.keys ?? "")}</textarea>
${hidden("dry_run", 1)}
<div class="row"><button class="ghost">${t("预演", "Dry run")}</button></div>`,
    )}</div>`,
  };
}

export function loginPage(v: View, error: string | null, next: string): Rendered {
  const t = tr(v);
  const configured = Boolean(v.env.ADMIN_TOKEN) || v.env.FEATURE_ACCOUNTS === "1";
  const host = new URL(v.env.MAIN_ORIGIN).host;
  return {
    title: t("登录", "Sign in"),
    status: error ? 401 : 200,
    main: `<div class="login card">
<h1>${t("管理后台", "Admin")}</h1>
${
  configured
    ? `<p>${t(
        `用 ${host} 的 ADMIN_TOKEN，或者这个站点上角色为 admin 的个人 API 令牌登录。每个站点（包括测试站）的令牌各自独立。登录 12 小时内有效。`,
        `Sign in with the ADMIN_TOKEN of ${host}, or a personal API token with the admin role on this site. Every site (test sites too) has its own tokens. A session lasts 12 hours.`,
      )}</p>
${error ? `<p class="flash bad">${esc(error)}</p>` : ""}
${postForm(
  v.env,
  "/login",
  `${hidden("next", next)}<div class="row"><input type="password" name="token" autocomplete="current-password" required aria-label="${esc(t("令牌", "Token"))}" placeholder="${esc(t("令牌", "Token"))}"><button>${t("登录", "Sign in")}</button></div>`,
)}`
    : `<p>${t("这个站点没有设置 ADMIN_TOKEN，管理后台没有开启。", "This site has no ADMIN_TOKEN, so the dashboard is off.")}</p>`
}
</div>`,
  };
}
