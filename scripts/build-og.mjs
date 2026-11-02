// Renders the Open Graph images (1200x630) and the PNG icons from SVG with resvg, writes them to public/static/og and public/static/icons with content-hashed names, and records the names in src/site/og-images.ts. Run after changing the copy below or the artwork:
//
//   scripts/subset-fonts.sh   # downloads the full fonts into ~/.cache/sugi-fonts on first run
//   node scripts/build-og.mjs
//
// The rendered PNGs and the manifest are committed; this script is not part of the regular build.
import { Resvg } from "@resvg/resvg-js";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cache = process.env.SUGI_FONT_CACHE ?? join(homedir(), ".cache/sugi-fonts");
const FONTS = [join(cache, "ZCOOLKuaiLe-Regular.ttf"), join(cache, "Fredoka-500-700.ttf")];

// Headline and subtitle per page and language. Lines break at "\n".
export const OG_COPY = {
  home: { zh: ["把图图交给仓仓吧～", "匿名 · 免费 · 不用注册也能传"], en: ["Hand your pics\nto the hamster~", "Anonymous · free · no sign-up"] },
  dev: { zh: ["给开发者的仓仓", "HTTP API · curl 一行就能传"], en: ["The hamster\nfor developers", "HTTP API · one curl to upload"] },
  faq: { zh: ["问问仓仓", "关于 sugi 的常见问题"], en: ["Ask the hamster", "Questions about sugi"] },
  terms: { zh: ["使用条款", "用 sugi.moe 的规则"], en: ["Terms of use", "The rules of sugi.moe"] },
  privacy: { zh: ["隐私政策", "我们存什么、为什么、存多久"], en: ["Privacy policy", "What we keep, why, and for how long"] },
};

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const HEART = "M8 13 C3 9.5 0.5 7 0.5 4.2 C0.5 2 2.2 0.5 4.2 0.5 C5.8 0.5 7.2 1.5 8 2.8 C8.8 1.5 10.2 0.5 11.8 0.5 C13.8 0.5 15.5 2 15.5 4.2 C15.5 7 13 9.5 8 13 Z";
const STAR = "M0 -12 C1.5 -3 3 -1.5 12 0 C3 1.5 1.5 3 0 12 C-1.5 3 -3 1.5 -12 0 C-3 -1.5 -1.5 -3 0 -12 Z";

// The hamster in its box, from the home page (200x170 units), happy eyes.
const MASCOT = `<g stroke="#4A5646" stroke-width="3" stroke-linejoin="round" stroke-linecap="round">
<path d="M101 40 C100 30 102 20 108 10" fill="none"/>
<ellipse cx="94" cy="26" rx="8" ry="4.5" transform="rotate(-35 94 26)" fill="#8DCB97"/>
<ellipse cx="113" cy="22" rx="8" ry="4.5" transform="rotate(30 113 22)" fill="#9DD3A5"/>
<ellipse cx="109" cy="8" rx="7" ry="4" transform="rotate(-60 109 8)" fill="#B4DEB9"/>
<circle cx="62" cy="58" r="12" fill="#FFFFFF"/><circle cx="138" cy="58" r="12" fill="#FFFFFF"/>
<circle cx="62" cy="58" r="5.5" fill="#F6C3BE" stroke="none"/><circle cx="138" cy="58" r="5.5" fill="#F6C3BE" stroke="none"/>
<path d="M42 132 C38 72 64 46 100 46 C136 46 162 72 158 132 Z" fill="#FFFFFF"/>
<path d="M84 56 C90 51 110 51 116 56" fill="none" stroke="#EADFC9" stroke-width="5"/>
<path d="M73 87 Q80 78 87 87" fill="none"/><path d="M113 87 Q120 78 127 87" fill="none"/>
<ellipse cx="68" cy="96" rx="8.5" ry="5" fill="#F6C3BE" stroke="none"/><ellipse cx="132" cy="96" rx="8.5" ry="5" fill="#F6C3BE" stroke="none"/>
<path d="M98 90 L102 90 L100 92.5 Z" fill="#4A5646" stroke-width="2"/>
<path d="M93 95 Q96.5 99 100 95 Q103.5 99 107 95" fill="none" stroke-width="2.5"/>
<g transform="translate(0 108)">
<rect x="30" y="16" width="140" height="42" rx="8" fill="#EDC28E"/>
<path d="M32 31 H168 M32 45 H168" fill="none" stroke="#CF9A62" stroke-width="2.5"/>
<rect x="24" y="6" width="152" height="16" rx="7" fill="#F5D3A6"/>
<ellipse cx="74" cy="8" rx="11" ry="7.5" fill="#FFFFFF"/><ellipse cx="126" cy="8" rx="11" ry="7.5" fill="#FFFFFF"/>
<path d="M71 6 V10 M77 6 V10 M123 6 V10 M129 6 V10" fill="none" stroke-width="1.8"/>
<rect x="82" y="29" width="36" height="20" rx="6" fill="#FFFFFF" stroke-width="2.5"/>
<text x="100" y="43.5" text-anchor="middle" font-family="Fredoka" font-weight="700" font-size="12" fill="#4A5646" stroke="none">sugi</text>
</g>
</g>`;

