// sugi.moe browser script: uploads, "My files", the hamster, and page-to-page navigation without full reloads (so running uploads keep going). Ported from the design's React component to plain DOM code. No inline styles: the page CSP only allows nonce'd style elements, so dynamic values go through the CSSOM.
import { stripMetadata } from "./exif";
import { initAccount } from "./account";

// ---------------------------------------------------------------- config

interface Config {
  lang: "zh" | "en";
  page: string;
  gated: boolean;
  flags: { accounts: boolean; account: string[]; cli: boolean; donate: boolean; video: "anyone" | "account" | "trusted" };
  user?: boolean;
  origins: { main: string; files: string; tmp: string };
  limits: { maxFile: number; single: number; rate: number; ratePeriod: number; waf: { limit: number; period: number } | null };
  t: Record<string, string>;
}

const CFG: Config = JSON.parse(document.getElementById("sugi-config")!.textContent || "{}");
const T = CFG.t;
const PART_SIZE = 50 * 1024 * 1024;

function fmt(s: string, vars: Record<string, string | number> = {}): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? "" : String(vars[k])));
}

// biome-ignore lint/suspicious/noExplicitAny: event handlers of any event type
type Attrs = Record<string, string | number | boolean | null | undefined | ((e: any) => void)>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const $ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<E>(sel);
const $$ = <E extends Element = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll<E>(sel));

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

const LOCALE = CFG.lang === "zh" ? "zh-CN" : "en";

// ---------------------------------------------------------------- storage

interface Prefs {
  night: boolean | null;
  cuteNames: boolean;
  sound: boolean;
  autoCopy: boolean;
  stripExif: boolean;
  fmt: FmtId;
  expiry: ExpiryId;
}
type FmtId = "url" | "md" | "html" | "bb";
type ExpiryId = "perm" | "1h" | "12h" | "72h";

interface HistItem {
  id: string;
  url: string;
  page: string;
  name: string;
  size: number;
  ext: string;
  kind: "image" | "video";
  token: string;
  expiresAt: number | null;
  createdAt: number;
  thumb?: string | null;
  /** Known to the logged-in account (my-files sync); account-only items have no token and are not stored locally. */
  account?: boolean;
}
interface AlbumItem {
  id: string;
  url: string;
  title: string;
  token: string;
  fileIds: string[];
  createdAt: number;
  account?: boolean;
  covers?: string[];
  count?: number;
}

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

const prefs: Prefs = Object.assign(
  { night: null, cuteNames: true, sound: false, autoCopy: true, stripExif: true, fmt: "url", expiry: "perm" } as Prefs,
  load("sugi.prefs.v1", {}),
);
let hist: HistItem[] = load("sugi.history.v1", []);
let albums: AlbumItem[] = load("sugi.albums.v1", []);

function savePrefs() {
  try {
    localStorage.setItem("sugi.prefs.v1", JSON.stringify(prefs));
  } catch {}
}

function persist() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Items that only the account knows about are fetched again on every visit, never stored in the browser.
      localStorage.setItem("sugi.history.v1", JSON.stringify(hist.filter((x) => x.token).map(({ account, ...x }) => x)));
      localStorage.setItem("sugi.albums.v1", JSON.stringify(albums.filter((x) => x.token).map(({ account, covers, count, ...x }) => x)));
      return;
    } catch {
      // Quota: drop thumbnails from the oldest half and retry; links and tokens matter more than previews.
      const half = Math.ceil(hist.length / 2);
      hist = hist.map((x, i) => (i >= half ? { ...x, thumb: null } : x));
    }
  }
}

// Unfinished chunked uploads, so they can continue after a lost connection or a reload: the signed session from the server (valid 24 hours) and the etag of every part already stored. A file is recognised by name, size and modification time when it is picked again.
interface Pending {
  fp: string;
  name: string;
  size: number;
  session: string;
  partSize: number;
  etags: (string | null)[];
  createdAt: number;
}
const PENDING_KEY = "sugi.pending.v1";
const PENDING_TTL = 23 * 3600e3;
let pending: Pending[] = load<Pending[]>(PENDING_KEY, []).filter((p) => Date.now() - p.createdAt < PENDING_TTL);

function savePending() {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {}
}

function dropPending(fp: string) {
  pending = pending.filter((p) => p.fp !== fp);
  savePending();
}

const fingerprint = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

// ---------------------------------------------------------------- toast, copy, sound

let toastTimer = 0;
function toast(msg: string) {
  let el = $("#toast");
  if (!el) {
    el = h("div", { class: "toast", id: "toast", role: "status", "aria-live": "polite" });
    $("#overlays")!.append(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el!.hidden = true), 1800);
}

async function copy(text: string, msg = T.copied) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", { class: "sr-only" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {}
    ta.remove();
  }
  toast(msg);
}

let audio: AudioContext | null = null;
function chirp() {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: older Safari exposes webkitAudioContext only
    const C = window.AudioContext || (window as any).webkitAudioContext;
    if (!C) return;
    audio = audio || new C();
    const ac = audio!;
    const t = ac.currentTime;
    for (const off of [0, 0.11]) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(1700, t + off);
      o.frequency.exponentialRampToValueAtTime(2900, t + off + 0.07);
      g.gain.setValueAtTime(0.0001, t + off);
      g.gain.exponentialRampToValueAtTime(0.18, t + off + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.09);
      o.connect(g).connect(ac.destination);
      o.start(t + off);
      o.stop(t + off + 0.1);
    }
  } catch {}
}

// ---------------------------------------------------------------- link formats

function isImage(x: { kind: string }) {
  return x.kind === "image";
}
function fmtLink(x: { url: string; name: string; kind: string }, k: FmtId = prefs.fmt): string {
  const img = isImage(x);
  if (k === "md") return img ? `![${x.name}](${x.url})` : `[${x.name}](${x.url})`;
  if (k === "html") return img ? `<img src="${x.url}" alt="${x.name}">` : `<video src="${x.url}" controls></video>`;
  if (k === "bb") return img ? `[img]${x.url}[/img]` : `[url=${x.url}]${x.name}[/url]`;
  return x.url;
}
const FMTS: { id: FmtId; label: string }[] = [
  { id: "url", label: T.fmtUrl },
  { id: "md", label: T.fmtMd },
  { id: "html", label: T.fmtHtml },
  { id: "bb", label: T.fmtBb },
];
function renderFmtSegs() {
  for (const seg of $$("[data-fmt-seg]")) {
    seg.replaceChildren(
      ...FMTS.map((f) =>
        h("button", {
          type: "button",
          class: f.id === prefs.fmt ? "on" : "",
          text: f.label,
          onclick: () => {
            prefs.fmt = f.id;
            savePrefs();
            renderFmtSegs();
          },
        }),
      ),
    );
  }
}

function expInfo(expiresAt: number | null, now = Date.now()): { label: string; cls: string; expired: boolean } {
  if (!expiresAt) return { label: T.expPerm, cls: "", expired: false };
  const d = expiresAt - now;
  if (d <= 0) return { label: T.expGone, cls: "gone", expired: true };
  const label =
    d < 3600e3
      ? fmt(T.expMin, { n: Math.ceil(d / 60e3) })
      : d < 86400e3
        ? fmt(T.expHour, { n: Math.ceil(d / 3600e3) })
        : fmt(T.expDay, { n: Math.ceil(d / 86400e3) });
  return { label, cls: "tmp", expired: false };
}

// ---------------------------------------------------------------- uploads

interface Upload {
  key: string;
  file: File | null;
  remote: string | null;
  name: string;
  size: number;
  ext: string;
  kind: "image" | "video";
  pct: number;
  status: "queued" | "up" | "done" | "err" | "wait" | "paused";
  error: string | null;
  thumb: string | null;
  local: string | null;
  res: HistItem | null;
  /** Rate limited: when to try again (ms), and how many times it was put back. */
  waitUntil?: number;
  attempts?: number;
  /** The failure is worth another try (network trouble, rate limit), so the error shows a retry button. */
  retryable?: boolean;
  /** Shown under the bar while a chunked upload waits (e.g. for the network to come back). */
  note?: string | null;
  /** The request in flight, so the upload can be cancelled. */
  req?: XMLHttpRequest | null;
  cancelled?: boolean;
  /** Fingerprint of an unfinished chunked upload this entry stands for (status "paused", restored after a reload). */
  fp?: string;
}

let uploads: Upload[] = [];
let uploadSeq = 0;
let active = 0;
const MAX_PARALLEL = 2;

function extOf(name: string): string {
  return (name.includes(".") ? name.split(".").pop()! : "").toLowerCase().slice(0, 5);
}
function kindOf(file: File | null, name: string): "image" | "video" {
  if (file?.type.startsWith("video/")) return "video";
  return /^(mp4|webm|mov|m4v)$/.test(extOf(name)) ? "video" : "image";
}

