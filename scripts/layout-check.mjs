// Responsive layout check: opens every page at phone, tablet and desktop widths, in Chinese and English, day and night, and fails if anything makes the page scroll sideways or sticks out of the viewport. Optionally saves screenshots.
//
//   node scripts/layout-check.mjs [BASE_URL] [--shots DIR] [--widths 360,390,...]
//
// BASE_URL defaults to the staging Worker (https://sugi-staging.evan-e2b.workers.dev); CI passes http://localhost:8787 (`npm run dev`). The instance must accept anonymous uploads (no UPLOAD_TOKEN); for the 451 page it needs its admin token: LAYOUT_ADMIN_TOKEN, else ADMIN_TOKEN from ~/.config/sugi/staging.env for the staging Worker, else "layout-check-admin" (the local and CI value); it creates a few synthetic files and an album, and takes one of them down.
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const shots = shotsAt >= 0 ? args[shotsAt + 1] : null;
const widthsAt = args.indexOf("--widths");
const widths = (widthsAt >= 0 ? args[widthsAt + 1] : "360,390,430,600,768,1024,1280").split(",").map(Number);
const STAGING = "https://sugi-staging.evan-e2b.workers.dev";
const base = (args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? STAGING).replace(/\/$/, "");
const stagingAdmin = () => {
  try {
    return /^ADMIN_TOKEN=(.*)$/m.exec(readFileSync(`${homedir()}/.config/sugi/staging.env`, "utf8"))?.[1];
  } catch {
    return undefined;
  }
};
const adminToken = process.env.LAYOUT_ADMIN_TOKEN ?? (base === STAGING ? stagingAdmin() : undefined) ?? "layout-check-admin";
if (shots) mkdirSync(shots, { recursive: true });

// A real (random-coloured, 64x48) PNG, so thumbnails and previews render like a photo would.
function png() {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, sum]);
  };
  const w = 64;
  const h = 48;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const [r, g, b] = randomBytes(3);
  const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: w }, (_, x) => Buffer.from([r, (g + x * 2) & 255, b]))]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function upload(name) {
  const res = await fetch(`${base}/api/upload?name=${encodeURIComponent(name)}`, { method: "PUT", body: png(), headers: { accept: "application/json" } });
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const files = [await upload("a-rather-long-file-name-for-a-screenshot-taken-on-a-phone.png"), await upload("cat.png"), await upload("dog.png")];
const album = await (
  await fetch(`${base}/api/albums`, {
    method: "POST",
    body: JSON.stringify({ files: files.map((f) => f.id), title: "周报配图 · weekly report pictures" }),
    headers: { "content-type": "application/json", accept: "application/json" },
  })
).json();
const removed = await upload("removed.png");
await fetch(`${base}/api/files/${removed.id}`, { method: "DELETE", headers: { authorization: `Bearer ${adminToken}` } });

const history = files.map((f, i) => ({
  id: f.id,
  url: f.url,
  page: f.page,
  name: f.name,
  size: f.size,
  ext: "png",
  kind: "image",
  token: f.delete_token,
  expiresAt: i === 1 ? Date.now() + 3600e3 : null,
  createdAt: Date.now() - i * 60e3,
  thumb: null,
}));
const albumsLocal = [{ id: album.id, url: album.url, title: album.title, token: album.delete_token, fileIds: files.map((f) => f.id), createdAt: Date.now() }];
const pages = [
  ["home", "/"],
  ["mine", "/mine"],
  ["mine-albums", "/mine#albums"],
  ["file", `/f/${files[0].id}`],
  ["album", `/a/${album.id}`],
  // ?report=failed opens the report form with its notice.
  ["file-report", `/f/${files[0].id}?report=failed`],
  ["album-report", `/a/${album.id}?report=failed`],
  ["dev", "/dev"],
  ["dev-cli", "/dev#cli"],
  ["dev-mcp", "/dev#mcp"],
  ["dev-tools", "/dev#tools"],
  ["faq", "/faq"],
  // Only exists when the instance has a payment method (the CI run sets DONATE_ALIPAY_LINK); otherwise this checks the 404 page again.
  ["donate", "/donate"],
  ["terms", "/terms"],
  ["privacy", "/privacy"],
  ["login", "/login"],
  ["login-sent", "/login?sent=1"],
  ["404", "/nope"],
  ["451", `/f/${removed.id}`],
];

// Elements whose right edge passes the viewport, ignoring content inside boxes that scroll or clip on their own.
const findOverflow = () => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") return true;
    }
    return false;
  };
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const s = getComputedStyle(el);
    if (s.position === "fixed" || s.visibility === "hidden") continue;
    if ((r.right > vw + 1 || r.left < -1) && !clipped(el))
      out.push(
        `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : ""} (${Math.round(r.left)}..${Math.round(r.right)} of ${vw})`,
      );
  }
  return { scroll: document.documentElement.scrollWidth - vw, out: out.slice(0, 5) };
};