const FACE = `<g stroke="#4A5646" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round">
<path d="M24.5 13 C24.3 9 25 6 27 3" fill="none"/>
<ellipse cx="22" cy="7.5" rx="3.6" ry="2.1" transform="rotate(-35 22 7.5)" fill="#8DCB97"/>
<ellipse cx="29" cy="6" rx="3.6" ry="2.1" transform="rotate(30 29 6)" fill="#9DD3A5"/>
<circle cx="11" cy="18" r="5" fill="#FFFFFF"/><circle cx="37" cy="18" r="5" fill="#FFFFFF"/>
<circle cx="11" cy="18" r="2.2" fill="#F6C3BE" stroke="none"/><circle cx="37" cy="18" r="2.2" fill="#F6C3BE" stroke="none"/>
<path d="M5 42 C4 24 13 14 24 14 C35 14 44 24 43 42 Z" fill="#FFFFFF"/>
<ellipse cx="17.5" cy="28" rx="2" ry="2.6" fill="#3F4A3C" stroke="none"/><ellipse cx="30.5" cy="28" rx="2" ry="2.6" fill="#3F4A3C" stroke="none"/>
<ellipse cx="13" cy="33" rx="3.2" ry="1.9" fill="#F6C3BE" stroke="none"/><ellipse cx="35" cy="33" rx="3.2" ry="1.9" fill="#F6C3BE" stroke="none"/>
<path d="M21.5 32 Q22.75 33.6 24 32 Q25.25 33.6 26.5 32" fill="none" stroke-width="1.6"/>
</g>`;

