import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dailyNumbers } from "../src/ops";
import { notifyReports, REPORT_DIGEST_EVERY_MS, REPORTS_PER_SOURCE_PER_HOUR, resolveReport, sweepReports } from "../src/reports";
import { ADMIN, call, freshIp, MAIN, upload } from "./helpers";

const SITE = "https://sugi.moe";
const MAIL: Partial<Env> = { RESEND_API_KEY: "re_test" };

afterEach(() => {
  vi.restoreAllMocks();
});

function report(body: Record<string, unknown>, ip = freshIp(), headers: Record<string, string> = {}): Promise<Response> {
  return call(
    new Request(`${MAIN}/api/reports`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", accept: "application/json", "cf-connecting-ip": ip, ...headers },
    }),
  );
}

function reportForm(fields: Record<string, string>, ip = freshIp()): Promise<Response> {
  return call(new Request(`${MAIN}/api/reports`, { method: "POST", body: new URLSearchParams(fields), headers: { "cf-connecting-ip": ip, origin: SITE } }));
}

async function rowsFor(target: string) {
  return (await env.DB.prepare("SELECT * FROM reports WHERE target = ? ORDER BY id").bind(target).all<Record<string, any>>()).results;
}

function stubResend(): { subject: string; text: string; to: string[] }[] {
  const sent: { subject: string; text: string; to: string[] }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://api.resend.com/emails");
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "x" });
  });
  return sent;
}

// Marks every pending report as mailed long ago, so each test starts from a clean digest state.
async function settleDigest() {
  await env.DB.prepare("UPDATE reports SET notified_at = ? WHERE notified_at IS NULL OR notified_at > ?").bind(1, 1).run();
}

