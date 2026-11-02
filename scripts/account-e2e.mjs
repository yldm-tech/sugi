// End-to-end check of email login, my-files sync and API tokens against a deployment: one login email to the E2E_INBOX test address (read back through the admin-only inbox), then uploads, claiming, listing and deleting by session. Synthetic files only; everything created is deleted. Secrets come from ~/.config/sugi/secrets.env and ops.env (or SUGI_SECRETS_FILE / SUGI_OPS_FILE) and are never printed.
//
//   node scripts/account-e2e.mjs [BASE_URL]      (default https://sugi.moe)
//
// Login emails count against the mail provider's daily quota, so run this sparingly.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

const base = (process.argv[2] ?? "https://sugi.moe").replace(/\/$/, "");
const env = (f) =>
  Object.fromEntries(
    readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
const { ADMIN_TOKEN } = env(process.env.SUGI_SECRETS_FILE ?? `${homedir()}/.config/sugi/secrets.env`);
const { E2E_INBOX } = env(process.env.SUGI_OPS_FILE ?? `${homedir()}/.config/sugi/ops.env`);
const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 8 }, () => Buffer.concat([Buffer.from([0]), randomBytes(24)])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Log in through the emailed link.
const before = await fetch(`${base}/admin/e2e-inbox`, { headers: admin });
const beforeId = before.ok ? (await before.json()).id : 0;
const form = new FormData();
form.append("email", E2E_INBOX);
form.append("lang", "en");
const sent = await fetch(`${base}/auth/email`, { method: "POST", body: form, headers: { origin: base }, redirect: "manual" });
check("login email sent", sent.headers.get("location") === `${base}/login?sent=1`, `${sent.status}`);
let link = null;
for (let i = 0; i < 30 && !link; i++) {
  await sleep(4000);
  const r = await fetch(`${base}/admin/e2e-inbox`, { headers: admin });
  if (r.ok) {
    const m = await r.json();
    if (m.id !== beforeId) link = m.links.find((u) => u.startsWith(`${base}/auth/email/verify?token=`));
  }
}
check("login link arrived", Boolean(link));
if (!link) process.exit(1);
const vf = new FormData();
vf.append("token", new URL(link).searchParams.get("token"));
const done = await fetch(`${base}/auth/email/verify`, { method: "POST", body: vf, headers: { origin: base }, redirect: "manual" });
const cookie = /sugi_session=[^;]+/.exec(done.headers.get("set-cookie") ?? "")?.[0];
check("logged in", Boolean(cookie));
const auth = { cookie, origin: base };

// Sync: an upload made while logged in, one made anonymously and claimed, and an album.
const put = (headers) => fetch(`${base}/api/upload`, { method: "PUT", body: png(), headers: { accept: "application/json", ...headers } }).then((r) => r.json());
const mine = await put(auth);
const earlier = await put({});
const album = await (
  await fetch(`${base}/api/albums`, {
    method: "POST",
    body: JSON.stringify({ files: [mine.id], title: "account e2e" }),
    headers: { ...auth, "content-type": "application/json", accept: "application/json" },
  })
).json();
const list = async () => (await (await fetch(`${base}/api/me/files`, { headers: { cookie } })).json()).files.map((f) => f.id);
check("upload while logged in is in the account", (await list()).includes(mine.id));
check("anonymous upload is not", !(await list()).includes(earlier.id));
const claimed = await (
  await fetch(`${base}/api/me/claim`, {
    method: "POST",
    body: JSON.stringify({ files: [{ id: earlier.id, token: earlier.delete_token }] }),
    headers: { ...auth, "content-type": "application/json" },
  })
).json();
check("claim by delete token", claimed.files?.[0] === earlier.id && (await list()).includes(earlier.id));
const albums = (await (await fetch(`${base}/api/me/albums`, { headers: { cookie } })).json()).albums;
check(
  "album is in the account",
  albums.some((a) => a.id === album.id),
);
const mineHtml = await (await fetch(`${base}/mine?lang=en`, { headers: { cookie } })).text();
check("My files says it shows the account", mineHtml.includes("files in your account"));

// Delete everything by session, without the tokens.
const delAlbum = await fetch(`${base}/api/albums/${album.id}`, { method: "DELETE", headers: auth });
const del1 = await fetch(`${base}/api/files/${mine.id}`, { method: "DELETE", headers: auth });
const del2 = await fetch(`${base}/api/files/${earlier.id}`, { method: "DELETE", headers: auth });
check("delete by session", delAlbum.status === 200 && del1.status === 200 && del2.status === 200, `${delAlbum.status} ${del1.status} ${del2.status}`);
check("account is empty again", (await list()).length === 0);
// API tokens: create one from the session, use it as Bearer, revoke it.
const created = await fetch(`${base}/api/me/tokens`, { method: "POST", headers: auth });
const tok = created.ok ? await created.json() : null;
check("create an API token", created.status === 201 && /^sugi_/.test(tok?.token ?? ""), `${created.status}`);
if (tok) {
  const bearer = { authorization: `Bearer ${tok.token}` };
  const me = await (await fetch(`${base}/api/me`, { headers: bearer })).json();
  check("the token identifies the account", me.email === E2E_INBOX.toLowerCase());
  const viaToken = await put(bearer);
  check("an upload with the token is in the account", (await list()).includes(viaToken.id));
  const delToken = await fetch(`${base}/api/files/${viaToken.id}`, { method: "DELETE", headers: { "sugi-token": viaToken.delete_token } });
  const revoked = await fetch(`${base}/api/me/tokens/${tok.id}`, { method: "DELETE", headers: auth });
  check("revoke the token", revoked.status === 200 && delToken.status === 200 && (await fetch(`${base}/api/me`, { headers: bearer })).status === 401);
}
const out = await fetch(`${base}/auth/logout`, { method: "POST", headers: { ...auth, accept: "text/html" }, redirect: "manual" });
check("logged out", out.status === 303);
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