// The logged-in header check runs with a throwaway passkey account; its cookie, if one could be made.
let session = null;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const problems = [];
try {
  for (const lang of ["zh", "en"]) {
    for (const theme of ["day", "night"]) {
      for (const width of widths) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: lang === "zh" ? "zh-CN" : "en-US" });
        await ctx.addInitScript(
          ([night, hist, albums]) => {
            localStorage.setItem("sugi.prefs.v1", JSON.stringify({ night }));
            localStorage.setItem("sugi.history.v1", JSON.stringify(hist));
            localStorage.setItem("sugi.albums.v1", JSON.stringify(albums));
          },
          [theme === "night", history, albumsLocal],
        );
        const page = await ctx.newPage();
        page.on("pageerror", (e) => problems.push(`${lang}/${theme}/${width}: script error ${e}`));
        for (const [name, path] of pages) {
          const [p, hash] = path.split("#");
          await page.goto(`${base}${p}${p.includes("?") ? "&" : "?"}lang=${lang}${hash ? `#${hash}` : ""}`);
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(150);
          const r = await page.evaluate(findOverflow);
          if (r.scroll > 1 || r.out.length) problems.push(`${name} ${lang}/${theme}/${width}px: page scrolls sideways by ${r.scroll}px; ${r.out.join(", ")}`);
          if (shots && theme === "day" && (lang === "zh" || width === 390))
            await page.screenshot({ path: `${shots}/${lang}-${name}-${width}.png`, fullPage: true });
        }
        await ctx.close();
      }
    }
  }
  // Header: at every width from phone to wide desktop, logged out and logged in (the links differ), no link or the wordmark may wrap onto a second line, and the single-row header must really fit; otherwise the page has to use the compact header.
  const headerWidths = [360, 390, 430, 600, 768, 900, 1024, 1100, 1200, 1280, 1300, 1366, 1400, 1440, 1536, 1600, 1920];
  const headerCheck = () => {
    const out = [];
    const els = [
      document.querySelector(".brand-word"),
      document.querySelector(".brand"),
      ...document.querySelectorAll("#nav .pill"),
      ...document.querySelectorAll(".tools > *"),
    ];
    for (const el of els) {
      if (!el) continue;
      const h1 = el.getBoundingClientRect().height;
      const old = el.style.whiteSpace;
      el.style.whiteSpace = "nowrap";
      for (const c of el.querySelectorAll("*")) c.style.whiteSpace = "nowrap";
      const h2 = el.getBoundingClientRect().height;
      el.style.whiteSpace = old;
      for (const c of el.querySelectorAll("*")) c.style.whiteSpace = "";
      if (h1 > h2 + 2) out.push(`${el.className || el.tagName} wraps (${Math.round(h1)}px tall, ${Math.round(h2)}px on one line)`);
    }
    const top = document.querySelector(".top");
    const nav = document.querySelector("#nav");
    if (!top.classList.contains("compact")) {
      const parts = [".brand", "#nav", ".tools"].map((q) => document.querySelector(q).getBoundingClientRect());
      if (Math.max(...parts.map((r) => r.top)) - Math.min(...parts.map((r) => r.top)) > 4) out.push("single-row header items are not on one row");
      if (nav.scrollWidth > nav.clientWidth + 1) out.push(`single-row nav overflows by ${nav.scrollWidth - nav.clientWidth}px`);
    }
    return out;
  };
  const loggedIn = [false];
  // Logging in takes a passkey account (Chromium's virtual authenticator); instances without passkeys only get the logged-out check.
  {
    const ctx = await browser.newContext();
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
    if ((await page.locator("[data-passkey-register]").count()) > 0) {
      await Promise.all([page.waitForURL(/\/account\?welcome=1$/, { timeout: 15000 }), page.locator("[data-passkey-register]").first().click()]).catch(
        () => undefined,
      );
      session = (await ctx.cookies()).find((c) => c.name === "sugi_session") ?? null;
      if (session) loggedIn.push(true);
    }
    await ctx.close();
  }
  for (const user of loggedIn) {
    for (const lang of ["zh", "en"]) {
      const ctx = await browser.newContext({ locale: lang === "zh" ? "zh-CN" : "en-US" });
      if (user) await ctx.addCookies([session]);
      const page = await ctx.newPage();
      page.on("pageerror", (e) => problems.push(`header ${lang}: script error ${e}`));
      for (const width of headerWidths) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`${base}/?lang=${lang}`);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(100);
        for (const p of await page.evaluate(headerCheck)) problems.push(`header ${lang}/${user ? "logged in" : "logged out"}/${width}px: ${p}`);
        if (shots && (width === 1300 || width === 1440) && lang === "zh")
          await page.screenshot({ path: `${shots}/zh-header-${user ? "user" : "anon"}-${width}.png`, clip: { x: 0, y: 0, width, height: 140 } });
      }
      await ctx.close();
    }
  }
  if (session) {
    // Leave nothing behind: delete the test account.
    const ctx = await browser.newContext();
    await ctx.addCookies([session]);
    const page = await ctx.newPage();
    await page.goto(`${base}/`);
    await page.evaluate(async () =>
      fetch("/api/me", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ delete_files: true }) }),
    );
    await ctx.close();
  }
} finally {
  await browser.close();
}
for (const f of [...files, removed]) await fetch(`${base}/api/files/${f.id}`, { method: "DELETE", headers: { "sugi-token": f.delete_token } });
await fetch(`${base}/api/albums/${album.id}`, { method: "DELETE", headers: { "sugi-token": album.delete_token } });
if (problems.length) {
  console.log(problems.join("\n"));
  console.log(`${problems.length} layout problem(s)`);
  process.exit(1);
}
console.log(
  `no layout problems (${pages.length} pages x ${widths.length} widths x 2 languages x 2 themes; header at 17 widths, logged out${session ? " and in" : ""})`,
);
