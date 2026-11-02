// Secrets are not declared in wrangler.jsonc, so `wrangler types` cannot see them; they are optional because each one switches a feature on or off.
interface SugiSecrets {
  IP_HASH_SECRET?: string;
  ADMIN_TOKEN?: string;
  UPLOAD_TOKEN?: string;
  TRUSTED_TOKEN?: string;
  CF_PURGE_TOKEN?: string;
  RESEND_API_KEY?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

interface Env extends SugiSecrets {}

declare namespace Cloudflare {
  interface Env extends SugiSecrets {}
}
