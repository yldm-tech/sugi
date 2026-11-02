// The end-to-end test inbox: Email Routing sends exactly one hard-to-guess address (E2E_INBOX) to this Worker. Mail to that address is kept briefly in D1 so tests can read a login link; anything else that reaches the Worker is rejected. Only admins can read it.
import { HttpError, jsonResponse, requireBearer } from "./http";

export const INBOX_TTL_MS = 3600 * 1000;
export const INBOX_MAX_ROWS = 50;
const MAX_BYTES = 256 * 1024;

/** Undoes quoted-printable soft line breaks and escapes, enough to find URLs in a plain or HTML part. */
export function decodeQuotedPrintable(s: string): string {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

async function readCapped(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(Math.min(total, MAX_BYTES));
  let off = 0;
  for (const c of chunks) {
    out.set(c.subarray(0, Math.min(c.byteLength, out.length - off)), off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(out);
}

// The Worker's email() handler.
export async function receiveEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const inbox = env.E2E_INBOX?.toLowerCase();
  if (!inbox || message.to.toLowerCase() !== inbox) {
    message.setReject("unknown address");
    return;
  }
  const body = await readCapped(message.raw);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO e2e_inbox (received_at, mail_from, subject, body) VALUES (?, ?, ?, ?)").bind(now, message.from, message.headers.get("subject"), body),
    env.DB.prepare("DELETE FROM e2e_inbox WHERE id NOT IN (SELECT id FROM e2e_inbox ORDER BY id DESC LIMIT ?)").bind(INBOX_MAX_ROWS),
  ]);
}

export async function sweepInbox(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM e2e_inbox WHERE received_at < ?").bind(now - INBOX_TTL_MS).run();
}

export async function latestMessage(env: Env): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare("SELECT id, received_at, mail_from, subject, body FROM e2e_inbox ORDER BY id DESC LIMIT 1").first<{ id: number; received_at: number; mail_from: string | null; subject: string | null; body: string }>();
  if (!row) return null;
  const text = decodeQuotedPrintable(row.body);
  const links = [...new Set(text.match(/https:\/\/[^\s"'<>]+/g) ?? [])].map((u) => u.replace(/&amp;/g, "&"));
  return { id: row.id, received_at: new Date(row.received_at).toISOString(), from: row.mail_from, subject: row.subject, links, body: text };
}

// GET /admin/e2e-inbox: the newest test message (admin only).
export async function handleInboxRead(request: Request, env: Env): Promise<Response> {
  await requireBearer(request, env.ADMIN_TOKEN, "admin");
  const msg = await latestMessage(env);
  if (!msg) throw new HttpError(404, "the test inbox is empty");
  return jsonResponse(msg);
}