function makeThumb(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const u = URL.createObjectURL(file);
    const done = (src: CanvasImageSource | null, w: number, hgt: number) => {
      let d: string | null = null;
      if (src && w && hgt) {
        const s = 160;
        const c = document.createElement("canvas");
        c.width = s;
        c.height = s;
        const r = Math.max(s / w, s / hgt);
        try {
          c.getContext("2d")!.drawImage(src, (s - w * r) / 2, (s - hgt * r) / 2, w * r, hgt * r);
          d = c.toDataURL("image/jpeg", 0.75);
        } catch {}
      }
      URL.revokeObjectURL(u);
      resolve(d);
    };
    if (file.type.startsWith("video/")) {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "metadata";
      v.onloadeddata = () => {
        v.currentTime = Math.min(0.1, v.duration || 0);
      };
      v.onseeked = () => done(v, v.videoWidth, v.videoHeight);
      v.onerror = () => done(null, 0, 0);
      v.src = u;
      return;
    }
    const img = new Image();
    img.onload = () => done(img, img.naturalWidth, img.naturalHeight);
    img.onerror = () => done(null, 0, 0);
    img.src = u;
  });
}

// biome-ignore lint/suspicious/noExplicitAny: error bodies are untrusted JSON of unknown shape
function errorFor(status: number, body: any, retryAfter: string | null): string {
  if (status === 401) return T.errGated;
  if (status === 413) return T.errTooBig;
  if (status === 415) return T.errType;
  if (status === 403 && /video uploads/.test(body?.error ?? "")) return /log in/.test(body.error) ? T.errVideoLogin : T.errVideoClosed;
  if (status === 429 && /quota/.test(body?.error ?? "")) return /log in/.test(body.error) ? T.errQuotaAnon : T.errQuota;
  if (status === 507) return T.errFull;
  if (status === 429) return fmt(T.errRate, { s: retryAfter || "60" });
  if (status === 0) return T.errNetwork;
  return fmt(T.errFailed, { status, msg: body?.error || "" });
}

function queryFor(u: Upload, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra);
  if (prefs.expiry !== "perm") q.set("expire", prefs.expiry);
  q.set("style", prefs.cuteNames ? "cute" : "random");
  if (u.name) q.set("name", u.name);
  return q.toString();
}

interface XhrResult {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: untrusted JSON of unknown shape
  body: any;
  retryAfter: string | null;
}

function xhr(
  method: string,
  url: string,
  body: Blob | FormData | string | null,
  headers: Record<string, string>,
  onProgress?: (loaded: number) => void,
  owner?: Upload,
): Promise<XhrResult> {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    if (owner) owner.req = x;
    x.open(method, url);
    x.setRequestHeader("Accept", "application/json");
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    if (onProgress) x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => {
      // biome-ignore lint/suspicious/noExplicitAny: untrusted JSON of unknown shape
      let parsed: any = null;
      try {
        parsed = JSON.parse(x.responseText);
      } catch {}
      resolve({ status: x.status, body: parsed, retryAfter: x.getResponseHeader("retry-after") });
    };
    x.onerror = () => resolve({ status: 0, body: null, retryAfter: null });
    x.onabort = () => resolve({ status: 0, body: null, retryAfter: null });
    x.send(body);
  });
}

