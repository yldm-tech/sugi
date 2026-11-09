// Accounts: the list, and one account with its logins, sessions, API tokens, files and albums, plus the actions an admin needs (sign out everywhere, revoke or promote a token, take everything down).
import { esc } from "../../site/i18n";
import { getUserDetail, listFiles, listUsers, parseFileFilter, type UserRow } from "../data";
import { badge, empty, fmtAgo, fmtBytes, fmtNum, fmtTime, hidden, href, pager, postForm, revealSwitch, select, type T, tr, type View } from "../view";
import { fileTile, initial, type Rendered } from "./common";

const PROVIDERS: Record<string, string> = { email: "Email", github: "GitHub", google: "Google" };

function providers(t: T, u: Pick<UserRow, "providers" | "passkeys">): string {
  const list = [...new Set((u.providers ?? "").split(",").filter(Boolean))].map((p) => badge(PROVIDERS[p] ?? p));
  if (u.passkeys) list.push(badge(t(`通行密钥 ×${u.passkeys}`, `passkey ×${u.passkeys}`), "info"));
  return list.join(" ") || "–";
}

export async function usersPage(v: View, q: string, sort: "new" | "files" | "bytes", offset: number): Promise<Rendered> {
  const t = tr(v);
  const limit = 50;
  if (v.env.FEATURE_ACCOUNTS !== "1")
    return {
      title: t("用户", "Accounts"),
      main: `<h1>${t("用户", "Accounts")}</h1><div class="card">${empty(t("这个站点没有开启账号（FEATURE_ACCOUNTS）。", "Accounts are off on this site (FEATURE_ACCOUNTS)."))}</div>`,
    };
  const data = await listUsers(v.env, q, sort, offset, limit);
  const rows = data.users
    .map(
      (u) => `<tr>
<td><a class="profile" href="${esc(href(v.env, `/users/${u.id}`))}"><span class="avatar small-avatar">${initial(u)}</span><span><b>${esc(u.name || u.email || u.id)}</b><br><span class="muted small">${esc(u.email ?? t("没有邮箱", "no email"))}</span></span></a></td>
<td>${providers(t, u)}</td>
<td class="num">${fmtNum(u.files)}</td>
<td class="num">${fmtBytes(u.bytes)}</td>
<td class="num">${fmtNum(u.albums)}</td>
<td class="num">${fmtNum(u.tokens)}${u.admin_tokens ? ` ${badge("admin", "bad")}` : ""}</td>
<td>${fmtAgo(t, u.created_at)}</td>
<td>${u.last_login ? fmtAgo(t, u.last_login) : "–"}</td>
</tr>`,
    )
    .join("");
  return {
    title: t("用户", "Accounts"),
    main: `<h1>${t("用户", "Accounts")}</h1>
<p class="lede">${t(`共 ${fmtNum(data.total)} 个账号。`, `${fmtNum(data.total)} accounts.`)}</p>
<form method="get" action="${esc(href(v.env, "/users"))}" class="filters">
<label class="field grow"><span>${t("搜索", "Search")}</span><input type="search" name="q" value="${esc(q)}" placeholder="${esc(t("邮箱、名字或账号 id", "Email, name or account id"))}"></label>
${select(
  "sort",
  sort,
  [
    ["new", t("最新注册", "Newest")],
    ["files", t("文件最多", "Most files")],
    ["bytes", t("占用最多", "Most storage")],
  ],
  t("排序", "Sort"),
)}
<button>${t("搜索", "Search")}</button>${q || sort !== "new" ? `<a class="btn ghost" href="${esc(href(v.env, "/users"))}">${t("清除", "Clear")}</a>` : ""}
</form>
<div class="card flush scroll">${
      rows
        ? `<table><thead><tr><th>${t("账号", "Account")}</th><th>${t("登录方式", "Sign-in")}</th><th class="num">${t("文件", "Files")}</th><th class="num">${t("占用", "Storage")}</th><th class="num">${t("相册", "Albums")}</th><th class="num">${t("令牌", "Tokens")}</th><th>${t("注册", "Joined")}</th><th>${t("最近登录", "Last sign-in")}</th></tr></thead><tbody>${rows}</tbody></table>`
        : empty(q ? t("没有符合的账号。", "No accounts match.") : t("还没有账号。", "No accounts yet."))
    }</div>
${pager(v, "/users", { q, sort: sort === "new" ? "" : sort }, offset, limit, data.total)}`,
  };
}

