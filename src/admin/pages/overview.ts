// The overview: totals, 30-day trends, what the storage is made of, the newest uploads, open reports and recent admin actions.
import { lastIndexPass } from "../../fileindex";
import { dailyNumbers } from "../../ops";
import { quotas, today } from "../../quota";
import { listReports } from "../../reports";
import { esc } from "../../site/i18n";
import { errorSeries, fileTotals, listFiles, parseFileFilter, queryLog, signupSeries, siteCounts, uploadSeries } from "../data";
import { barChart, empty, fmtAgo, fmtBytes, fmtNum, href, revealSwitch, shareBar, stat, tr, type View } from "../view";
import { actionBadge, fileTile, inspectLink, reasonBadge, type Rendered, targetCell } from "./common";

export async function overviewPage(v: View, day: string | null): Promise<Rendered> {
  const t = tr(v);
  const now = Date.now();
  const [todayN, totals, counts, uploads, signups, errors, recent, reports, log, pass] = await Promise.all([
    dailyNumbers(v.env, today(), { storage: false }),
    fileTotals(v.env),
    siteCounts(v.env, now),
    uploadSeries(v.env, 30, now),
    signupSeries(v.env, 30, now),
    errorSeries(v.env, 48, now),
    listFiles(v.env, parseFileFilter(new URLSearchParams()), 0, 12),
    listReports(v.env, "open", 0, 5) as Promise<{ reports: { id: number; target: string; reason: string; created_at: string }[] }>,
    queryLog(v.env, { action: "", q: "", before: null, limit: 8 }),
    lastIndexPass(v.env),
  ]);
  const cap = quotas(v.env).global;
  const errors24 = errors.slice(-24).reduce((a, p) => a + p.n, 0);
  const md = (d: string) => d.slice(5);
  const reveal = revealSwitch(t);

  const picked = day ? await dailyNumbers(v.env, day, { storage: false }) : null;
  const dayStats = picked
    ? `<div class="stats">
${stat(fmtNum(picked.uploads), t("上传", "Uploads"), { sub: fmtBytes(picked.upload_bytes) })}
${stat(fmtNum(picked.quota_rejections), t("超额拒绝", "Quota rejections"))}
${stat(fmtNum(picked.server_errors), t("服务器错误", "Server errors"))}
${stat(fmtNum(picked.cache_origin_errors), t("缓存回源错误", "Cache origin errors"))}
${stat(fmtNum(picked.takedowns), t("下架", "Takedowns"))}
${stat(fmtNum(picked.new_reports), t("新举报", "New reports"))}
${stat(fmtNum(picked.login_emails), t("登录邮件", "Login emails"))}
</div>`
    : "";

  return {
    title: t("概览", "Overview"),
    main: `<h1>${t("概览", "Overview")}</h1>
<p class="lede">${t("时间均为 UTC。", "All times are UTC.")}</p>
${pass ? "" : `<p class="note">${t("文件索引还在建立：cron 每 10 分钟对账一批，第一次完整对账完成前，文件相关的数字可能偏小。", "The file index is still being built: the cron reconciles a batch every 10 minutes, so file numbers may be low until the first full pass.")}</p>`}
<div class="stats">
${stat(fmtNum(totals.files), t("文件", "Files"), { link: href(v.env, "/files"), sub: fmtBytes(totals.bytes) })}
${stat(fmtNum(todayN.uploads), t("今日上传", "Uploads today"), { sub: `${fmtBytes(todayN.upload_bytes)}${cap ? ` / ${fmtBytes(cap)}` : ""}`, tone: cap && Number(todayN.upload_bytes) >= cap ? "warn" : undefined })}
${stat(fmtNum(counts.users), t("用户", "Accounts"), { link: href(v.env, "/users"), sub: t(`近 7 天新增 ${counts.users_7d}`, `${counts.users_7d} new in 7 days`) })}
${stat(fmtNum(counts.albums), t("相册", "Albums"), { link: href(v.env, "/albums") })}
${stat(fmtNum(counts.open_reports), t("待处理举报", "Open reports"), { link: href(v.env, "/reports"), tone: counts.open_reports ? "bad" : undefined })}
${stat(fmtNum(counts.blocked_sources + counts.blocked_hashes), t("生效的封禁", "Active blocks"), { link: href(v.env, "/blocks"), sub: t(`${counts.blocked_sources} 个来源 · ${counts.blocked_hashes} 个内容`, `${counts.blocked_sources} sources · ${counts.blocked_hashes} content`) })}
${stat(fmtNum(errors24), t("24 小时服务器错误", "Server errors, 24 h"), { link: href(v.env, "/system"), tone: errors24 ? "warn" : undefined })}
</div>
<div class="cols">
<div class="card"><h2>${t("近 30 天上传次数", "Uploads, last 30 days")}</h2>${barChart(
      uploads.map((p) => ({ label: md(p.day), value: p.uploads, tip: `${p.day}: ${fmtNum(p.uploads)}` })),
      fmtNum,
    )}</div>
<div class="card"><h2>${t("近 30 天上传量", "Bytes uploaded, last 30 days")}</h2>${barChart(
      uploads.map((p) => ({ label: md(p.day), value: p.bytes, tip: `${p.day}: ${fmtBytes(p.bytes)}` })),
      fmtBytes,
      "info",
    )}</div>
</div>
<div class="cols3">
<div class="card"><h2>${t("存储构成", "What is stored")}</h2>
${shareBar(
  [
    { label: t("图片", "Images"), value: totals.bytes - totals.video_bytes, tone: "green" },
    { label: t("视频", "Videos"), value: totals.video_bytes, tone: "info" },
  ],
  fmtBytes,
)}
<div class="gap"></div>
${shareBar(
  [
    { label: t("永久", "Permanent"), value: totals.files - totals.temporary - totals.legacy, tone: "green" },
    { label: t("临时", "Temporary"), value: totals.temporary, tone: "warn" },
    { label: t("旧接口", "Legacy"), value: totals.legacy, tone: "violet" },
  ],
  fmtNum,
)}
<p class="muted small">${t(`${fmtNum(totals.owned)} 个文件属于账号。`, `${fmtNum(totals.owned)} files belong to accounts.`)}</p></div>
<div class="card"><h2>${t("新用户（30 天）", "New accounts, 30 days")}</h2>${barChart(
      signups.map((p) => ({ label: md(p.day), value: p.n, tip: `${p.day}: ${p.n}` })),
      fmtNum,
      "violet",
    )}</div>
<div class="card"><h2>${t("服务器错误（48 小时）", "Server errors, 48 hours")}</h2>${barChart(
      errors.map((p) => ({ label: `${p.hour.slice(11)}:00`, value: p.n, tip: `${p.hour.replace("T", " ")}:00 UTC: ${p.n}` })),
      fmtNum,
      "bad",
    )}</div>
</div>
${reveal.input}
<div class="section"><h2>${t("最新上传", "Newest uploads")}</h2><span class="row">${reveal.label}<a class="btn ghost small" href="${esc(href(v.env, "/files"))}">${t("全部文件", "All files")} →</a></span></div>
<div>${recent.files.length ? `<div class="grid">${recent.files.map((f) => fileTile(v, f)).join("")}</div>` : `<div class="card">${empty(t("还没有文件。", "No files yet."))}</div>`}</div>
<div class="cols">
<div class="card"><div class="section"><h2>${t("待处理举报", "Open reports")}</h2><a class="small" href="${esc(href(v.env, "/reports"))}">${t("全部", "All")} →</a></div>
${
  reports.reports.length
    ? `<ul class="list">${reports.reports
        .map((r) => {
          const where = r.target.startsWith("album:") ? `a/${r.target.slice(6)}` : r.target.slice(r.target.indexOf(":") + 1);
          return `<li><b>#${r.id}</b>${reasonBadge(t, r.reason)}<span class="grow">${inspectLink(v, where, r.target)}</span><span class="muted small">${fmtAgo(t, r.created_at)}</span></li>`;
        })
        .join("")}</ul>`
    : empty(t("没有待处理的举报。", "No open reports."))
}</div>
<div class="card"><div class="section"><h2>${t("最近的管理操作", "Recent admin actions")}</h2><a class="small" href="${esc(href(v.env, "/log"))}">${t("全部", "All")} →</a></div>
${
  log.entries.length
    ? `<ul class="list">${log.entries
        .map(
          (e) =>
            `<li>${actionBadge(t, e.action)}<span class="grow">${e.target ? targetCell(v, e.target) : "–"}</span><span class="muted small">${fmtAgo(t, e.at)}</span></li>`,
        )
        .join("")}</ul>`
    : empty(t("还没有记录。", "Nothing yet."))
}</div>
</div>
<div class="section"><h2>${t("按日查看", "A single day")}</h2></div>
<div class="card"><form method="get" action="${esc(href(v.env, "/"))}" class="row">
<input type="date" name="day" value="${esc(day ?? today())}" max="${today()}" aria-label="${esc(t("日期（UTC）", "Day (UTC)"))}">
<button class="ghost">${t("查看", "Show")}</button><span class="muted small">${t("上传量按天只保留 90 天。", "Daily totals are kept for 90 days.")}</span>
</form>${picked ? `<div class="section"><h2>${esc(day!)}</h2></div>${dayStats}` : ""}</div>`,
  };
}