async function sendFile(u: Upload, blob: Blob, progress: (frac: number) => void): Promise<XhrResult> {
  if (blob.size <= CFG.limits.single) {
    return xhr("PUT", `/api/upload?${queryFor(u)}`, blob, {}, (l) => progress(l / blob.size), u);
  }
  return sendChunked(u, blob, progress);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitOnline = () => (navigator.onLine ? Promise.resolve() : new Promise<void>((r) => window.addEventListener("online", () => r(), { once: true })));

// One request of a chunked upload, retried while the connection is down or the server is busy: waits for the browser to be online again, then backs off 2, 4, 8… up to 30 seconds, for up to 12 tries.
async function retrying(u: Upload, send: () => Promise<XhrResult>): Promise<XhrResult> {
  let r: XhrResult = { status: 0, body: null, retryAfter: null };
  for (let attempt = 0; attempt < 12 && !u.cancelled; attempt++) {
    if (!navigator.onLine) {
      u.note = T.waitingNetwork;
      touch();
      await waitOnline();
    }
    r = await send();
    // A daily quota (429 that says so, or 507) is final; only rate limits, a lost connection and server trouble are worth waiting for.
    if (u.cancelled || (r.status !== 0 && r.status !== 429 && r.status < 500) || r.status === 507 || /quota/.test(r.body?.error ?? "")) break;
    const wait = r.retryAfter ? Math.min(60, Number(r.retryAfter) || 5) * 1000 : Math.min(30, 2 ** (attempt + 1)) * 1000;
    u.note = r.status === 0 ? T.waitingNetwork : r.status === 429 ? fmt(T.waiting, { s: Math.round(wait / 1000) }) : T.retrying;
    touch();
    await sleep(wait);
  }
  u.note = null;
  touch();
  return r;
}

// Chunked upload (Cloudflare caps request bodies). Picks up an unfinished upload of the same file where it stopped.
async function sendChunked(u: Upload, blob: Blob, progress: (frac: number) => void): Promise<XhrResult> {
  const fp = fingerprint(u.file!);
  u.fp = fp;
  // The stored session must describe these exact bytes (photo metadata stripping is deterministic, but check the size anyway).
  let p = pending.find((x) => x.fp === fp && x.size === blob.size);
  if (!p) {
    const first = await retrying(u, () =>
      xhr("POST", `/api/uploads?${queryFor(u, { size: String(blob.size) })}`, blob.slice(0, PART_SIZE), {}, (l) => progress(l / blob.size), u),
    );
    if (first.status !== 201) return first;
    const parts = Number(first.body.parts);
    p = {
      fp,
      name: u.name,
      size: blob.size,
      session: first.body.upload,
      partSize: Number(first.body.part_size),
      etags: Array(parts).fill(null),
      createdAt: Date.now(),
    };
    p.etags[0] = first.body.etag;
    pending = [...pending.filter((x) => x.fp !== fp), p];
    savePending();
  }
  const cur = p;
  const head = { "Sugi-Upload": cur.session };
  const doneBytes = () => cur.etags.reduce((a, e, i) => a + (e ? Math.min(cur.partSize, blob.size - i * cur.partSize) : 0), 0);
  progress(doneBytes() / blob.size);
  for (let n = 2; n <= cur.etags.length; n++) {
    if (cur.etags[n - 1]) continue;
    const start = (n - 1) * cur.partSize;
    const base = doneBytes();
    const r = await retrying(u, () =>
      xhr("PUT", `/api/uploads/${n}`, blob.slice(start, start + cur.partSize), head, (l) => progress((base + l) / blob.size), u),
    );
    if (u.cancelled) return r;
    if (r.status !== 200) {
      // An expired or unknown session cannot be resumed; anything else (still offline after all retries) keeps it for later.
      if (r.status === 401 || r.status === 410) dropPending(fp);
      return r;
    }
    cur.etags[n - 1] = r.body.etag;
    savePending();
  }
  const done = await retrying(u, () =>
    xhr("POST", "/api/uploads/complete", JSON.stringify({ etags: cur.etags }), { ...head, "Content-Type": "application/json" }, undefined, u),
  );
  if (done.status === 201 || (done.status >= 400 && done.status < 500 && done.status !== 429)) dropPending(fp);
  return done;
}

/** Cancels an upload; a chunked one is aborted on the server so its parts do not linger. */
function cancelUpload(u: Upload) {
  u.cancelled = true;
  u.req?.abort();
  const p = u.fp ? pending.find((x) => x.fp === u.fp) : undefined;
  if (p) {
    void xhr("DELETE", "/api/uploads", null, { "Sugi-Upload": p.session });
    dropPending(p.fp);
  }
  uploads = uploads.filter((x) => x !== u);
  touch();
}

// After a reload: unfinished chunked uploads appear in the list; picking the same file again continues them.
let pendingShown = false;
function showPending() {
  if (pendingShown) return;
  pendingShown = true;
  for (const p of pending) {
    if (uploads.some((u) => u.fp === p.fp)) continue;
    const done = p.etags.reduce((a, e, i) => a + (e ? Math.min(p.partSize, p.size - i * p.partSize) : 0), 0);
    uploads.push({
      key: `u${++uploadSeq}`,
      file: null,
      remote: null,
      name: p.name,
      size: p.size,
      ext: extOf(p.name),
      kind: kindOf(null, p.name),
      pct: (done / p.size) * 100,
      status: "paused",
      error: null,
      thumb: null,
      local: null,
      res: null,
      fp: p.fp,
    });
  }
  touch();
}

async function runUpload(u: Upload) {
  u.status = "up";
  touch();
  let r: XhrResult;
  if (u.remote) {
    // No upload progress for imports: creep towards 90% while the server fetches.
    const timer = window.setInterval(() => {
      u.pct = Math.min(90, u.pct + 4 + Math.random() * 8);
      touch();
    }, 300);
    const form = new FormData();
    form.set("url", u.remote);
    if (prefs.expiry !== "perm") form.set("expire", prefs.expiry);
    form.set("style", prefs.cuteNames ? "cute" : "random");
    r = await xhr("POST", "/api/upload", form, {});
    clearInterval(timer);
  } else {
    let blob: Blob = u.file!;
    if (prefs.stripExif && /^image\/(jpeg|png|webp)$/.test(u.file!.type)) {
      try {
        const cleaned = stripMetadata(new Uint8Array(await u.file!.arrayBuffer()));
        if (cleaned) blob = new Blob([cleaned as BlobPart], { type: u.file!.type });
      } catch {}
    }
    r = await sendFile(u, blob, (frac) => {
      u.pct = Math.min(99, frac * 100);
      touch();
    });
    u.req = null;
    if (u.cancelled) return;
  }
  if (r.status === 201 && r.body && r.body.url) {
    const b = r.body;
    const ext = String(b.url).split(".").pop()!.toLowerCase();
    const item: HistItem = {
      id: b.id,
      url: b.url,
      page: b.page,
      name: b.name || u.name || `${b.id}.${ext}`,
      size: b.size,
      ext,
      kind: String(b.type).startsWith("video/") ? "video" : "image",
      token: b.delete_token,
      expiresAt: b.expires_at ? Date.parse(b.expires_at) : null,
      createdAt: Date.now(),
      thumb: u.thumb,
    };
    u.res = item;
    u.name = item.name;
    u.kind = item.kind;
    u.ext = item.ext;
    u.pct = 100;
    u.status = "done";
    hist = [item, ...hist.filter((x) => x.id !== item.id)];
    persist();
    if (prefs.autoCopy) void copy(fmtLink(item), T.linkCopied);
    if (CFG.page === "home") burst();
    if (prefs.sound) chirp();
  } else if (r.status === 429 && !/quota/.test(r.body?.error ?? "") && (u.attempts ?? 0) < 6) {
    // Rate limited (the Worker's limiter, or the zone WAF rule whose page carries no Retry-After): wait and go again by itself. Daily quota answers are final.
    u.attempts = (u.attempts ?? 0) + 1;
    const base = r.retryAfter ? Number(r.retryAfter) * 1000 : (CFG.limits.waf?.period ?? CFG.limits.ratePeriod) * 1000;
    const backoff = Math.min(60e3, Math.max(base, 2 ** u.attempts * 1000));
    u.waitUntil = Date.now() + backoff + Math.random() * 1500;
    u.status = "wait";
    u.pct = 0;
  } else if (u.fp && pending.some((p) => p.fp === u.fp)) {
    // A chunked upload that could not finish (still offline after the retries): keep it to continue later.
    u.status = "paused";
  } else {
    u.status = "err";
    u.error = errorFor(r.status, r.body, r.retryAfter);
    u.retryable = r.status === 0 || r.status === 429 || r.status >= 500 ? !/quota/.test(r.body?.error ?? "") && r.status !== 507 : false;
  }
  touch();
}

// Pacing: the start times of recent requests that count against the server's upload limits (one per upload, link import or start of a chunked upload). The queue waits for a free slot instead of running into 429s.
const starts: number[] = [];
let pumpTimer = 0;

function startDelay(now = Date.now()): number {
  const windows: [number, number][] = [[CFG.limits.rate, CFG.limits.ratePeriod * 1000]];
  if (CFG.limits.waf) windows.push([CFG.limits.waf.limit, CFG.limits.waf.period * 1000]);
  let wait = 0;
  for (const [limit, ms] of windows) {
    const recent = starts.filter((t) => now - t < ms);
    // A little headroom: the server's counters are approximate.
    if (recent.length >= limit) wait = Math.max(wait, recent[recent.length - limit] + ms + 300 - now);
  }
  return wait;
}

function pump() {
  while (active < MAX_PARALLEL) {
    const now = Date.now();
    for (const u of uploads) if (u.status === "wait" && (u.waitUntil ?? 0) <= now) u.status = "queued";
    const next = uploads.find((u) => u.status === "queued");
    if (!next) break;
    const delay = startDelay(now);
    if (delay > 0) {
      clearTimeout(pumpTimer);
      pumpTimer = window.setTimeout(pump, delay);
      return;
    }
    starts.push(now);
    while (starts.length > 200) starts.shift();
    active++;
    void runUpload(next).finally(() => {
      active--;
      pump();
    });
  }
  // Wake up for the next item put back after a 429.
  const waiting = uploads.filter((u) => u.status === "wait").map((u) => u.waitUntil ?? 0);
  if (waiting.length) {
    clearTimeout(pumpTimer);
    pumpTimer = window.setTimeout(pump, Math.max(50, Math.min(...waiting) - Date.now()));
  }
}

// Countdown for items waiting after a 429.
window.setInterval(() => {
  if (uploads.some((u) => u.status === "wait")) touch();
}, 1000);

/** Puts an upload back in the queue at once (the retry button). */
function retryNow(u: Upload) {
  u.status = "queued";
  u.error = null;
  u.waitUntil = undefined;
  u.pct = 0;
  touch();
  pump();
}

function addFiles(list: FileList | File[] | null | undefined) {
  const arr = Array.from(list || []);
  if (!arr.length) return;
  if (CFG.page !== "home") void navigate("/");
  let fly = 0;
  for (const file of arr) {
    // Picking a file again that has an unfinished chunked upload continues it; the restored entry makes way for the new one.
    uploads = uploads.filter((x) => !(x.status === "paused" && x.fp === fingerprint(file)));
    const name = file.name || `paste-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.png`;
    const u: Upload = {
      key: `u${++uploadSeq}`,
      file,
      remote: null,
      name,
      size: file.size,
      ext: extOf(name) || (file.type.split("/")[1] ?? ""),
      kind: kindOf(file, name),
      pct: 0,
      status: "queued",
      error: null,
      thumb: null,
      local: null,
      res: null,
    };
    if (file.size > CFG.limits.maxFile) {
      u.status = "err";
      u.error = T.errTooBig;
    } else if (file.type && !/^(image|video)\//.test(file.type)) {
      u.status = "err";
      u.error = T.errType;
    } else if (u.kind === "video" && CFG.flags.video !== "anyone" && !CFG.user) {
      // The server refuses these too (VIDEO_UPLOADS); saying so up front saves sending the bytes.
      u.status = "err";
      u.error = CFG.flags.video === "account" ? T.errVideoLogin : T.errVideoClosed;
    } else {
      u.local = URL.createObjectURL(file);
      void makeThumb(file).then((t) => {
        if (t) {
          u.thumb = t;
          if (u.res) {
            u.res.thumb = t;
            persist();
          }
          touch();
        }
      });
      fly++;
    }
    uploads.unshift(u);
  }
  if (fly) spawnFly(Math.min(fly, 6));
  touch();
  pump();
}

function addUrl(raw: string) {
  const url = raw.trim();
  if (!/^https?:\/\/\S+\.\S+/.test(url)) {
    toast(T.badUrl);
    return;
  }
  const seg = decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() || "remote");
  const u: Upload = {
    key: `u${++uploadSeq}`,
    file: null,
    remote: url,
    name: seg,
    size: 0,
    ext: extOf(seg),
    kind: /\.(mp4|webm)$/i.test(seg) ? "video" : "image",
    pct: 0,
    status: "queued",
    error: null,
    thumb: null,
    local: null,
    res: null,
  };
  uploads.unshift(u);
  spawnFly(1);
  touch();
  pump();
}

// ---------------------------------------------------------------- render scheduling

let raf = 0;
function touch() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    renderResults();
    updateMascot();
    updateTab();
  });
}

function thumbNode(x: Upload, cls: string, onClick?: () => void): HTMLElement {
  const box = h(onClick ? "button" : "div", { class: cls + (onClick ? " zoom" : ""), type: onClick ? "button" : null, onclick: onClick });
  // Failed items show their extension: the local file may not even be an image.
  const src = x.status === "err" ? null : x.thumb || (x.kind === "image" ? x.local || x.res?.url || null : null);
  if (src) box.append(h("img", { src, alt: "" }));
  else box.textContent = x.ext || "?";
  return box;
}

