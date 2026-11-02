// Takes the GitHub and Google logos from our icon library @yldm-tech/ai-logo and writes them as static SVG strings to src/site/brand-icons.ts, so the site uses the library's artwork without React at runtime and without hand-copied paths. Run after changing VERSION:
//
//   node scripts/build-brand-icons.mjs
//
// The package tarball is checked against the registry's integrity hash before anything is read from it; nothing from the package is executed. The library's license is copied into THIRD_PARTY_NOTICES.md.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "1.14.0";
const TARBALL = `https://registry.npmjs.org/@yldm-tech/ai-logo/-/ai-logo-${VERSION}.tgz`;
const INTEGRITY = "sha512-s5QVAHn+RbXLgySkqHyN+r90M7mmqXa39012pXWENnNgJDuZ2MwE1XQUaMMfPLtMVHfXo9NW/ufPteitxZ9MwA==";
// Brand-correct variants: GitHub in one colour that follows the text (day and night), Google in its colours.
const ICONS = { github: "package/es/Github/components/Mono.mjs", google: "package/es/Google/components/Color.mjs" };

const res = await fetch(TARBALL);
if (!res.ok) throw new Error(`download failed: ${res.status}`);
const tgz = Buffer.from(await res.arrayBuffer());
const actual = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;
if (actual !== INTEGRITY) throw new Error(`integrity mismatch: ${actual}`);

const dir = mkdtempSync(join(tmpdir(), "ai-logo-"));
try {
  writeFileSync(join(dir, "pkg.tgz"), tgz);
  execFileSync("tar", ["-xzf", join(dir, "pkg.tgz"), "-C", dir, ...Object.values(ICONS), "package/LICENSE"]);

  // The components are generated JSX: one <svg> with attributes and <path> children. Read the attributes as data.
  const str = (src, key) => new RegExp(`\\b${key}: "([^"]*)"`).exec(src)?.[1];
  const svg = (src) => {
    const head = src.slice(0, src.indexOf("children:"));
    const attrs = { viewBox: str(head, "viewBox"), fill: str(head, "fill"), "fill-rule": str(head, "fillRule") };
    const paths = [...src.matchAll(/jsx\("path", \{\s*d: "([^"]+)"(?:,\s*fill: "([^"]+)")?\s*\}\)/g)].map(
      ([, d, fill]) => `<path d="${d}"${fill ? ` fill="${fill}"` : ""}/>`,
    );
    if (!attrs.viewBox || paths.length === 0) throw new Error("unexpected icon source");
    const a = Object.entries(attrs)
      .filter(([, v]) => v)
      .map(([k, v]) => ` ${k}="${v}"`)
      .join("");
    return `<svg xmlns="http://www.w3.org/2000/svg"${a} width="18" height="18" aria-hidden="true" focusable="false" class="brand-icon">${paths.join("")}</svg>`;
  };
  const out = Object.fromEntries(Object.entries(ICONS).map(([name, file]) => [name, svg(readFileSync(join(dir, file), "utf8"))]));
  writeFileSync(
    "src/site/brand-icons.ts",
    `// Written by scripts/build-brand-icons.mjs from @yldm-tech/ai-logo ${VERSION} (MIT, see THIRD_PARTY_NOTICES.md); do not edit by hand.\nexport const BRAND_ICONS: Record<string, string> = ${JSON.stringify(out, null, 2)};\n`,
  );

  const license = readFileSync(join(dir, "package/LICENSE"), "utf8").trim();
  writeFileSync(
    "THIRD_PARTY_NOTICES.md",
    `# Third-party notices\n\n## @yldm-tech/ai-logo ${VERSION}\n\nThe GitHub and Google logos on the login and account pages (\`src/site/brand-icons.ts\`) are taken from [@yldm-tech/ai-logo](https://github.com/yldm-tech/ai-logo).\n\n\`\`\`\n${license}\n\`\`\`\n\n## Fonts\n\nZCOOL KuaiLe and Fredoka are under the SIL Open Font License 1.1; see \`public/static/fonts/OFL-ZCOOLKuaiLe.txt\` and \`public/static/fonts/OFL-Fredoka.txt\`.\n`,
  );
  console.log(`brand icons from @yldm-tech/ai-logo ${VERSION}: ${Object.keys(out).join(", ")}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
