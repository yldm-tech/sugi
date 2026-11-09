// Pieces shared by the dashboard's pages: links into other views, status and reason badges, and file tiles.
import { esc } from "../../site/i18n";
import { type FileRow, fileUrl } from "../data";
import { badge, fmtAgo, fmtBytes, href, type T, thumb, tr, type View } from "../view";

export interface Rendered {
  title: string;
  main: string;
  status?: number;
}

export const REASON_LABELS: Record<string, [string, string]> = {
  csam: ["儿童性虐待内容", "CSAM"],
  illegal: ["其他违法内容", "Illegal"],
  copyright: ["侵犯版权", "Copyright"],
  privacy: ["隐私信息", "Privacy"],
  spam: ["垃圾或诈骗", "Spam or fraud"],
  other: ["其他", "Other"],
};

export function reasonBadge(t: T, reason: string): string {
  const [zh, en] = REASON_LABELS[reason] ?? [reason, reason];
  return badge(t(zh, en), reason === "csam" ? "bad" : reason === "illegal" ? "warn" : "muted");
}

export function statusBadge(t: T, status: string): string {
  const map: Record<string, [string, string, "ok" | "warn" | "bad" | "muted"]> = {
    live: ["在线", "live", "ok"],
    expired: ["已过期", "expired", "muted"],
    taken_down: ["已下架", "taken down", "bad"],
    missing: ["不存在", "missing", "muted"],
  };
  const [zh, en, kind] = map[status] ?? [status, status, "muted"];
  return badge(t(zh, en), kind);
}

const ACTION_LABELS: Record<string, [string, string]> = {
  takedown: ["下架", "take down"],
  takedown_by_source: ["按来源下架", "take down by source"],
  block_source: ["封禁来源", "block source"],
  unblock_source: ["解封来源", "unblock source"],
  unblock_content: ["解封内容", "unblock content"],
  dismiss_report: ["驳回举报", "dismiss report"],
  revoke_sessions: ["强制下线", "sign out everywhere"],
  revoke_token: ["撤销令牌", "revoke token"],
  set_token_role: ["修改令牌角色", "change token role"],
  takedown_user: ["下架用户全部内容", "take down an account's uploads"],
};

export function actionBadge(t: T, action: string): string {
  const [zh, en] = ACTION_LABELS[action] ?? [action, action];
  const tone = /^(takedown|block_source|revoke|takedown_user)/.test(action) ? "bad" : /^unblock/.test(action) ? "ok" : "muted";
  return `${badge(t(zh, en), tone)}`;
}

export function inspectLink(v: View, target: string, text = target): string {
  return `<a href="${esc(href(v.env, "/inspect", { q: target }))}">${esc(text)}</a>`;
}

export function sourceLink(v: View, source: string, chars = 12): string {
  return `<a class="mono" href="${esc(href(v.env, "/source", { s: source }))}" title="${esc(source)}">${esc(`${source.slice(0, chars)}…`)}</a>`;
}

export function userLink(v: View, u: { id: string; email: string | null; name?: string | null }): string {
  return `<a href="${esc(href(v.env, `/users/${u.id}`))}">${esc(u.email ?? u.name ?? u.id)}</a>`;
}

/** Audit-log and report targets ("file:<id>", "legacy:<key>", "album:<id>", "source:<hmac>", "user:<id>", "sha256:<hex>") as links into the dashboard. */
export function targetCell(v: View, target: string): string {
  const i = target.indexOf(":");
  const [kind, id] = [target.slice(0, i), target.slice(i + 1)];
  if (kind === "file" || kind === "legacy") return inspectLink(v, id, target);
  if (kind === "album") return inspectLink(v, `a/${id}`, target);
  if (kind === "source" && /^[0-9a-f]{64}$/.test(id)) return `source:${sourceLink(v, id)}`;
  if (kind === "user") return `<a href="${esc(href(v.env, `/users/${id}`))}">${esc(target)}</a>`;
  if (kind === "files" && /^\d+$/.test(id)) return esc(tr(v)(`${id} 个文件`, `${id} files`));
  if (kind === "sha256") return `<a class="mono" href="${esc(href(v.env, "/search", { q: id }))}">${esc(`sha256:${id.slice(0, 12)}…`)}</a>`;
  return `<code>${esc(target)}</code>`;
}

/** The id a dashboard link uses for an indexed key: the file id, or the legacy key itself. */
export function keyTarget(key: string): string {
  return key.startsWith("f/") || key.startsWith("t/") ? key.slice(2) : key;
}

/** One file in a grid: preview (blurred until the page's switch is on), name, size, age and tags; `pick` adds a checkbox for bulk actions. */
export function fileTile(v: View, f: FileRow, opts: { pick?: string } = {}): string {
  const t = tr(v);
  const url = fileUrl(v.env, f.key, f.type);
  const id = keyTarget(f.key);
  const temporary = f.key.startsWith("t/");
  const legacy = !f.key.startsWith("f/") && !temporary;
  const expired = f.expires_at !== null && f.expires_at <= Date.now();
  const tags = [
    temporary ? badge(expired ? t("已过期", "expired") : t("临时", "temp"), "warn") : "",
    legacy ? badge(t("旧接口", "legacy"), "info") : "",
    f.user_id ? badge(t("账号", "account"), "ok") : "",
  ].join("");
  return `<div class="tile">
${opts.pick ? `<input class="pick" type="checkbox" name="key" value="${esc(f.key)}" form="${opts.pick}" aria-label="${esc(t("选中", "Select"))} ${esc(id)}">` : ""}
${tags ? `<span class="tags">${tags}</span>` : ""}
<a class="cover" href="${esc(href(v.env, "/inspect", { q: id }))}">${thumb(url, f.type)}</a>
<div class="meta"><span class="name" title="${esc(f.name ?? id)}">${esc(f.name ?? id)}</span>
<span class="line"><span>${fmtBytes(f.size)}</span><span>${fmtAgo(t, f.created_at)}</span></span>
${f.user_id ? `<span class="line"><a href="${esc(href(v.env, `/users/${f.user_id}`))}">${esc(f.user_email ?? f.user_name ?? f.user_id)}</a></span>` : ""}</div>
</div>`;
}

export function initial(u: { email: string | null; name: string | null; id: string }): string {
  return esc(Array.from(u.name || u.email || u.id)[0]?.toUpperCase() ?? "?");
}