function renderResults() {
  const section = $("#results");
  if (!section) return;
  section.hidden = uploads.length === 0;
  const done = uploads.filter((u) => u.status === "done");
  const ok = uploads.filter((u) => u.status !== "err");
  $("#progress-text")!.textContent = uploads.length ? `${done.length} / ${ok.length}` : "";
  $("#album-session")!.hidden = done.length < 2;
  const list = $("#results-list")!;
  list.replaceChildren(
    ...uploads.map((u) => {
      const body = h(
        "div",
        { class: "body" },
        h("div", { class: "nameline" }, h("span", { class: "name", text: u.name }), h("span", { class: "size", text: u.size ? fmtSize(u.size) : "" })),
      );
      let tail: HTMLElement;
      if (u.status === "done" && u.res) {
        body.append(h("a", { class: "url", href: u.res.url, target: "_blank", rel: "noopener", text: u.res.url }));
        tail = h("button", { type: "button", class: "copybtn", text: T.copy, onclick: () => void copy(fmtLink(u.res!)) });
      } else if (u.status === "err" || u.status === "wait") {
        const waiting = u.status === "wait";
        body.append(
          h("span", {
            class: waiting ? "notetext" : "errtext",
            text: waiting ? fmt(T.waiting, { s: Math.max(1, Math.ceil(((u.waitUntil ?? 0) - Date.now()) / 1000)) }) : u.error || "",
          }),
        );
        const dismiss = h("button", {
          type: "button",
          class: "dismiss",
          "aria-label": T.close,
          text: "×",
          onclick: () => {
            uploads = uploads.filter((x) => x !== u);
            touch();
          },
        });
        tail =
          waiting || u.retryable
            ? h("div", { class: "tailbtns" }, h("button", { type: "button", class: "copybtn", text: T.retry, onclick: () => retryNow(u) }), dismiss)
            : dismiss;
      } else if (u.status === "paused") {
        body.append(h("span", { class: "notetext", text: fmt(u.file ? T.resumeReady : T.resumeHint, { pct: Math.round(u.pct) }) }));
        tail = h(
          "div",
          { class: "tailbtns" },
          h("button", {
            type: "button",
            class: "copybtn",
            text: T.resume,
            onclick: () => {
              if (u.file) {
                u.status = "queued";
                u.cancelled = false;
                touch();
                pump();
              } else $<HTMLInputElement>("#file")?.click();
            },
          }),
          h("button", { type: "button", class: "dismiss", "aria-label": T.cancelUpload, title: T.cancelUpload, text: "×", onclick: () => cancelUpload(u) }),
        );
      } else {
        const fill = h("div", { class: "fill" });
        fill.style.width = `${Math.round(u.pct)}%`;
        const runner = h("div", { class: "runner" });
        runner.innerHTML = RUNNER_SVG;
        runner.style.left = `${Math.round(u.pct)}%`;
        body.append(h("div", { class: "bar" }, h("div", { class: "track" }, fill), runner));
        if (u.status === "queued") body.append(h("span", { class: "notetext", text: T.queued }));
        if (u.note) body.append(h("span", { class: "notetext", text: u.note }));
        tail = h(
          "div",
          { class: "tailbtns" },
          h("span", { class: "pct", text: `${Math.round(u.pct)}%` }),
          u.status === "up" && u.size > CFG.limits.single
            ? h("button", { type: "button", class: "dismiss", "aria-label": T.cancelUpload, title: T.cancelUpload, text: "×", onclick: () => cancelUpload(u) })
            : null,
        );
      }
      return h(
        "div",
        { class: `item${u.status === "err" ? " err" : u.status === "wait" ? " wait" : ""}` },
        thumbNode(u, "thumb", u.status === "done" && u.res ? () => openPreview(u.res!, u.local) : undefined),
        body,
        tail,
      );
    }),
  );
}

const RUNNER_SVG = `<svg viewBox="0 0 48 44" width="26" height="24" stroke="#4A5646" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"><circle cx="11" cy="18" r="5" fill="#FFFFFF"/><circle cx="37" cy="18" r="5" fill="#FFFFFF"/><path d="M5 42 C4 24 13 14 24 14 C35 14 44 24 43 42 Z" fill="#FFFFFF"/><ellipse cx="18" cy="28" rx="2" ry="2.6" fill="#3F4A3C" stroke="none"/><ellipse cx="31" cy="28" rx="2" ry="2.6" fill="#3F4A3C" stroke="none"/><ellipse cx="13" cy="34" rx="3.2" ry="1.9" fill="#F6C3BE" stroke="none"/><ellipse cx="36" cy="34" rx="3.2" ry="1.9" fill="#F6C3BE" stroke="none"/></svg>`;

// ---------------------------------------------------------------- deletion and albums (shared by pages)

async function deleteFiles(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  if (!confirm(ids.length > 1 ? fmt(T.confirmDeleteN, { n: ids.length }) : T.confirmDelete)) return 0;
  let n = 0;
  for (const id of ids) {
    const item = hist.find((x) => x.id === id);
    if (!item?.token && !item?.account) {
      toast(T.noToken);
      continue;
    }
    // Files in the account can be deleted with the login session instead of the token.
    const r = await xhr("DELETE", `/api/files/${encodeURIComponent(id)}`, null, item.token ? { "Sugi-Token": item.token } : {});
    // 404 means it is already gone (expired or deleted elsewhere): forget it locally too.
    if (r.status === 200 || r.status === 404 || r.status === 502) {
      hist = hist.filter((x) => x.id !== id);
      albums = albums.map((a) => ({ ...a, fileIds: a.fileIds.filter((f) => f !== id) }));
      uploads = uploads.filter((u) => u.res?.id !== id);
      n++;
    } else {
      toast(fmt(T.deleteFailed, { msg: r.body?.error || r.status }));
    }
  }
  persist();
  if (n) toast(n > 1 ? fmt(T.deletedN, { n }) : T.deleted);
  touch();
  return n;
}

async function createAlbum(ids: string[], title: string): Promise<AlbumItem | null> {
  if (!ids.length) return null;
  const r = await xhr("POST", "/api/albums", JSON.stringify({ files: ids, title }), { "Content-Type": "application/json" });
  if (r.status !== 201 || !r.body) {
    toast(fmt(T.albumFailed, { msg: r.status === 401 ? T.errGated : r.body?.error || r.status }));
    return null;
  }
  const a: AlbumItem = { id: r.body.id, url: r.body.url, title: r.body.title || "", token: r.body.delete_token, fileIds: ids, createdAt: Date.now() };
  albums = [a, ...albums];
  persist();
  void copy(a.url, T.albumMade);
  void navigate(`/a/${a.id}`);
  return a;
}

// ---------------------------------------------------------------- preview modal

function closePreview() {
  $("#preview")?.remove();
}

function openPreview(item: HistItem, local?: string | null) {
  closePreview();
  const ex = expInfo(item.expiresAt);
  const pv = h("div", { class: "pv" });
  const src = item.kind === "image" ? local || item.url : item.url;
  if (ex.expired) pv.textContent = item.ext;
  else if (item.kind === "video") pv.append(h("video", { src, controls: true, playsinline: true, preload: "metadata" }));
  else pv.append(h("img", { src, alt: item.name }));
  const meta = `${fmtSize(item.size)} · ${new Date(item.createdAt).toLocaleString(LOCALE, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${ex.label}`;
  const side = h(
    "div",
    { class: "side" },
    h(
      "div",
      { class: "hd" },
      h("div", {}, h("div", { class: "n", text: item.name }), h("div", { class: "m", text: meta })),
      h("button", { type: "button", class: "close", title: T.close, "aria-label": T.close, text: "×", onclick: closePreview }),
    ),
    ...FMTS.map((f) => {
      const text = fmtLink(item, f.id);
      return h(
        "div",
        { class: "fl" },
        h("span", { text: f.label }),
        h("div", { class: "fmt" }, h("code", { text }), h("button", { type: "button", text: T.copy, onclick: () => void copy(text) })),
      );
    }),
    h(
      "div",
      { class: "acts" },
      h("a", { class: "btn", href: ex.expired ? "/404" : item.url, target: "_blank", rel: "noopener", text: T.open }),
      h("button", {
        type: "button",
        class: "btn ghost",
        text: T.sharePage,
        onclick: () => {
          closePreview();
          void navigate(`/f/${item.id}`);
        },
      }),
      h("button", {
        type: "button",
        class: "btn warn",
        text: T.del,
        onclick: async () => {
          if (await deleteFiles([item.id])) {
            closePreview();
            renderMine();
          }
        },
      }),
    ),
  );
  const modal = h(
    "div",
    { class: "modal", id: "preview", role: "dialog", "aria-modal": "true", onclick: (e: MouseEvent) => e.target === modal && closePreview() },
    h("div", { class: "sheet" }, pv, side),
  );
  $("#overlays")!.append(modal);
}

// ---------------------------------------------------------------- the hamster

const now = new Date();
const CNY: Record<number, [number, number]> = { 2026: [2, 17], 2027: [2, 6], 2028: [1, 26], 2029: [2, 13], 2030: [2, 3] };
const month = now.getMonth() + 1;
const day = now.getDate();
const cny = CNY[now.getFullYear()];
const cnyDiff = cny ? (now.getTime() - new Date(now.getFullYear(), cny[0] - 1, cny[1]).getTime()) / 864e5 : 99;
const fest: "cny" | "halloween" | null = cnyDiff >= -2 && cnyDiff <= 7 ? "cny" : month === 10 && day >= 24 ? "halloween" : null;
const xmas = month === 12 && day >= 20 && day <= 26;
const scarfSeason = month >= 11 || month <= 2;
const POKES = T.pokes.split("|");

let dragging = false;
let pokeAt = 0;
let pokeLine = "";
let sleeping = false;
let wheeling = false;
let gold = false;
let lastActive = Date.now();

function isNight(): boolean {
  return document.documentElement.classList.contains("night");
}

