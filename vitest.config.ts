import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
        },
      },
    }),
  ],
});