export async function userPage(v: View, id: string, currentTokenHash: string): Promise<Rendered> {
  const t = tr(v);
  const d = await getUserDetail(v.env, id);
  if (!d)
    return {
      title: t("用户", "Account"),
      status: 404,
      main: `<h1>${t("用户", "Account")}</h1><div class="card">${empty(t(`在 ${new URL(v.env.MAIN_ORIGIN).host} 上没有这个账号。`, `No such account on ${new URL(v.env.MAIN_ORIGIN).host}.`))}</div>`,
    };
  const u = d.user;
  const files = await listFiles(v.env, { ...parseFileFilter(new URLSearchParams()), user: id }, 0, 24);
  const reveal = revealSwitch(t);
  const back = `/users/${id}`;
  const reasonInput = `<input class="reason" type="text" name="reason" maxlength="500" placeholder="${esc(t("原因（会记录到操作记录）", "Reason (goes into the audit log)"))}">`;

  const tokenRows = d.tokens
    .map((k) => {
      const mine = k.token_hash === currentTokenHash;
      const role = k.role === "admin" ? badge("admin", "bad") : badge("user");
      const toggle = postForm(
        v.env,
        `/users/${id}/tokens/${k.id}/role`,
        `${hidden("role", k.role === "admin" ? "user" : "admin")}<button class="ghost small"${mine ? " disabled" : ""}>${k.role === "admin" ? t("降为普通", "Make user") : t("设为管理员", "Make admin")}</button>`,
      );
      const revoke = postForm(
        v.env,
        `/users/${id}/tokens/${k.id}/revoke`,
        `<button class="ghost small"${mine ? " disabled" : ""}>${t("撤销", "Revoke")}</button>`,
      );
      return `<tr><td><code>${esc(k.prefix)}…</code>${mine ? ` ${badge(t("当前登录用的", "this session"), "info")}` : ""}</td><td>${role}</td><td>${fmtTime(k.created_at)}</td><td>${k.last_used_at ? fmtAgo(t, k.last_used_at) : t("从未", "never")}</td><td><span class="row">${toggle}${revoke}</span></td></tr>`;
    })
    .join("");

  return {
    title: u.email ?? u.name ?? u.id,
    main: `<p class="small"><a href="${esc(href(v.env, "/users"))}">← ${t("全部用户", "All accounts")}</a></p>
<div class="card"><div class="profile"><span class="avatar">${initial(u)}</span><div><h1>${esc(u.name || u.email || u.id)}</h1><span class="muted">${esc(u.email ?? t("没有邮箱", "no email"))} · <code>${esc(u.id)}</code></span></div></div></div>
<div class="stats">
<a class="stat" href="${esc(href(v.env, "/files", { user: id }))}"><span class="stat-label">${t("文件", "Files")}</span><b>${fmtNum(u.files)}</b><span class="stat-sub">${fmtBytes(u.bytes)}</span></a>
<div class="stat"><span class="stat-label">${t("相册", "Albums")}</span><b>${fmtNum(u.albums)}</b></div>
<div class="stat"><span class="stat-label">${t("在线会话", "Active sessions")}</span><b>${fmtNum(d.sessions.length)}</b></div>
<div class="stat"><span class="stat-label">${t("API 令牌", "API tokens")}</span><b>${fmtNum(d.tokens.length)}</b></div>
<div class="stat"><span class="stat-label">${t("注册时间", "Joined")}</span><b class="small-b">${fmtTime(u.created_at)}</b></div>
</div>
<div class="cols">
<div class="card"><h2>${t("登录方式", "Sign-in methods")}</h2>${
      d.identities.length || d.passkeys.length
        ? `<table class="kv"><tbody>${d.identities
            .map(
              (i) =>
                `<tr><th>${esc(PROVIDERS[i.provider] ?? i.provider)}</th><td>${esc(i.email ?? i.subject)}<br><span class="muted small">${t("绑定于", "linked")} ${fmtTime(i.created_at)}</span></td></tr>`,
            )
            .join("")}${d.passkeys
            .map(
              (p) =>
                `<tr><th>${t("通行密钥", "Passkey")}</th><td>${esc(p.name ?? p.id.slice(0, 12))}<br><span class="muted small">${t("最近使用", "last used")} ${p.last_used_at ? fmtAgo(t, p.last_used_at) : t("从未", "never")}</span></td></tr>`,
            )
            .join("")}</tbody></table>`
        : empty(t("没有登录方式。", "None."))
    }</div>
<div class="card"><h2>${t("会话", "Sessions")}</h2>${
      d.sessions.length
        ? `<ul class="list">${d.sessions.map((s) => `<li>${badge(s.via)}<span class="grow">${t("登录于", "since")} ${fmtTime(s.created_at)}</span><span class="muted small">${t("到期", "expires")} ${fmtAgo(t, s.expires_at)}</span></li>`).join("")}</ul>
${postForm(v.env, `/users/${id}/sessions/revoke`, `<div class="row"><button class="ghost">${t("全部下线", "Sign out everywhere")}</button></div>`)}`
        : empty(t("没有在线的会话。", "No active sessions."))
    }</div>
</div>
<div class="section"><h2>${t("API 令牌", "API tokens")}</h2></div>
<div class="card flush scroll">${
      tokenRows
        ? `<table><thead><tr><th>${t("令牌", "Token")}</th><th>${t("角色", "Role")}</th><th>${t("创建", "Created")}</th><th>${t("最近使用", "Last used")}</th><th></th></tr></thead><tbody>${tokenRows}</tbody></table>`
        : empty(t("没有令牌。", "No tokens."))
    }</div>
<p class="muted small">${t("admin 角色的令牌等同于 ADMIN_TOKEN：能用管理工具、不限速、能登录这个后台。改动都会记录到操作记录。", "An admin token can do everything ADMIN_TOKEN can: moderation tools, no rate limit, this dashboard. Every change is recorded in the audit log.")}</p>
${reveal.input}
<div class="section"><h2>${t("文件", "Files")}</h2><span class="row">${reveal.label}<a class="btn ghost small" href="${esc(href(v.env, "/files", { user: id }))}">${t(`全部 ${fmtNum(files.total)} 个`, `All ${fmtNum(files.total)}`)} →</a></span></div>
<div>${files.files.length ? `<div class="grid">${files.files.map((f) => fileTile(v, f)).join("")}</div>` : `<div class="card">${empty(t("没有文件。", "No files."))}</div>`}</div>
${
  d.albums.length
    ? `<div class="section"><h2>${t("相册", "Albums")}</h2></div><div class="card flush scroll"><table><thead><tr><th>${t("相册", "Album")}</th><th class="num">${t("文件", "Files")}</th><th>${t("创建", "Created")}</th></tr></thead><tbody>${d.albums
        .map(
          (a) =>
            `<tr><td><a href="${esc(href(v.env, "/inspect", { q: `a/${a.id}` }))}">${esc(a.title || t("（无标题）", "(untitled)"))}</a> <code class="muted">a/${esc(a.id)}</code></td><td class="num">${a.n}</td><td>${fmtAgo(t, a.created_at)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : ""
}
${
  u.files || u.albums
    ? `<div class="card danger-zone"><h2>${t("下架这个账号的全部内容", "Take down everything from this account")}</h2>
${postForm(
  v.env,
  `/users/${id}/takedown`,
  `${hidden("back", back)}<p class="muted">${t(
    `会下架 ${u.files} 个文件和 ${u.albums} 个相册。链接之后返回 451，id 不会再被使用，不能撤销。账号本身和它的登录方式保留。`,
    `Takes down ${u.files} files and ${u.albums} albums. Their links answer 451 from then on, the ids are never reused, and this cannot be undone. The account and its sign-in methods stay.`,
  )}</p>
<div class="row">${reasonInput}<label class="check"><input type="checkbox" name="block_content" value="1"> ${t("同时封禁相同内容", "Also block the same bytes")}</label></div>
<div class="row"><label class="check"><input type="checkbox" name="confirm" value="1" required> ${t("我确认要全部下架", "I am sure")}</label><button class="danger">${t("全部下架", "Take everything down")}</button></div>`,
)}</div>`
    : ""
}`,
  };
}