function setOp(id: string, v: number) {
  document.getElementById(id)?.setAttribute("opacity", String(v));
}

function updateMascot() {
  const stage = $("#stage");
  if (!stage) return;
  const uploading = uploads.some((u) => u.status === "up" || u.status === "queued");
  const heavy = uploads.some((u) => u.status === "up" && u.size > 50e6);
  const doneN = uploads.filter((u) => u.status === "done").length;
  const poked = Date.now() - pokeAt < 1100;
  const asleep = sleeping && !dragging && !uploading;
  const wheel = wheeling && !asleep && !dragging && !uploading;
  const mood = asleep ? "sleep" : dragging ? "drag" : poked ? "poke" : uploading || heavy ? "busy" : doneN ? "happy" : "idle";
  const happy = mood === "drag" || mood === "happy" || mood === "poke";

  setOp("m-open", happy || asleep ? 0 : 1);
  setOp("m-happy", happy ? 1 : 0);
  setOp("m-sleep", asleep ? 1 : 0);
  setOp("m-sweat", mood === "busy" ? 1 : 0);
  for (const e of $$("#m-open .eye")) e.setAttribute("ry", mood === "busy" ? "5" : "6.5");
  const mouth = document.getElementById("m-mouth")!;
  mouth.setAttribute(
    "d",
    mood === "drag"
      ? "M94 94 Q100 106 106 94 Z"
      : mood === "busy"
        ? "M95 97 Q100 94.5 105 97"
        : asleep
          ? "M97 96 Q100 99 103 96"
          : "M93 95 Q96.5 99 100 95 Q103.5 99 107 95",
  );
  mouth.setAttribute("fill", mood === "drag" ? "#E88F8A" : "none");
  const puff = Math.max(0.001, heavy ? 1 : Math.min(1, doneN / 5 + (uploading ? 0.25 : 0) + (poked ? 0.45 : 0)));
  for (const p of $$("#stage .puff")) p.style.transform = `scale(${puff.toFixed(3)})`;
  for (const b of $$("#stage .blush")) b.style.transform = `scale(${poked ? 1.45 : 1})`;

  const mascot = $("#mascot")!;
  mascot.dataset.anim = heavy ? "heavy" : asleep ? "sleep" : uploading ? "busy" : "";
  mascot.classList.toggle("away", wheel);
  $("#m-paws")!.setAttribute("opacity", wheel ? "0" : "1");
  stage.classList.toggle("gold", gold);

  const hat = isNight() ? "night" : xmas ? "santa" : null;
  setOp("m-scarf", scarfSeason ? 1 : 0);
  setOp("m-hat", hat ? 1 : 0);
  setOp("m-sprout", hat ? 0 : 1);
  $("#m-hat-body")?.setAttribute("fill", hat === "night" ? "#BFD3EE" : "#E8746C");
  $("#m-hat-stripe")?.setAttribute("opacity", hat === "night" ? "0.8" : "0");
  for (const [id, on] of [
    ["m-cny", fest === "cny"],
    ["m-hal", fest === "halloween"],
  ] as const) {
    const g = document.getElementById(id);
    g?.setAttribute("opacity", on ? "1" : "0");
    g?.setAttribute("pointer-events", on ? "auto" : "none");
  }

  const bubble = asleep
    ? T.bubbleSleep
    : wheel
      ? T.bubbleWheel
      : heavy
        ? T.bubbleHeavy
        : poked
          ? pokeLine
          : dragging
            ? T.bubbleDrag
            : uploading
              ? T.bubbleBusy
              : doneN >= 5
                ? T.bubbleMany
                : doneN
                  ? T.bubbleDone
                  : fest === "cny"
                    ? T.bubbleCny
                    : fest === "halloween"
                      ? T.bubbleHalloween
                      : isNight()
                        ? T.bubbleNight
                        : T.bubbleIdle;
  $("#bubble")!.textContent = bubble;
  const dz = $("#dz-title");
  if (dz) dz.textContent = dragging ? T.dzDrag : uploading ? T.dzBusy : T.dzIdle;
  $("#dropzone")?.classList.toggle("over", dragging);

  renderAmbient(asleep, wheel);
}

// Persistent effects inside the stage: the hamster wheel while idle and the z's while asleep.
function renderAmbient(asleep: boolean, wheel: boolean) {
  const fx = $("#fx");
  if (!fx) return;
  const hasWheel = !!$(".wheel", fx);
  if (wheel && !hasWheel) {
    const w = h("div", { class: "wheel" });
    const spokes = [0, 30, 60, 90, 120, 150]
      .map((a) => {
        const r = (a * Math.PI) / 180;
        return `<line x1="${54 + 46 * Math.cos(r)}" y1="${54 + 46 * Math.sin(r)}" x2="${54 - 46 * Math.cos(r)}" y2="${54 - 46 * Math.sin(r)}"/>`;
      })
      .join("");
    const fur = gold ? "#F7D774" : "#FFFFFF";
    w.innerHTML = `<svg viewBox="0 0 116 122" width="116" height="122" stroke="#4A5646" stroke-width="3" stroke-linecap="round" fill="none"><path d="M58 58 L34 120 M58 58 L82 120"/><circle cx="58" cy="58" r="54" fill="rgba(255,255,255,.75)"/></svg><div class="spin"><svg viewBox="0 0 108 108" width="108" height="108" stroke="#CF9A62" stroke-width="2.5" fill="none" stroke-linecap="round"><circle cx="54" cy="54" r="46"/>${spokes}<circle cx="54" cy="54" r="5" fill="#F5D3A6" stroke="#4A5646"/></svg></div><div class="runner"><svg viewBox="0 0 48 44" width="44" height="40" stroke="#4A5646" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"><circle cx="11" cy="18" r="5" fill="${fur}"/><circle cx="37" cy="18" r="5" fill="${fur}"/><path d="M5 42 C4 24 13 14 24 14 C35 14 44 24 43 42 Z" fill="${fur}"/><path d="M14 28 Q17.5 24 21 28 M27 28 Q30.5 24 34 28" fill="none"/><ellipse cx="12.5" cy="33" rx="3.4" ry="2" fill="#F6C3BE" stroke="none"/><ellipse cx="35.5" cy="33" rx="3.4" ry="2" fill="#F6C3BE" stroke="none"/></svg></div>`;
    fx.append(w);
  } else if (!wheel && hasWheel) $(".wheel", fx)!.remove();
  const hasZ = !!$(".z", fx);
  if (asleep && !hasZ) {
    ["z", "z", "Z"].forEach((z, i) => {
      const s = h("span", { class: "z", text: z });
      s.style.left = `${150 + i * 6}px`;
      s.style.top = `${40 - i * 4}px`;
      s.style.fontSize = `${14 + i * 5}px`;
      s.style.animationDelay = `${i * 0.8}s`;
      fx.append(s);
    });
  } else if (!asleep && hasZ)
    $$(".z", fx).forEach((z) => {
      z.remove();
    });
}

function spawn(nodes: HTMLElement[], life: number) {
  const fx = $("#fx");
  if (!fx) return;
  fx.append(...nodes);
  setTimeout(() => {
    for (const n of nodes) n.remove();
  }, life);
}

function burst() {
  const nodes: HTMLElement[] = [];
  for (let i = 0; i < 18; i++) {
    const d = 70 + Math.random() * 90;
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
    const el = h("div", { class: `bit ${i % 2 ? "leaf" : "seed"}` });
    el.style.setProperty("--dx", `${Math.cos(ang) * d}px`);
    el.style.setProperty("--dy", `${Math.sin(ang) * d + 40}px`);
    el.style.setProperty("--r", `${Math.random() * 540 - 270}deg`);
    el.style.animationDelay = `${Math.random() * 120}ms`;
    nodes.push(el);
  }
  spawn(nodes, 1500);
}

function spawnFly(n: number) {
  spawn(
    Array.from({ length: n }, (_, i) => {
      const el = h("div", { class: "fly" }, h("i"));
      el.style.animationDelay = `${i * 130}ms`;
      return el;
    }),
    1700,
  );
}

function poke(e: Event) {
  e.stopPropagation();
  pokeLine = POKES[Math.floor(Math.random() * POKES.length)];
  pokeAt = Date.now();
  sleeping = false;
  wheeling = false;
  lastActive = Date.now();
  setTimeout(touch, 1150);
  spawn(
    Array.from({ length: 5 }, () => {
      const el = h("span", { class: "heart", text: "♥" });
      el.style.left = `${70 + Math.random() * 60}px`;
      el.style.fontSize = `${14 + Math.random() * 12}px`;
      el.style.setProperty("--dx", `${(Math.random() - 0.5) * 70}px`);
      return el;
    }),
    1400,
  );
  if (prefs.sound) chirp();
  touch();
}

