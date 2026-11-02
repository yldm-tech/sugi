import { describe, expect, it } from "vitest";
import { ASSETS } from "../src/generated/assets";
import { call, MAIN, upload } from "./helpers";

// Emoji and decorative dingbats render differently on every system, so the site draws its icons as SVG (src/site/icons.ts). © ® ™ are legal marks, not decoration; arrows (→ ←) and ⌘ are plain typography and allowed.
const FORBIDDEN = /(?![©®™])[\p{Extended_Pictographic}✿✦✓✔♡❀☆★❤]/u;

function offenders(text: string): string[] {
  return [...new Set([...text.matchAll(new RegExp(FORBIDDEN.source, "gu"))].map((m) => `${m[0]} U+${m[0].codePointAt(0)!.toString(16).toUpperCase()}`))];
}

const ON: Partial<Env> = {
  FEATURE_ACCOUNTS: "1",
  ACCOUNT_FEATURES: "email,github,google,passkey,sync,tokens",
  FEATURE_CLI: "1",
  DONATE_ALIPAY_QR: "https://files.sugi.moe/qr.webp",
  DONATE_ALIPAY_LINK: "https://qr.alipay.com/test",
  DONATE_THANKS: "阿明",
  MAINLAND_CHINA_FAQ: "1",
};

describe("no emoji", () => {
  it("in any rendered page, in either language", async () => {
    const f = await upload();
    const album = await (
      await call(
        new Request(`${MAIN}/api/albums`, {
          method: "POST",
          body: JSON.stringify({ files: [f.id] }),
          headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer test-trusted-token" },
        }),
      )
    ).json<{ id: string }>();
    const paths = ["/", "/mine", "/dev", "/faq", "/terms", "/privacy", "/donate", "/login", `/f/${f.id}`, `/a/${album.id}`, "/no-such-page"];
    for (const lang of ["zh", "en"]) {
      for (const path of paths) {
        const html = await (await call(new Request(`${MAIN}${path}?lang=${lang}`, { headers: { accept: "text/html" } }), ON)).text();
        expect(offenders(html), `${lang} ${path}`).toEqual([]);
      }
    }
  });

  it("in the install script, the CLI and the page script", async () => {
    const install = await (await call(new Request(`${MAIN}/install.sh`), ON)).text();
    expect(offenders(install)).toEqual([]);
    for (const path of [ASSETS.cli, ASSETS.js]) {
      const res = await call(new Request(`${MAIN}${path}`), ON);
      expect(res.status, path).toBe(200);
      expect(offenders(await res.text()), path).toEqual([]);
    }
  });
});
