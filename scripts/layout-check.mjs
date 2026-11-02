// Responsive layout check: opens every page at phone, tablet and desktop widths, in Chinese and English, day and night, and fails if anything makes the page scroll sideways or sticks out of the viewport. Optionally saves screenshots.
//
//   node scripts/layout-check.mjs [BASE_URL] [--shots DIR] [--widths 360,390,...]
//
// BASE_URL defaults to http://localhost:8787 (`npm run dev`). The instance must accept anonymous uploads (no UPLOAD_TOKEN) and have ADMIN_TOKEN set to LAYOUT_ADMIN_TOKEN (default "layout-check-admin") for the 451 page; it creates a few synthetic files and an album, and takes one of them down.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const shots = shotsAt >= 0 ? args[shotsAt + 1] : null;
const widthsAt = args.indexOf("--widths");
const widths = (widthsAt >= 0 ? args[widthsAt + 1] : "360,390,430,600,768,1024,1280").split(",").map(Number);
const adminToken = process.env.LAYOUT_ADMIN_TOKEN ?? "layout-check-admin";
const base = (args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "http://localhost:8787").replace(/\/$/, "");
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
  ["faq", "/faq"],
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
console.log(`no layout problems (${pages.length} pages x ${widths.length} widths x 2 languages x 2 themes)`);