let mx: number | null = null;
let my: number | null = null;
let eyeRaf = 0;
function onActivity(e?: Event) {
  lastActive = Date.now();
  if (sleeping || wheeling) {
    sleeping = false;
    wheeling = false;
    touch();
  }
  if (e && "clientX" in e) {
    mx = (e as MouseEvent).clientX;
    my = (e as MouseEvent).clientY;
  }
  if (eyeRaf) return;
  eyeRaf = requestAnimationFrame(() => {
    eyeRaf = 0;
    const g = document.getElementById("m-eyes") as unknown as SVGGElement | null;
    if (!g || mx === null || my === null) return;
    const svg = g.ownerSVGElement;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const cx = r.left + r.width * 0.5;
    const cy = r.top + r.height * (84 / 132);
    const k = (v: number) => Math.max(-1, Math.min(1, v));
    g.style.transform = `translate(${(k((mx - cx) / 160) * 3.2).toFixed(2)}px, ${(k((my - cy) / 160) * 2.6).toFixed(2)}px)`;
  });
}

// ---------------------------------------------------------------- tab title and favicon

let tabSig = "";
function favicon(mood: string, pct: number | null): string {
  const fur = gold ? "#F7D774" : "#FFFFFF";
  const eyes =
    mood === "happy"
      ? "<path d='M14 28 Q17.5 24 21 28 M27 28 Q30.5 24 34 28' fill='none' stroke-width='2.4'/>"
      : mood === "sleep"
        ? "<path d='M14 27 Q17.5 30 21 27 M27 27 Q30.5 30 34 27' fill='none' stroke-width='2.4'/>"
        : "<ellipse cx='17.5' cy='28' rx='2.4' ry='3' fill='#3F4A3C' stroke='none'/><ellipse cx='30.5' cy='28' rx='2.4' ry='3' fill='#3F4A3C' stroke='none'/>";
  const ring =
    pct !== null
      ? `<circle cx='24' cy='24' r='22' fill='none' stroke='#E1E8D5' stroke-width='3.5'/><circle cx='24' cy='24' r='22' fill='none' stroke='#5E9E6E' stroke-width='3.5' stroke-dasharray='${((pct / 100) * 138.2).toFixed(1)} 200' transform='rotate(-90 24 24)'/>`
      : "";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48' stroke='#4A5646' stroke-width='2.4' stroke-linejoin='round'>${ring}<g transform='translate(0 3)'><circle cx='11' cy='16' r='5.5' fill='${fur}'/><circle cx='37' cy='16' r='5.5' fill='${fur}'/><path d='M6 40 C5 23 13 13 24 13 C35 13 43 23 42 40 Z' fill='${fur}'/>${eyes}<ellipse cx='12.5' cy='33' rx='3.4' ry='2' fill='#F6C3BE' stroke='none'/><ellipse cx='35.5' cy='33' rx='3.4' ry='2' fill='#F6C3BE' stroke='none'/></g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let pageTitle = document.title;
function updateTab() {
  const up = uploads.filter((u) => u.status === "up" || u.status === "queued");
  const done = uploads.filter((u) => u.status === "done").length;
  let title = pageTitle;
  let mood = "idle";
  let pct: number | null = null;
  if (up.length) {
    pct = Math.round(up.reduce((a, u) => a + u.pct, 0) / up.length);
    title = fmt(T.titleBusy, { pct });
  } else if (sleeping) {
    mood = "sleep";
    title = T.titleSleep;
  } else if (done && CFG.page === "home") {
    mood = "happy";
    title = fmt(T.titleDone, { n: done });
  }
  const sig = title + mood + gold + (pct !== null ? Math.round(pct / 5) : "");
  if (sig === tabSig) return;
  tabSig = sig;
  document.title = title;
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = h("link", { rel: "icon" });
    document.head.append(link);
  }
  link.type = "image/svg+xml";
  link.href = favicon(mood, pct);
}

// ---------------------------------------------------------------- page: home

function initHome() {
  showPending();
  const input = $<HTMLInputElement>("#file")!;
  const dz = $("#dropzone")!;
  dz.addEventListener("click", () => input.click());
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener("change", () => {
    addFiles(input.files);
    input.value = "";
  });
  if (/Mac|iPhone|iPad/.test(navigator.platform)) $("#paste-key")!.textContent = "⌘ + V";

  const seg = $("#expiry")!;
  const paintExpiry = () => {
    for (const b of $$<HTMLButtonElement>("button", seg)) {
      const on = b.dataset.exp === prefs.expiry;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
  };
  seg.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-exp]");
    if (!b) return;
    prefs.expiry = b.dataset.exp as ExpiryId;
    savePrefs();
    paintExpiry();
  });
  paintExpiry();

  const bind = (id: string, key: "autoCopy" | "stripExif" | "cuteNames" | "sound") => {
    const cb = $<HTMLInputElement>(id)!;
    cb.checked = prefs[key];
    cb.addEventListener("change", () => {
      prefs[key] = cb.checked;
      savePrefs();
      if (key === "sound" && cb.checked) chirp();
    });
  };
  bind("#opt-copy", "autoCopy");
  bind("#opt-exif", "stripExif");
  bind("#opt-cute", "cuteNames");
  bind("#opt-sound", "sound");

  $<HTMLFormElement>("#urlform")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const v = (f.elements.namedItem("url") as HTMLInputElement).value;
    (f.elements.namedItem("url") as HTMLInputElement).value = "";
    addUrl(v);
  });

  $("#copy-all")!.addEventListener("click", () => {
    const done = uploads.filter((u) => u.res).map((u) => fmtLink(u.res!));
    if (done.length) void copy(done.join("\n"), fmt(T.copiedN, { n: done.length }));
  });
  $("#clear-done")!.addEventListener("click", () => {
    uploads = uploads.filter((u) => u.status === "up" || u.status === "queued");
    touch();
  });
  $("#album-session")!.addEventListener("click", () => {
    void createAlbum(
      uploads.filter((u) => u.res).map((u) => u.res!.id),
      "",
    );
  });

  const mascot = $("#mascot")!;
  mascot.addEventListener("click", poke);
  $("#m-cny")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toast(T.redPacket);
    burst();
  });
  $("#m-hal")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toast(T.pumpkin);
    burst();
  });
  renderFmtSegs();
  touch();
}

// ---------------------------------------------------------------- page: my files

const mineState = { tab: "files" as "files" | "albums", q: "", filter: "all", selected: new Set<string>() };

function visibleHist(): HistItem[] {
  const q = mineState.q.trim().toLowerCase();
  const n = Date.now();
  return hist.filter((x) => {
    if (q && !x.name.toLowerCase().includes(q)) return false;
    const gone = x.expiresAt !== null && x.expiresAt <= n;
    if (mineState.filter === "perm") return !x.expiresAt;
    if (mineState.filter === "tmp") return !!x.expiresAt && !gone;
    if (mineState.filter === "gone") return gone;
    return true;
  });
}

function tilePic(x: HistItem, onClick: () => void): HTMLElement {
  const pic = h("button", { type: "button", class: "pic", onclick: onClick, "aria-label": x.name });
  const ex = expInfo(x.expiresAt);
  if (x.thumb) pic.append(h("img", { src: x.thumb, alt: "", loading: "lazy" }));
  else if (!ex.expired && x.kind === "image") pic.append(h("img", { src: x.url, alt: "", loading: "lazy" }));
  else pic.append(h("span", { text: x.ext }));
  return pic;
}

