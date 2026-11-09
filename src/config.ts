// Deployment configuration. Everything that makes an instance *someone's* site (name, domains, operator, contacts, which hardening is in place) comes from wrangler vars, so a fresh deploy of this repository is the deployer's own site and never claims to be sugi.moe. Empty values fall back to safe defaults that work on a bare *.workers.dev URL.

export interface Brand {
  /** Shown in titles, the footer and Open Graph, e.g. "sugi.moe" or "pics.example.org". */
  siteName: string;
  /** Logo text left and right of the heart: "sugi♥moe" for "sugi.moe"; the right part is empty (no heart) for other shapes of name. */
  logo: [string, string];
  /** Legal entity or person running the site; null when not configured. */
  operator: string | null;
  /** General and privacy contact; null when not configured. */
  contactEmail: string | null;
  /** Abuse reports; falls back to the general contact. */
  abuseEmail: string | null;
  /** Cloudflare's CSAM Scanning Tool is enabled on the zone (only then may the pages say so). */
  csamScanning: boolean;
  /** The zone has the WAF rate limiting rule for upload paths (see README); the developer page then describes it. */
  wafRule: boolean;
  /** Mail to the contact addresses is forwarded by Cloudflare Email Routing (named as a processor in the privacy policy). */
  emailRouting: boolean;
  /** Where the R2 bucket stores data, e.g. "APAC"; mentioned in the privacy policy when set. */
  storageLocation: string | null;
  /** Resend region used for login emails, e.g. "ap-northeast-1". */
  resendRegion: string | null;
  /** Sender of login emails, e.g. "sugi.moe <login@sugi.moe>". */
  mailFrom: string | null;
  /** Public source code of this deployment (e.g. https://github.com/you/sugi); linked from the footer, FAQ and developer page. */
  sourceUrl: string | null;
  /** "Deploy to Cloudflare" link for the source, when it is on GitHub or GitLab. */
  deployUrl: string | null;
  /** Permanent files are copied to a backup bucket (the BACKUP binding); the privacy policy then says so. */
  backup: boolean;
  /** Use the sugi.moe-branded Open Graph images (only for the sugi.moe deployment itself). */
  officialArtwork: boolean;
}

const blank = (v: string | undefined | null): string | null => {
  const s = (v ?? "").trim();
  return s ? s : null;
};

export function brand(env: Env): Brand {
  const siteName = blank(env.SITE_NAME) ?? new URL(env.MAIN_ORIGIN || "https://sugi.invalid").hostname;
  // Two labels make the wordmark ("sugi.moe" -> sugi♥moe); longer hostnames such as my-sugi.you.workers.dev keep only the first label so the header stays short.
  const labels = siteName.split(".");
  const logo: [string, string] = labels.length === 2 && labels[0] && labels[1] ? [labels[0], labels[1]] : [labels[0] || siteName, ""];
  const contactEmail = blank(env.CONTACT_EMAIL);
  return {
    siteName,
    logo,
    operator: blank(env.OPERATOR_NAME),
    contactEmail,
    abuseEmail: blank(env.ABUSE_EMAIL) ?? contactEmail,
    csamScanning: env.CSAM_SCANNING === "1",
    emailRouting: env.EMAIL_ROUTING === "1",
    wafRule: env.WAF_RATE_LIMIT === "1",
    storageLocation: blank(env.STORAGE_LOCATION),
    resendRegion: blank(env.RESEND_REGION),
    mailFrom: blank(env.MAIL_FROM),
    sourceUrl: blank(env.SOURCE_URL),
    deployUrl: /^https:\/\/(github\.com|gitlab\.com)\/[^/]+\/[^/]+\/?$/.test(blank(env.SOURCE_URL) ?? "")
      ? `https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(blank(env.SOURCE_URL)!.replace(/\/$/, ""))}`
      : null,
    backup: Boolean(env.BACKUP),
    officialArtwork: siteName === "sugi.moe" && env.MAIN_ORIGIN === "https://sugi.moe",
  };
}

/**
 * Fills in the origins a template deployment leaves empty: the main origin is the request's own origin (e.g. https://my-sugi.example.workers.dev), and without dedicated hosts files are served from paths on the main host and the admin dashboard from /_admin.
 */
export function withDefaults(env: Env, request: Request): Env {
  if (env.MAIN_ORIGIN && env.FILES_ORIGIN && env.TMP_ORIGIN && env.ADMIN_ORIGIN) return env;
  const origin = env.MAIN_ORIGIN || new URL(request.url).origin;
  return {
    ...env,
    MAIN_ORIGIN: origin,
    FILES_ORIGIN: env.FILES_ORIGIN || `${origin}/_files`,
    TMP_ORIGIN: env.TMP_ORIGIN || `${origin}/_tmp`,
    ADMIN_ORIGIN: env.ADMIN_ORIGIN || `${origin}/_admin`,
  };
}
