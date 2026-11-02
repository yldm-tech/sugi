// Chinese lead paragraphs must never break inside a word or phrase (a line ending in 「业」 with 「余维护」 on the next one). Each sentence becomes its own line, and each clause between Chinese punctuation an unbreakable unit, so text wraps only between clauses; only a clause wider than the whole line could still be split. Markup inside a paragraph (links, code) is never cut: splits happen only outside tags.

const SENTENCE_END = new Set(["。", "！", "？"]);
const CLAUSE_END = new Set(["，", "；", "：", "、"]);
const VOID = new Set(["br", "img", "wbr", "input", "hr"]);

/** Splits HTML at top-level characters (outside any element) for which `at` is true; the split character stays with the part before it. */
function splitTopLevel(html: string, at: (ch: string) => boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (ch === "<") {
      const end = html.indexOf(">", i);
      if (end < 0) break;
      const tag = html.slice(i + 1, end);
      const name = tag
        .replace(/^\//, "")
        .split(/[\s/>]/)[0]
        .toLowerCase();
      if (tag.startsWith("/")) depth = Math.max(0, depth - 1);
      else if (!VOID.has(name) && !tag.endsWith("/")) depth++;
      i = end;
      continue;
    }
    if (depth === 0 && at(ch)) {
      parts.push(html.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < html.length) parts.push(html.slice(start));
  return parts.filter((p) => p.trim() !== "");
}

/** The inside of one Chinese lead paragraph, as sentence lines made of clause units. */
export function phraseHtml(inner: string): string {
  return splitTopLevel(inner, (c) => SENTENCE_END.has(c))
    .map(
      (sentence) =>
        `<span class="sent">${splitTopLevel(sentence, (c) => CLAUSE_END.has(c))
          .map((p) => `<span class="ph">${p.trim()}</span>`)
          .join("")}</span>`,
    )
    .join("");
}

/** Applies phraseHtml to every lead paragraph of a Chinese page (`<p class="lead…">`, and the 404 page's text). */
export function phraseLeads(main: string, lang: "zh" | "en"): string {
  if (lang !== "zh") return main;
  return main.replace(/<p class="(lead[^"]*)">([\s\S]*?)<\/p>/g, (_, cls: string, inner: string) => `<p class="${cls} phrased">${phraseHtml(inner)}</p>`);
}