function renderMine() {
  if (CFG.page !== "mine") return;
  $("#file-count")!.textContent = String(hist.length);
  $("#album-count")!.textContent = String(albums.length);
  for (const b of $$<HTMLButtonElement>("#mine-tabs button")) b.classList.toggle("on", b.dataset.tab === mineState.tab);
  $("#export-history")!.hidden = hist.length === 0 && albums.length === 0;
  $("#mine-files")!.hidden = mineState.tab !== "files";
  $("#mine-albums")!.hidden = mineState.tab !== "albums";

  for (const id of [...mineState.selected]) if (!hist.some((x) => x.id === id)) mineState.selected.delete(id);
  const sel = mineState.selected;
  $("#selbar")!.hidden = sel.size === 0;
  $("#sel-count")!.textContent = fmt(T.selected, { n: sel.size });
  $("#mine-tools")!.hidden = hist.length === 0;
  $("#mine-empty")!.hidden = hist.length > 0;
  const vis = visibleHist();
  $("#mine-nomatch")!.hidden = !(hist.length > 0 && vis.length === 0);
  for (const b of $$<HTMLButtonElement>("#mine-filter button")) b.classList.toggle("on", b.dataset.filter === mineState.filter);
  renderFmtSegs();

  const n = Date.now();
  $("#mine-grid")!.replaceChildren(
    ...vis.map((x) => {
      const ex = expInfo(x.expiresAt, n);
      const isSel = sel.has(x.id);
      const pic = tilePic(x, () => openPreview(x));
      const tick = h("span", {
        class: "tick",
        role: "checkbox",
        "aria-checked": String(isSel),
        tabindex: "0",
        text: isSel ? "✓" : "",
        onclick: (e: Event) => {
          e.stopPropagation();
          if (sel.has(x.id)) sel.delete(x.id);
          else sel.add(x.id);
          renderMine();
        },
      });
      pic.append(tick, h("span", { class: `exp ${ex.cls}`, text: ex.label }));
      return h(
        "div",
        { class: `tile${isSel ? " sel" : ""}${ex.expired ? " gone" : ""}` },
        pic,
        h(
          "div",
          { class: "meta" },
          h("span", { class: "n", text: x.name }),
          h("span", { class: "s" }, h("span", { text: fmtSize(x.size) }), h("span", { class: "local", text: x.account ? T.inAccount : T.localOnly })),
        ),
        h(
          "div",
          { class: "acts" },
          h("button", { type: "button", class: "c", text: T.copyLink, onclick: () => void copy(fmtLink(x)) }),
          h("button", {
            type: "button",
            class: "x",
            title: T.del,
            "aria-label": T.del,
            text: "×",
            onclick: async () => {
              if (await deleteFiles([x.id])) renderMine();
            },
          }),
        ),
      );
    }),
  );

  $("#albums-empty")!.hidden = albums.length > 0;
  const byId = new Map(hist.map((x) => [x.id, x]));
  $("#albums-grid")!.replaceChildren(
    ...albums.map((a) => {
      const its = a.fileIds.map((i) => byId.get(i)).filter(Boolean) as HistItem[];
      const covers = h("div", { class: "covers", onclick: () => void navigate(`/a/${a.id}`) });
      for (let i = 0; i < 3; i++) {
        const c = h("div");
        const x = its[i];
        const src = x ? x.thumb || (x.kind === "image" && !expInfo(x.expiresAt).expired ? x.url : null) : a.covers?.[i];
        if (src) c.append(h("img", { src, alt: "", loading: "lazy" }));
        covers.append(c);
      }
      return h(
        "div",
        { class: "card albumcard" },
        covers,
        h(
          "a",
          { class: "info", href: `/a/${a.id}`, "data-nav": true },
          h("span", { class: "t", text: a.title || T.untitled }),
          h("span", { class: "m", text: fmt(T.albumMeta, { n: a.count ?? a.fileIds.length, date: new Date(a.createdAt).toLocaleDateString(LOCALE) }) }),
        ),
        h(
          "div",
          { class: "acts" },
          h("button", { type: "button", class: "c", text: T.copyLink, onclick: () => void copy(a.url, T.linkCopied) }),
          h("button", { type: "button", class: "x", title: T.del, "aria-label": T.del, text: "×", onclick: () => void deleteAlbum(a) }),
        ),
      );
    }),
  );
}

async function deleteAlbum(a: AlbumItem): Promise<boolean> {
  if (!confirm(T.confirmDelete)) return false;
  const r = await xhr("DELETE", `/api/albums/${encodeURIComponent(a.id)}`, null, a.token ? { "Sugi-Token": a.token } : {});
  if (r.status === 200 || r.status === 404) {
    albums = albums.filter((x) => x.id !== a.id);
    persist();
    toast(T.albumDeleted);
    renderMine();
    return true;
  }
  toast(fmt(T.deleteFailed, { msg: r.body?.error || r.status }));
  return false;
}

function initMine() {
  $("#mine-tabs")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-tab]");
    if (!b) return;
    mineState.tab = b.dataset.tab as "files" | "albums";
    mineState.selected.clear();
    renderMine();
  });
  $("#mine-filter")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-filter]");
    if (!b) return;
    mineState.filter = b.dataset.filter!;
    renderMine();
  });
  const q = $<HTMLInputElement>("#mine-q")!;
  q.value = mineState.q;
  q.addEventListener("input", () => {
    mineState.q = q.value;
    renderMine();
  });
  $("#sel-clear")!.addEventListener("click", () => {
    mineState.selected.clear();
    renderMine();
  });
  $("#sel-delete")!.addEventListener("click", async () => {
    if (await deleteFiles([...mineState.selected])) {
      mineState.selected.clear();
      renderMine();
    }
  });
  $("#sel-album")!.addEventListener("click", () => {
    const ids = hist.filter((x) => mineState.selected.has(x.id)).map((x) => x.id);
    const title = $<HTMLInputElement>("#album-title")!.value;
    void createAlbum(ids, title).then((a) => a && mineState.selected.clear());
  });
  $("#export-history")!.addEventListener("click", () => {
    const blob = new Blob(
      [JSON.stringify({ version: 1, exported_at: new Date().toISOString(), files: hist.map((x) => ({ ...x, thumb: undefined })), albums }, null, 2)],
      { type: "application/json" },
    );
    const a = h("a", { href: URL.createObjectURL(blob), download: "sugi-history.json" });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(T.exported);
  });
  const importInput = $<HTMLInputElement>("#import-file")!;
  $("#import-history")!.addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", async () => {
    const f = importInput.files?.[0];
    importInput.value = "";
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const files: HistItem[] = Array.isArray(data.files) ? data.files.filter((x: HistItem) => x && typeof x.id === "string" && typeof x.url === "string") : [];
      const al: AlbumItem[] = Array.isArray(data.albums) ? data.albums.filter((x: AlbumItem) => x && typeof x.id === "string") : [];
      const known = new Set(hist.map((x) => x.id));
      hist = [...hist, ...files.filter((x) => !known.has(x.id))].sort((a, b) => b.createdAt - a.createdAt);
      const knownA = new Set(albums.map((x) => x.id));
      albums = [...albums, ...al.filter((x) => !knownA.has(x.id))];
      persist();
      renderMine();
      toast(T.historyImported);
    } catch {
      toast(T.importFailed);
    }
  });
  renderMine();
  if (CFG.user && CFG.flags.account?.includes("sync")) void syncAccount();
}

interface AccountFile {
  id: string;
  url: string;
  page: string;
  name: string | null;
  size: number;
  type: string;
  created_at: string;
  expires_at: string | null;
}

// My-files sync: merge the account's files and albums into the lists, and offer to add this browser's uploads to the account.
async function syncAccount() {
  const [f, a] = await Promise.all([xhr("GET", "/api/me/files", null, {}), xhr("GET", "/api/me/albums", null, {})]);
  if (f.status !== 200 || a.status !== 200) {
    toast(T.syncFailed);
    return;
  }
  const mine = new Map((f.body.files as AccountFile[]).map((x) => [x.id, x]));
  hist = hist.map((x) => (mine.has(x.id) ? { ...x, account: true } : x));
  const known = new Set(hist.map((x) => x.id));
  for (const x of mine.values()) {
    if (known.has(x.id)) continue;
    const ext = x.url.slice(x.url.lastIndexOf(".") + 1);
    hist.push({
      id: x.id,
      url: x.url,
      page: x.page,
      name: x.name || `${x.id}.${ext}`,
      size: x.size,
      ext,
      kind: x.type.startsWith("video/") ? "video" : "image",
      token: "",
      expiresAt: x.expires_at ? Date.parse(x.expires_at) : null,
      createdAt: Date.parse(x.created_at),
      account: true,
    });
  }
  hist.sort((p, q) => q.createdAt - p.createdAt);
  const myAlbums = a.body.albums as { id: string; url: string; title: string; created_at: string; files: number; covers: string[] }[];
  const inAccount = new Set(myAlbums.map((x) => x.id));
  albums = albums.map((x) => (inAccount.has(x.id) ? { ...x, account: true } : x));
  const knownA = new Set(albums.map((x) => x.id));
  for (const x of myAlbums)
    if (!knownA.has(x.id))
      albums.push({
        id: x.id,
        url: x.url,
        title: x.title,
        token: "",
        fileIds: [],
        createdAt: Date.parse(x.created_at),
        account: true,
        covers: x.covers,
        count: x.files,
      });
  renderMine();
  const loose = hist.filter((x) => x.token && !x.account);
  const looseAlbums = albums.filter((x) => x.token && !x.account);
  const bar = $("#claim-bar");
  if (!bar || (!loose.length && !looseAlbums.length)) return;
  $("#claim-text")!.textContent = fmt(T.claimN, { n: loose.length + looseAlbums.length });
  bar.hidden = false;
  $("#claim-btn")!.onclick = async () => {
    const r = await xhr(
      "POST",
      "/api/me/claim",
      JSON.stringify({ files: loose.map((x) => ({ id: x.id, token: x.token })), albums: looseAlbums.map((x) => ({ id: x.id, token: x.token })) }),
      { "Content-Type": "application/json" },
    );
    if (r.status !== 200) {
      toast(fmt(T.claimFailed, { msg: r.body?.error || r.status }));
      return;
    }
    bar.hidden = true;
    toast(fmt(T.claimed, { n: r.body.files.length + r.body.albums.length }));
    void syncAccount();
  };
}

// ---------------------------------------------------------------- pages: file, album, dev