function ogSvg(lang, [headline, subtitle]) {
  const lines = headline.split("\n");
  const size = lang === "zh" ? (headline.length > 8 ? 62 : 84) : lines.length > 1 ? 66 : 72;
  const lineH = size * 1.15;
  const top = 300 - ((lines.length - 1) * lineH) / 2;
  const headFont = lang === "zh" ? "ZCOOL KuaiLe" : "Fredoka";
  const headWeight = lang === "zh" ? 400 : 700;
  const textX = 600;
  const head = (dx, dy, fill) =>
    `<text x="${textX + dx}" y="${top + dy}" font-family="${headFont}" font-weight="${headWeight}" font-size="${size}" fill="${fill}">${lines.map((l, i) => `<tspan x="${textX + dx}" dy="${i ? lineH : 0}">${esc(l)}</tspan>`).join("")}</text>`;
  const subY = top + (lines.length - 1) * lineH + 70;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><pattern id="dots" width="60" height="60" patternUnits="userSpaceOnUse"><circle cx="8" cy="8" r="4" fill="#E8EBD9"/><circle cx="38" cy="38" r="4" fill="#E8EBD9"/></pattern></defs>
<rect width="1200" height="630" fill="#F6F4EA"/>
<rect width="1200" height="630" fill="url(#dots)"/>
<path d="${STAR}" transform="translate(110 110) scale(1.3)" fill="#C9DFB8"/>
<path d="${STAR}" transform="translate(520 560) scale(0.9)" fill="#C9DFB8"/>
<path d="${HEART}" transform="translate(1080 70) scale(2.6)" fill="none" stroke="#F4B6B0" stroke-width="1.2"/>
<g transform="translate(1100 520)" fill="#BFD9AE"><circle r="7" cx="0" cy="-12"/><circle r="7" cx="11" cy="-4"/><circle r="7" cx="7" cy="10"/><circle r="7" cx="-7" cy="10"/><circle r="7" cx="-11" cy="-4"/><circle r="5" fill="#F6F4EA"/></g>
<ellipse cx="300" cy="520" rx="210" ry="26" fill="#E8EBD9"/>
<g transform="translate(70 115) scale(2.3)">${MASCOT}</g>
<g transform="translate(${textX} 70)">
<rect x="0" y="0" width="258" height="70" rx="35" fill="#D6E2C8"/>
<rect x="0" y="-6" width="258" height="70" rx="35" fill="#FFFFFF" stroke="#D6E2C8" stroke-width="3"/>
<g transform="translate(16 2) scale(1.15)">${FACE}</g>
<text x="80" y="42" font-family="Fredoka" font-weight="700" font-size="34" fill="#3F4A3C">sugi</text>
<path d="${HEART}" transform="translate(150 20) scale(1.25)" fill="#F4A6A0"/>
<text x="174" y="42" font-family="Fredoka" font-weight="700" font-size="34" fill="#3F4A3C">moe</text>
</g>
${head(4, 4, "#E1EDD3")}
${head(0, 0, "#3F4A3C")}
<text x="${textX}" y="${subY}" font-family="${lang === "zh" ? "ZCOOL KuaiLe" : "Fredoka"}" font-weight="500" font-size="32" fill="#66705F">${esc(subtitle)}</text>
<rect x="${textX}" y="${subY + 34}" width="250" height="44" rx="22" fill="#EAF3E3"/>
<text x="${textX + 125}" y="${subY + 64}" text-anchor="middle" font-family="Fredoka" font-weight="600" font-size="22" fill="#3F7A50">kawaii-sugi f&#8204;ile host</text>
<text x="1140" y="600" text-anchor="end" font-family="Fredoka" font-weight="700" font-size="30" fill="#4E8A5F">sugi.moe</text>
</svg>`;
}

const FAVICON = readFileSync("public/static/favicon.svg", "utf8");

function iconSvg(size, background) {
  // The favicon artwork centred on an optional rounded cream tile (apple-touch-icon and app icons).
  const inner = FAVICON.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const pad = background ? size * 0.14 : 0;
  const s = (size - 2 * pad) / 48;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : ""}<g transform="translate(${pad} ${pad}) scale(${s})" stroke="#4A5646" stroke-width="2.4" stroke-linejoin="round">${inner}</g></svg>`;
}

function render(svg) {
  return new Resvg(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "ZCOOL KuaiLe" }, fitTo: { mode: "original" } }).render().asPng();
}

function writeHashed(dir, name, png) {
  const hash = createHash("sha256").update(png).digest("hex").slice(0, 10);
  const file = `${name}-${hash}.png`;
  writeFileSync(join("public/static", dir, file), png);
  return `/static/${dir}/${file}`;
}

for (const dir of ["og", "icons"]) {
  mkdirSync(join("public/static", dir), { recursive: true });
  for (const f of readdirSync(join("public/static", dir))) rmSync(join("public/static", dir, f));
}

const og = {};
for (const [page, copy] of Object.entries(OG_COPY)) {
  for (const lang of ["zh", "en"]) {
    const svg = ogSvg(lang, copy[lang]);
    og[`${page}-${lang}`] = writeHashed("og", `${page}-${lang}`, render(svg));
    if (process.env.SUGI_OG_SVG_OUT) writeFileSync(join(process.env.SUGI_OG_SVG_OUT, `${page}-${lang}.svg`), svg);
  }
}

const icons = {
  png32: writeHashed("icons", "favicon-32", render(iconSvg(32, null))),
  png192: writeHashed("icons", "icon-192", render(iconSvg(192, "#F6F4EA"))),
  png512: writeHashed("icons", "icon-512", render(iconSvg(512, "#F6F4EA"))),
  apple: writeHashed("icons", "apple-touch-icon", render(iconSvg(180, "#F6F4EA"))),
};

writeFileSync(
  "src/site/og-images.ts",
  `// Written by scripts/build-og.mjs; do not edit by hand. Rendered PNGs live in public/static/og and public/static/icons.\nexport const OG_IMAGES: Record<string, string> = ${JSON.stringify(og, null, 2)};\n\nexport const ICONS = ${JSON.stringify(icons, null, 2)} as const;\n`,
);
console.log(`og: ${Object.keys(og).length} images, icons: ${Object.keys(icons).length}`);
