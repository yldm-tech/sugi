import { esc } from "../i18n";
import { brand } from "../../config";
import { type Ctx, type Page, pageTitle, tr } from "../layout";
import { peekHamster } from "../svg";
import { BRAND_ICONS } from "../brand-icons";

function loginFrame(_ctx: Ctx, inner: string): string {
  return `<section class="login"><div class="holder">
${peekHamster(110, 100, false)}<div class="paw l"></div><div class="paw r"></div>
<div class="frame">
${inner}
</div></div></section>`;
}

const LOGIN_ERRORS: Record<string, [string, string]> = {
  invalid: ["这个邮箱地址好像不对，再检查一下？", "That email address does not look right."],
  rate: ["登录邮件发得太频繁了，过一会儿再试。", "Too many login emails; wait a while and try again."],
  quota: ["今天的登录邮件额度用完了，明天再试。", "Today's login email quota is used up; try again tomorrow."],
  failed: ["邮件没能发出去，过一会儿再试。", "The email could not be sent; try again in a while."],
  link: ["这个登录链接已经用过或过期了，重新发一封吧。", "That login link was already used or has expired; ask for a new one."],
  oauth: ["登录没有完成，再试一次吧。", "Logging in did not finish; please try again."],
  taken: ["这个登录方式已经属于另一个账号了。", "That login already belongs to another account."],
};

const PROVIDERS: [string, string][] = [
  ["github", "GitHub"],
  ["google", "Google"],
];
const PROVIDER_NAMES: Record<string, string> = { email: "Email", github: "GitHub", google: "Google", passkey: "Passkey" };

/** Buttons for the OAuth providers listed in ACCOUNT_FEATURES; `verb` switches between logging in and linking. */
function providerButtons(ctx: Ctx, skip: string, link = false): string {
  const t = tr(ctx);
  const live = PROVIDERS.filter(([id]) => ctx.flags.account.includes(id) && !skip.split(",").includes(id));
  if (!live.length) return "";
  return `<div class="row-actions center">${live.map(([id, name]) => `<a class="mini with-icon" href="/auth/${id}">${BRAND_ICONS[id] ?? ""}<span>${link ? t(`关联 ${name}`, `Link ${name}`) : t(`用 ${name} 登录`, `Log in with ${name}`)}</span></a>`).join("")}</div>`;
}

function tokenSection(ctx: Ctx): string {
  const t = tr(ctx);
  const tokens = ctx.user?.tokens ?? [];
  const fail = esc(t("操作没有成功，再试一次吧。", "That did not work; please try again."));
  const day = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : t("还没用过", "never"));
  const list = tokens.length
    ? `<ul class="keys">${tokens
        .map(
          (k) =>
            `<li><span><code class="chip">${esc(k.prefix)}…</code> · <span class="nw">${t("创建于", "created")} ${day(k.created_at)}</span> · <span class="nw">${t("最近使用", "last used")} ${day(k.last_used_at)}</span></span><button type="button" class="mini danger" data-token-delete="${esc(k.id)}" data-confirm="${esc(t("吊销这个令牌？用它的命令行和脚本会立刻失效。", "Revoke this token? The CLI and scripts using it stop working at once."))}" data-fail="${fail}">${t("吊销", "Revoke")}</button></li>`,
        )
        .join("")}</ul>`
    : `<p class="small">${t("API 令牌让命令行 sugi 和你的脚本以这个账号的身份上传：sugi login 令牌。", "API tokens let the sugi CLI and your scripts upload as this account: sugi login TOKEN.")}</p>`;
  return `<div class="stack8"><p class="optlabel">${t("API 令牌", "API tokens")}</p>${list}
<div class="new-token stack8" id="new-token" hidden><p class="small">${t("新令牌只显示这一次，请现在复制保存：", "The new token is shown only this once; copy it now:")}</p><div class="urlform"><input id="new-token-value" readonly aria-label="API token"><button type="button" data-token-copy data-done="${esc(t("已复制", "Copied"))}">${t("复制", "Copy")}</button></div></div>
<div class="row-actions"><button type="button" class="mini" data-token-create data-fail="${fail}">${t("创建令牌", "Create a token")}</button></div></div>`;
}