function localizeTimes(root: ParentNode = document) {
  for (const t of $$<HTMLTimeElement>("time[datetime]", root)) {
    const d = new Date(t.dateTime);
    if (Number.isNaN(d.getTime())) continue;
    t.textContent = t.hasAttribute("data-date-only")
      ? d.toLocaleDateString(LOCALE)
      : d.toLocaleString(LOCALE, { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  for (const b of $$("[data-expires]", root)) b.textContent = expInfo(Number(b.dataset.expires)).label;
}

function initFile() {
  const id = $("[data-file-id]")?.dataset.fileId;
  const item = id ? hist.find((x) => x.id === id) : null;
  const btn = $("#file-delete");
  if (btn && item?.token) {
    btn.hidden = false;
    btn.addEventListener("click", async () => {
      if (await deleteFiles([item.id])) void navigate("/mine");
    });
  }
}

function initAlbum() {
  const id = $("[data-album-id]")?.dataset.albumId;
  const a = id ? albums.find((x) => x.id === id) : null;
  const btn = $("#album-delete");
  if (btn && a?.token) {
    btn.hidden = false;
    btn.addEventListener("click", async () => {
      if (await deleteAlbum(a)) void navigate("/mine");
    });
  }
}

// Tab strips: <div data-tabs="group"> with <button data-tab="x">, panels marked data-panel="group:x". A matching URL hash (e.g. /dev#cli) selects a tab on load.
function selectTab(seg: HTMLElement, tab: string) {
  const group = seg.dataset.tabs!;
  for (const b of $$<HTMLButtonElement>("button[data-tab]", seg)) {
    const on = b.dataset.tab === tab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  }
  for (const p of $$(`[data-panel^="${group}:"]`)) p.hidden = p.dataset.panel !== `${group}:${tab}`;
}

function initTabs() {
  for (const seg of $$("[data-tabs]")) {
    seg.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-tab]");
      if (b) selectTab(seg, b.dataset.tab!);
    });
    const want = location.hash.slice(1);
    if (want && $(`button[data-tab="${CSS.escape(want)}"]`, seg)) selectTab(seg, want);
  }
}

// In-page links to a tab (e.g. href="#cli" on the developer page) switch to it.
window.addEventListener("hashchange", () => {
  const want = location.hash.slice(1);
  for (const seg of $$("[data-tabs]")) if (want && $(`button[data-tab="${CSS.escape(want)}"]`, seg)) selectTab(seg, want);
});

function initPage() {
  CFG.page = $("#main")?.dataset.page || CFG.page;
  pageTitle = document.title;
  tabSig = "";
  localizeTimes();
  if (CFG.page === "home") initHome();
  if (CFG.page === "mine") initMine();
  if (CFG.page === "file") initFile();
  if (CFG.page === "album") initAlbum();
  initTabs();
  updateTab();
}

// ---------------------------------------------------------------- header fit

// One row (logo, links, tools) while it fits; otherwise the compact header with the links in a scrolling row of their own. Measured, not guessed from the window width, because the set of links changes (logged in or not, donate on or off) and so do their widths (language, fonts).
function fitHeader() {
  const top = $(".top");
  const nav = $("#nav");
  if (!top || !nav) return;
  if (window.innerWidth <= 900) {
    top.classList.add("compact");
    return;
  }
  top.classList.remove("compact");
  const parts = [$(".brand", top), nav, $(".tools", top)].filter(Boolean) as HTMLElement[];
  const tops = parts.map((e) => e.getBoundingClientRect().top);
  const overflow = nav.scrollWidth > nav.clientWidth + 1 || top.scrollWidth > top.clientWidth + 1 || Math.max(...tops) - Math.min(...tops) > 4;
  top.classList.toggle("compact", overflow);
}
let fitFrame = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(fitHeader);
});
fitHeader();
void document.fonts?.ready.then(fitHeader);

// ---------------------------------------------------------------- navigation

function markNav(page: string) {
  for (const a of $$<HTMLAnchorElement>("#nav a[data-for]")) a.classList.toggle("on", a.dataset.for!.split(" ").includes(page));
}

async function navigate(path: string, push = true): Promise<void> {
  const url = new URL(path, location.href);
  if (url.origin !== location.origin) {
    location.href = url.toString();
    return;
  }
  let data: { page: string; title: string; html: string };
  try {
    const res = await fetch(url.pathname + url.search, { headers: { "X-Sugi-Partial": "1" }, credentials: "same-origin" });
    if (!res.headers.get("content-type")?.includes("application/json")) throw new Error("not partial");
    data = await res.json();
  } catch {
    location.href = url.toString();
    return;
  }
  closePreview();
  const main = $("#main")!;
  main.innerHTML = data.html;
  main.dataset.page = data.page;
  document.title = data.title;
  markNav(data.page);
  if (push) history.pushState({}, "", url.pathname + url.search + url.hash);
  window.scrollTo(0, 0);
  initPage();
}

document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-nav]");
  if (a && !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !a.target) {
    e.preventDefault();
    void navigate(a.href);
    return;
  }
  const c = (e.target as HTMLElement).closest<HTMLElement>("[data-copy]");
  if (c) {
    const kind = c.dataset.toast;
    void copy(c.dataset.copy!, kind === "page" ? T.pageCopied : kind === "link" ? T.linkCopied : T.copied);
    return;
  }
  const code = (e.target as HTMLElement).closest<HTMLElement>("[data-copy-code]");
  if (code) {
    const box = code.closest("[data-code]");
    if (!box) return;
    const lines = $$("[data-l]", box);
    const cmds = lines.filter((l) => l.hasAttribute("data-c"));
    const text = (cmds.length ? cmds : lines)
      .map((l) => " ".repeat(Number(l.getAttribute("data-i") || 0)) + ($("[data-t]", l)?.textContent ?? l.textContent))
      .join("\n");
    void copy(text);
  }
});
window.addEventListener("popstate", () => void navigate(location.pathname + location.search, false));

// The report form on file and album pages (form[data-report]); without this script it posts as a plain form and the server redirects back.
document.addEventListener("submit", async (e) => {
  const form = (e.target as HTMLElement).closest<HTMLFormElement>("form[data-report]");
  if (!form) return;
  e.preventDefault();
  const button = $<HTMLButtonElement>("button[type=submit]", form);
  if (button?.disabled) return;
  if (button) button.disabled = true;
  const data = new FormData(form);
  let status = 0;
  try {
    const res = await fetch(form.action, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ target: data.get("target"), reason: data.get("reason"), details: data.get("details"), contact: data.get("contact") }),
      credentials: "same-origin",
    });
    status = res.status;
  } catch {}
  if (button) button.disabled = false;
  if (status === 202) {
    const note = h("p", { class: "gate", role: "status", text: form.dataset.done! });
    form.replaceWith(note);
    toast(form.dataset.done!);
  } else toast(status === 429 ? form.dataset.rate! : form.dataset.fail!);
});

// ---------------------------------------------------------------- global listeners

$("#theme")?.addEventListener("click", () => {
  const night = !isNight();
  document.documentElement.classList.toggle("night", night);
  prefs.night = night;
  savePrefs();
  touch();
});

document.addEventListener("paste", (e) => {
  const tag = (e.target as HTMLElement)?.tagName || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  const files = Array.from(e.clipboardData?.files || []);
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

let dragDepth = 0;
function showDragOverlay(on: boolean) {
  dragging = on;
  let el = $("#dragover");
  if (on && !el) {
    const exp = { perm: T.expPerm, "1h": T.exp1h, "12h": T.exp12h, "72h": T.exp72h }[prefs.expiry];
    el = h(
      "div",
      { class: "dragover", id: "dragover" },
      h("div", { class: "k", text: "(ﾉ>ω<)ﾉ" }),
      h("div", { class: "t", text: T.dropTitle }),
      h("div", { class: "s", text: fmt(T.dropKeep, { label: exp }) }),
    );
    $("#overlays")!.append(el);
  } else if (!on && el) el.remove();
  touch();
}
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  if (!dragging) showDragOverlay(true);
});
window.addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) showDragOverlay(false);
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  showDragOverlay(false);
  addFiles(e.dataTransfer?.files);
});

for (const ev of ["mousemove", "keydown", "touchstart", "scroll"]) window.addEventListener(ev, onActivity, { passive: true });
setInterval(() => {
  const busy = dragging || uploads.some((u) => u.status === "up" || u.status === "queued");
  if (busy) return;
  const idle = Date.now() - lastActive;
  if (!sleeping && idle > 60000) {
    sleeping = true;
    wheeling = false;
    touch();
  } else if (!sleeping && !wheeling && idle > 15000) {
    wheeling = true;
    touch();
  }
}, 3000);
setInterval(() => {
  if (CFG.page === "mine") renderMine();
  else localizeTimes();
}, 30000);

const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
let kseq: string[] = [];
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePreview();
  const k = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
  kseq = [...kseq, k].slice(-KONAMI.length);
  if (kseq.join() === KONAMI.join()) {
    kseq = [];
    gold = !gold;
    toast(gold ? T.gold : T.ungold);
    if (gold) {
      burst();
      if (prefs.sound) chirp();
    }
    tabSig = "";
    touch();
  }
});

initPage();

if (CFG.flags.accounts) initAccount(toast);
