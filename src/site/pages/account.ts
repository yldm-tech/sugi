import { esc } from "../i18n";
import { brand } from "../../config";
import { type Ctx, type Page, pageTitle, tr } from "../layout";
import { peekHamster } from "../svg";

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
  return `<div class="row-actions center">${live.map(([id, name]) => `<a class="mini" href="/auth/${id}">${link ? t(`关联 ${name}`, `Link ${name}`) : t(`用 ${name} 登录`, `Log in with ${name}`)}</a>`).join("")}</div>`;
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
  const html = loginFrame(
    ctx,
    `<div class="center"><h1 class="h2">${t(`登录 ${esc(brand(ctx.env).siteName)}`, `Log in to ${esc(brand(ctx.env).siteName)}`)}</h1><p class="lead">${t("不登录也能传。登录后，新上传的文件会记在你的账号下。", "You can upload without an account. Once you log in, new uploads are recorded under your account.")}</p></div>
${notice}
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
${u.providers.length ? `<p class="small">${t("登录方式", "Log in with")}${t("：", ": ")}${u.providers.map((p) => esc(PROVIDER_NAMES[p] ?? p)).join(" · ")}</p>` : ""}
${providerButtons(ctx, u.providers.join(","), true)}
<p class="small">${t("登录状态下新上传的文件会记在这个账号下。在多台设备上查看和管理它们的功能还在路上。", "New uploads made while logged in are recorded under this account. Seeing and managing them across devices is on its way.")}</p>
<form method="post" action="/auth/logout"><button class="mini" type="submit">${t("退出登录", "Log out")}</button></form>`;
  return { id: "account", title: pageTitle(ctx, "我的账号", "Account"), main: loginFrame(ctx, inner), noindex: true };
}
