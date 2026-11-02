export type Lang = "en" | "zh";

/** Picks the page language: an explicit ?lang= wins, then the lang cookie set by the switcher, then the first zh/en entry in Accept-Language, then English. */
export function pickLang(query: string | null, cookie: string | null, acceptLanguage: string | null): Lang {
  if (query === "en" || query === "zh") return query;
  if (cookie === "en" || cookie === "zh") return cookie;
  for (const part of (acceptLanguage ?? "").split(",")) {
    const tag = part.split(";")[0].trim().toLowerCase();
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// JSON inside a <script> element must not be able to close it.
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