describe("reports", () => {
  it("stores a report on a file, once per reporter and target", async () => {
    const f = await upload();
    const ip = freshIp();
    const body = { target: f.page, reason: "copyright", details: "  my photo\u0007 ", contact: "me@example.org" };
    expect((await report(body, ip)).status).toBe(202);
    expect((await report(body, ip)).status).toBe(202);
    const rows = await rowsFor(`file:${f.id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "copyright", details: "my photo", contact: "me@example.org", resolved_at: null });
    expect(rows[0].source).toMatch(/^[0-9a-f]{64}$/);
    // Another reporter on the same file is a second report.
    expect((await report(body)).status).toBe(202);
    expect(await rowsFor(`file:${f.id}`)).toHaveLength(2);
  });

  it("refuses bad reasons, unknown targets and cross-site posts", async () => {
    const f = await upload();
    expect((await report({ target: f.page, reason: "boring" })).status).toBe(400);
    expect((await report({ target: "not a link", reason: "spam" })).status).toBe(400);
    expect((await report({ target: `${SITE}/f/zzzzzzzz`, reason: "spam" })).status).toBe(404);
    expect((await report({ target: f.page, reason: "spam" }, freshIp(), { origin: "https://evil.example" })).status).toBe(403);
    expect((await call(new Request(`${MAIN}/api/reports`))).status).toBe(405);
  });

  it("limits how many reports one source sends", async () => {
    const ip = freshIp();
    for (let i = 0; i < REPORTS_PER_SOURCE_PER_HOUR; i++) {
      const f = await upload();
      expect((await report({ target: f.id, reason: "spam" }, ip)).status).toBe(202);
    }
    const f = await upload();
    const res = await report({ target: f.id, reason: "spam" }, ip);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3600");
  });

  it("takes the page's plain form and redirects back with the outcome", async () => {
    const f = await upload();
    const res = await reportForm({ target: `f/${f.id}`, reason: "privacy", details: "my face", contact: "" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${SITE}/f/${f.id}?report=sent#report`);
    expect((await rowsFor(`file:${f.id}`))[0]).toMatchObject({ reason: "privacy", contact: null });
    const bad = await reportForm({ target: `f/${f.id}`, reason: "nope" });
    expect(bad.headers.get("location")).toBe(`${SITE}/f/${f.id}?report=failed#report`);
  });

  it("reports albums too", async () => {
    const f = await upload();
    const created = await call(
      new Request(`${MAIN}/api/albums`, {
        method: "POST",
        body: JSON.stringify({ files: [f.id] }),
        headers: { "content-type": "application/json", accept: "application/json", "cf-connecting-ip": freshIp(), ...ADMIN },
      }),
    );
    const album = await created.json<{ id: string; url: string }>();
    const res = await reportForm({ target: `a/${album.id}`, reason: "illegal" });
    expect(res.headers.get("location")).toBe(`${SITE}/a/${album.id}?report=sent#report`);
    expect(await rowsFor(`album:${album.id}`)).toHaveLength(1);
  });

  it("shows the form on file and album pages, and the outcome after a plain post", async () => {
    const f = await upload();
    const page = await (await call(new Request(`${MAIN}/f/${f.id}`, { headers: { accept: "text/html" } }))).text();
    expect(page).toContain('<form class="report-form" method="post" action="/api/reports" data-report');
    expect(page).toContain(`name="target" value="f/${f.id}"`);
    for (const r of ["csam", "illegal", "copyright", "privacy", "spam", "other"]) expect(page).toContain(`value="${r}"`);
    const sent = await (await call(new Request(`${MAIN}/f/${f.id}?report=sent`, { headers: { accept: "text/html" } }))).text();
    expect(sent).toContain('<details class="report-box" id="report" open>');
    expect(sent).not.toContain("report-form");
  });

  it("mails new reports to the abuse address as a digest, at most once an hour", async () => {
    await settleDigest();
    const f = await upload();
    const g = await upload();
    expect((await report({ target: f.page, reason: "spam", details: "buy pills" })).status).toBe(202);
    expect((await report({ target: g.page, reason: "csam" })).status).toBe(202);
    const now = Date.now() + 2 * REPORT_DIGEST_EVERY_MS;
    const sent = stubResend();
    expect(await notifyReports({ ...env, ...MAIL } as Env, now)).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["abuse@sugi.moe"]);
    expect(sent[0].subject).toBe("[sugi.moe] URGENT: 2 new reports");
    expect(sent[0].text).toContain(`${SITE}/f/${f.id}`);
    expect(sent[0].text).toContain('"buy pills"');
    // Inside the hour nothing more goes out, even with a new report waiting.
    const h = await upload();
    expect((await report({ target: h.page, reason: "other" })).status).toBe(202);
    expect(await notifyReports({ ...env, ...MAIL } as Env, now + 60e3)).toBe(0);
    expect(await notifyReports({ ...env, ...MAIL } as Env, now + REPORT_DIGEST_EVERY_MS + 1)).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toBe("[sugi.moe] 1 new report");
    // Without an abuse address or a mail sender nothing is sent.
    expect(await notifyReports({ ...env, ...MAIL, ABUSE_EMAIL: "", CONTACT_EMAIL: "" } as Env, now + 10 * REPORT_DIGEST_EVERY_MS)).toBe(0);
    expect(await notifyReports(env, now + 10 * REPORT_DIGEST_EVERY_MS)).toBe(0);
  });

  it("resolve_report takes the target down and settles every open report on it", async () => {
    const f = await upload();
    expect((await report({ target: f.page, reason: "csam" })).status).toBe(202);
    expect((await report({ target: f.url, reason: "illegal" })).status).toBe(202);
    const [first, second] = await rowsFor(`file:${f.id}`);
    const out = await resolveReport(env, first.id, "takedown", { note: "confirmed", blockContent: true });
    expect(out).toMatchObject({ target: `file:${f.id}`, resolution: "removed", resolved_reports: [first.id, second.id] });
    expect((await call(new Request(f.url))).status).toBe(451);
    const log = await env.DB.prepare("SELECT reason FROM admin_log WHERE target = ? ORDER BY id DESC").bind(`file:${f.id}`).first<{ reason: string }>();
    expect(log?.reason).toBe(`report #${first.id} (csam): confirmed`);
    await expect(resolveReport(env, second.id, "dismiss")).rejects.toThrow(/already resolved/);
  });

  it("dismissing leaves the file up and is logged", async () => {
    const f = await upload();
    expect((await report({ target: f.page, reason: "other" })).status).toBe(202);
    const [r] = await rowsFor(`file:${f.id}`);
    expect(await resolveReport(env, r.id, "dismiss", { note: "fine" })).toMatchObject({ resolution: "dismissed", resolved_reports: [r.id] });
    expect((await call(new Request(f.url))).status).toBe(200);
    const log = await env.DB.prepare("SELECT action FROM admin_log WHERE target = ? ORDER BY id DESC").bind(`file:${f.id}`).first<{ action: string }>();
    expect(log?.action).toBe("dismiss_report");
  });

  it("forgets reporters' fingerprints after a week and resolved reports after a year", async () => {
    const f = await upload();
    expect((await report({ target: f.page, reason: "spam" })).status).toBe(202);
    const [r] = await rowsFor(`file:${f.id}`);
    await sweepReports(env, Date.now() + 8 * 86400e3);
    expect((await rowsFor(`file:${f.id}`))[0].source).toBeNull();
    await resolveReport(env, r.id, "dismiss");
    await sweepReports(env, Date.now() + 300 * 86400e3);
    expect(await rowsFor(`file:${f.id}`)).toHaveLength(1);
    await sweepReports(env, Date.now() + 400 * 86400e3);
    expect(await rowsFor(`file:${f.id}`)).toHaveLength(0);
  });

  it("counts reports in the daily numbers", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const before = await dailyNumbers(env, day);
    const f = await upload();
    expect((await report({ target: f.page, reason: "spam" })).status).toBe(202);
    const after = await dailyNumbers(env, day);
    expect(after.new_reports).toBe(Number(before.new_reports) + 1);
    expect(after.open_reports).toBe(Number(before.open_reports) + 1);
  });
});