function passkeySection(ctx: Ctx): string {
  const t = tr(ctx);
  const keys = ctx.user?.passkeys ?? [];
  const fail = esc(t("操作没有成功，再试一次吧。", "That did not work; please try again."));
  const list = keys.length
    ? `<ul class="keys">${keys
        .map(
          (k) =>
            `<li><span>${esc(k.name === "synced passkey" ? t("同步的通行密钥", "Synced passkey") : t("设备上的通行密钥", "Device passkey"))} · <span class="nw">${new Date(k.created_at).toISOString().slice(0, 10)}</span></span><button type="button" class="mini danger" data-passkey-delete="${esc(k.id)}" data-fail="${fail}">${t("删除", "Remove")}</button></li>`,
        )
        .join("")}</ul>`
    : `<p class="small">${t("还没有通行密钥。用指纹、面容或设备密码就能登录，不用等邮件。", "No passkeys yet. Log in with your fingerprint, face or device PIN instead of waiting for an email.")}</p>`;
  return `<div class="stack8"><p class="optlabel">${t("通行密钥", "Passkeys")}</p>${list}<div class="row-actions"><button type="button" class="mini" data-passkey-register data-fail="${fail}">${t("添加通行密钥", "Add a passkey")}</button></div></div>`;
}

export function loginPage(ctx: Ctx): Page {
  const t = tr(ctx);
  const q = ctx.query;
  const sent = q?.get("sent") === "1";
  const error = LOGIN_ERRORS[q?.get("error") ?? ""];
  const email = ctx.flags.account.includes("email");
  const form = email
    ? `<form class="stack8" method="post" action="/auth/email">
<input type="hidden" name="lang" value="${ctx.lang}">
<label class="optlabel" for="login-email">${t("用邮箱登录，我们会发一封带登录链接的邮件给你", "Log in with your email: we send you a login link")}</label>
<div class="urlform"><input id="login-email" type="email" name="email" required autocomplete="email" placeholder="you@example.com"><button type="submit">${t("发送登录链接", "Send link")}</button></div>
</form>`
    : `<p class="small">${t("登录功能还在路上。", "Logging in is on its way.")}</p>`;
  const notice = sent
    ? `<p class="gate">${t("登录链接已经发到你的邮箱了，15 分钟内有效。没收到的话看看垃圾邮件。", "We sent a login link to your inbox; it is valid for 15 minutes. Check your spam folder if it does not arrive.")}</p>`
    : error
      ? `<p class="gate">${t(error[0], error[1])}</p>`
      : "";
  const providers = providerButtons(ctx, "");
  const passkey = ctx.flags.account.includes("passkey")
    ? `<div class="row-actions center"><button type="button" class="mini" data-passkey-login data-fail="${esc(t("通行密钥登录没有成功，再试一次吧。", "Logging in with a passkey did not work; please try again."))}">${t("用通行密钥登录", "Log in with a passkey")}</button></div>
<p class="small center">${t("还没有账号？", "No account yet?")} <button type="button" class="linkbtn" data-passkey-register data-fail="${esc(t("没能创建通行密钥，再试一次吧。", "The passkey could not be created; please try again."))}">${t("用通行密钥创建一个", "Create one with a passkey")}</button></p>`
    : "";
  const html = loginFrame(
    ctx,
    `<div class="center"><h1 class="h2">${t(`登录 ${esc(brand(ctx.env).siteName)}`, `Log in to ${esc(brand(ctx.env).siteName)}`)}</h1><p class="lead">${t("不登录也能传。登录后，新上传的文件会记在你的账号下。", "You can upload without an account. Once you log in, new uploads are recorded under your account.")}</p></div>
${notice}
${passkey}
${providers}
${form}
<p class="small">${t('登录即表示同意 <a href="/terms" data-nav>使用条款</a> 和 <a href="/privacy" data-nav>隐私政策</a>。', 'By logging in you agree to the <a href="/terms" data-nav>terms</a> and the <a href="/privacy" data-nav>privacy policy</a>.')}</p>`,
  );
  return { id: "login", title: pageTitle(ctx, "登录", "Log in"), main: html };
}

