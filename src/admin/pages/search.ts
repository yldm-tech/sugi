// Search across everything: accounts, files, albums, sources, content hashes and the audit log. A link or id that names a file or album goes straight to its page (see the router).
import { isSourceBlocked } from "../../http";
import { isHashBlocked } from "../../moderation";
import { esc } from "../../site/i18n";
import { listAlbums, listFiles, listUsers, parseFileFilter, queryLog } from "../data";
import { badge, empty, fmtAgo, fmtBytes, fmtNum, href, ICONS, revealSwitch, tr, type View } from "../view";
import { actionBadge, fileTile, initial, type Rendered, sourceLink, targetCell } from "./common";

export async function searchPage(v: View, q: string): Promise<Rendered> {
  const t = tr(v);
  const title = t("搜索", "Search");
  const host = new URL(v.env.MAIN_ORIGIN).host;
  if (!q) return { title, main: `<h1>${title}</h1><div class="card">${empty(t("在上面的搜索框里输入。", "Type in the search box above."))}</div>` };
  const hex = /^[0-9a-f]{64}$/i.test(q) ? q.toLowerCase() : null;
  const accounts = v.env.FEATURE_ACCOUNTS === "1";
  const [files, users, albums, log] = await Promise.all([
    listFiles(v.env, { ...parseFileFilter(new URLSearchParams()), q }, 0, 18),
    accounts && !hex ? listUsers(v.env, q, "new", 0, 10) : Promise.resolve({ total: 0, users: [] }),
    hex ? Promise.resolve({ total: 0, albums: [] }) : listAlbums(v.env, q, 0, 10),
    queryLog(v.env, { action: "", q, before: null, limit: 10 }),
  ]);
  const sections: string[] = [];
  const reveal = revealSwitch(t);

  if (hex) {
    const [asSource, asHash, srcBlocked, hashBlocked, srcAlbums, srcRemoved] = await Promise.all([
      v.env.DB.prepare("SELECT COUNT(*) AS n FROM file_index WHERE source = ?").bind(hex).first<{ n: number }>(),
      v.env.DB.prepare("SELECT COUNT(*) AS n FROM file_index WHERE sha256 = ?").bind(hex).first<{ n: number }>(),
      isSourceBlocked(v.env, hex),
      isHashBlocked(v.env, hex),
      v.env.DB.prepare("SELECT COUNT(*) AS n FROM albums WHERE source = ?").bind(hex).first<{ n: number }>(),
      v.env.DB.prepare("SELECT COUNT(*) AS n FROM tombstones WHERE source = ? OR sha256 = ?").bind(hex, hex).first<{ n: number }>(),
    ]);
    if (asSource?.n || srcAlbums?.n || srcBlocked)
      sections.push(
        `<div class="card"><h2>${t("来源", "Source")}</h2><p>${sourceLink(v, hex, 16)} ${srcBlocked ? badge(t("已封禁", "blocked"), "bad") : ""}</p><p class="muted">${t(
          `${fmtNum(asSource?.n ?? 0)} 个文件、${fmtNum(srcAlbums?.n ?? 0)} 个相册在线。`,
          `${fmtNum(asSource?.n ?? 0)} files and ${fmtNum(srcAlbums?.n ?? 0)} albums up.`,
        )}</p></div>`,
      );
    if (asHash?.n || hashBlocked)
      sections.push(
        `<div class="card"><h2>${t("内容（SHA-256）", "Content (SHA-256)")}</h2><p><code>${esc(hex)}</code> ${hashBlocked ? badge(t("已封禁", "blocked"), "bad") : ""}</p><p class="muted">${t(
          `${fmtNum(asHash?.n ?? 0)} 个在线文件是这段内容。`,
          `${fmtNum(asHash?.n ?? 0)} files up have this content.`,
        )}</p></div>`,
      );
    if (srcRemoved?.n) sections.push(`<p class="muted small">${t(`另有 ${srcRemoved.n} 条相关的下架记录。`, `${srcRemoved.n} related takedown records.`)}</p>`);
  }

  if (users.users.length)
    sections.push(
      `<div class="section"><h2>${ICONS.users}${t("账号", "Accounts")} <span class="muted small">${fmtNum(users.total)}</span></h2>${
        users.total > users.users.length ? `<a class="small" href="${esc(href(v.env, "/users", { q }))}">${t("全部", "All")} →</a>` : ""
      }</div><div class="card"><ul class="list">${users.users
        .map(
          (u) =>
            `<li><span class="avatar small-avatar">${initial(u)}</span><a class="grow" href="${esc(href(v.env, `/users/${u.id}`))}">${esc(u.name || u.email || u.id)}${u.email && u.name ? ` <span class="muted">${esc(u.email)}</span>` : ""}</a><span class="muted small">${t(`${fmtNum(u.files)} 个文件`, `${fmtNum(u.files)} files`)} · ${fmtBytes(u.bytes)}</span></li>`,
        )
        .join("")}</ul></div>`,
    );

  if (files.files.length)
    sections.push(
      `${reveal.input}<div class="section"><h2>${ICONS.files}${t("文件", "Files")} <span class="muted small">${fmtNum(files.total)}</span></h2><span class="row">${reveal.label}<a class="btn ghost small" href="${esc(
        href(v.env, "/files", { q }),
      )}">${t("在文件库里看全部", "All in Files")} →</a></span></div><div><div class="grid">${files.files.map((f) => fileTile(v, f)).join("")}</div></div>`,
    );

  if (albums.albums.length)
    sections.push(
      `<div class="section"><h2>${ICONS.albums}${t("相册", "Albums")} <span class="muted small">${fmtNum(albums.total)}</span></h2>${
        albums.total > albums.albums.length ? `<a class="small" href="${esc(href(v.env, "/albums", { q }))}">${t("全部", "All")} →</a>` : ""
      }</div><div class="card"><ul class="list">${albums.albums
        .map(
          (a) =>
            `<li><a class="grow" href="${esc(href(v.env, "/inspect", { q: `a/${a.id}` }))}">${esc(a.title || `a/${a.id}`)}</a><span class="muted small">${t(`${a.n} 个文件`, `${a.n} files`)} · ${fmtAgo(t, a.created_at)}</span></li>`,
        )
        .join("")}</ul></div>`,
    );

  if (log.entries.length)
    sections.push(
      `<div class="section"><h2>${ICONS.log}${t("操作记录", "Audit log")}</h2><a class="small" href="${esc(href(v.env, "/log", { q }))}">${t("全部", "All")} →</a></div><div class="card"><ul class="list">${log.entries
        .map(
          (e) =>
            `<li>${actionBadge(t, e.action)}<span class="grow">${e.target ? targetCell(v, e.target) : "–"}${e.reason ? ` <span class="muted">· ${esc(e.reason)}</span>` : ""}</span><span class="muted small">${fmtAgo(t, e.at)}</span></li>`,
        )
        .join("")}</ul></div>`,
    );

  return {
    title,
    main: `<h1>${t("搜索", "Search")}：${esc(q)}</h1>
<p class="lede">${t(`在 ${host} 的数据里搜索。`, `Searching the data of ${host}.`)}</p>
<div class="results">${
      sections.length
        ? sections.join("\n")
        : `<div class="card">${empty(
            t(
              `${host} 上没有找到“${esc(q)}”。可以搜文件或相册的链接和 id、文件名、账号邮箱或名字、来源哈希、SHA-256。测试站和正式站的数据是分开的。`,
              `Nothing on ${host} matches “${esc(q)}”. Search for file or album links and ids, file names, account emails or names, source hashes or SHA-256. Test and production sites have separate data.`,
            ),
          )}</div>`
    }</div>`,
  };
}
