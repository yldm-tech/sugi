// End-to-end check of passkeys with Chromium's virtual authenticator: create a passkey-only account, see it on the account page, log out, log in with the passkey, remove it, and delete the account.
//
//   node scripts/passkey-e2e.mjs [BASE_URL]
//
// BASE_URL defaults to http://localhost:8787. The instance needs FEATURE_ACCOUNTS=1 and passkey in ACCOUNT_FEATURES. The run deletes the account it creates.
import { chromium } from "playwright";

const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const host = new URL(base).hostname;
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: process.env.SUGI_RESOLVE ? [`--host-resolver-rules=MAP ${host} ${process.env.SUGI_RESOLVE}`] : [],
});
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`);
  if (!ok) failures++;
};

try {
  const ctx = await browser.newContext({ locale: "en-US" });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.goto(`${base}/login?lang=en`);
  await Promise.all([page.waitForURL(/\/account\?welcome=1$/), page.click("[data-passkey-register]")]);
  check("create an account with a passkey", page.url().endsWith("/account?welcome=1"));
  const keys = await page.locator("[data-passkey-delete]").count();
  check("the account page lists the passkey", keys === 1, `${keys}`);
  check("the header shows the account", (await page.locator('a[href="/account"]').count()) > 0);

  await Promise.all([page.waitForURL(`${base}/`), page.click('form[action="/auth/logout"] button')]);
  const me = await page.evaluate(async () => (await fetch("/api/me")).status);
  check("logged out", me === 401, `${me}`);

  await page.goto(`${base}/login?lang=en`);
  await Promise.all([page.waitForURL(/\/account\?welcome=1$/), page.click("[data-passkey-login]")]);
  const via = await page.evaluate(async () => (await (await fetch("/api/me")).json()).via);
  check("log in with the passkey", via === "passkey", via);

  await Promise.all([page.waitForURL(/\/account$/), page.click("[data-passkey-delete]")]);
  check("remove the passkey", (await page.locator("[data-passkey-delete]").count()) === 0);

  // Leave nothing behind: delete the account through the account page.
  page.on("dialog", (d) => d.accept());
  await page.click(".danger-zone summary");
  await Promise.all([page.waitForURL(`${base}/`), page.click("[data-account-delete]")]);
  const gone = await page.evaluate(async () => (await fetch("/api/me")).status);
  check("delete the account", gone === 401, `${gone}`);
  await ctx.close();
} finally {
  await browser.close();
}
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