/** The page a login email links to. Only its button logs in, so mail scanners that open links cannot use up the token. */
export function verifyPage(ctx: Ctx, token: string, valid: boolean): Page {
  const t = tr(ctx);
  const inner = valid
    ? `<div class="center"><h1 class="h2">${t("确认登录", "Confirm login")}</h1><p class="lead">${t("点下面的按钮就登录好了。", "Press the button to finish logging in.")}</p></div>
<form class="center" method="post" action="/auth/email/verify"><input type="hidden" name="token" value="${esc(token)}"><button class="btn" type="submit">${t("登录", "Log in")}</button></form>`
    : `<div class="center"><h1 class="h2">${t("链接失效了", "This link has expired")}</h1><p class="lead">${t(LOGIN_ERRORS.link[0], LOGIN_ERRORS.link[1])}</p><a class="btn" href="/login" data-nav>${t("重新登录", "Log in again")}</a></div>`;
  return { id: "login", title: pageTitle(ctx, "确认登录", "Confirm login"), main: loginFrame(ctx, inner), noindex: true };
}

export function accountPage(ctx: Ctx): Page {
  const t = tr(ctx);
  const u = ctx.user!;
  const welcome = ctx.query?.get("welcome") === "1";
  const inner = `<div class="center"><h1 class="h2">${t("我的账号", "Your account")}</h1>${welcome ? `<p class="lead">${t("登录好啦～", "You're logged in~")}</p>` : ""}</div>
<p class="lead">${u.email ? t("邮箱", "Email") : t("名字", "Name")}${t("：", ": ")}<strong>${esc(u.email ?? u.name)}</strong></p>
${u.providers.length ? `<p class="small">${t("登录方式", "Log in with")}${t("：", ": ")}${u.providers.map((p) => `<span class="nw provider">${BRAND_ICONS[p] ?? ""}${esc(PROVIDER_NAMES[p] ?? p)}</span>`).join(" · ")}</p>` : ""}
${providerButtons(ctx, u.providers.join(","), true)}
${ctx.flags.account.includes("passkey") ? passkeySection(ctx) : ""}
${ctx.flags.account.includes("tokens") ? tokenSection(ctx) : ""}
<p class="small">${ctx.flags.account.includes("sync") ? t('登录状态下新上传的文件会记在这个账号下，在 <a href="/mine" data-nav>我的文件</a> 里换设备也能看到。', 'New uploads made while logged in are recorded under this account; see them on any device under <a href="/mine" data-nav>My files</a>.') : t("登录状态下新上传的文件会记在这个账号下。", "New uploads made while logged in are recorded under this account.")}</p>
<form method="post" action="/auth/logout"><button class="mini" type="submit">${t("退出登录", "Log out")}</button></form>
<details class="danger-zone"><summary>${t("删除账号", "Delete account")}</summary>
<p class="small">${t("删除账号会删掉你的登录方式、通行密钥和会话。上传的文件默认保留（链接继续有效），勾选下面一项则一起删除。", "Deleting the account removes its logins, passkeys and sessions. Uploaded files stay (their links keep working) unless you tick the box below.")}</p>
<label class="check"><input type="checkbox" id="delete-files"> ${t("同时删除这个账号上传的文件和打包链接", "Also delete the files and albums this account uploaded")}</label>
<button type="button" class="mini danger" data-account-delete data-confirm="${esc(t("确定要删除账号吗？这一步不能撤销。", "Delete the account? This cannot be undone."))}" data-fail="${esc(t("没能删除账号，再试一次吧。", "The account could not be deleted; please try again."))}">${t("删除账号", "Delete account")}</button>
</details>`;
  return { id: "account", title: pageTitle(ctx, "我的账号", "Account"), main: loginFrame(ctx, inner), noindex: true };
}
