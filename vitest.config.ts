import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Test-only values; production secrets live in Cloudflare and ~/.config/sugi/secrets.env.
          bindings: {
            IP_HASH_SECRET: "test-ip-hash-secret",
            ADMIN_TOKEN: "test-admin-token",
            UPLOAD_TOKEN: "test-upload-token",
            TRUSTED_TOKEN: "test-trusted-token",
            // Production serves through r2.sugi.moe; tests default to reading the bucket directly and opt in to cache-through per test with a stubbed fetch, so nothing leaves the sandbox.
            CACHE_ORIGIN: "",
            // Pin the public origins so a local .dev.vars (used by `wrangler dev`) cannot leak into tests.
            MAIN_ORIGIN: "https://sugi.moe",
            FILES_ORIGIN: "https://files.sugi.moe",
            TMP_ORIGIN: "https://tmp.sugi.moe",
            // Most tests describe the sugi.moe deployment (wrangler.production.jsonc); the template's empty branding is covered by test/template.test.ts, which overrides these per request.
            SITE_NAME: "sugi.moe",
            OPERATOR_NAME: "YLDM Co., Ltd.",
            CONTACT_EMAIL: "hi@sugi.moe",
            ABUSE_EMAIL: "abuse@sugi.moe",
            CSAM_SCANNING: "1",
            EMAIL_ROUTING: "1",
            WAF_RATE_LIMIT: "1",
            STORAGE_LOCATION: "APAC",
            RESEND_REGION: "ap-northeast-1",
            MAIL_FROM: "sugi.moe <login@sugi.moe>",
            FEATURE_ACCOUNTS: "0",
            ACCOUNT_FEATURES: "email",
            E2E_INBOX: "e2e-testinbox@sugi.moe",
            FEATURE_CLI: "0",
            FEATURE_DONATE: "0",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});
