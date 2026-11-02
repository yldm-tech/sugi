#!/usr/bin/env bash
# Deploys the staging Worker (wrangler.staging.jsonc: sugi-staging on workers.dev, with its own database, bucket and secrets). The end-to-end scripts default to it, so changes are tried there before sugi.moe.
#
# Secrets come from ~/.config/sugi/staging.env (or SUGI_STAGING_SECRETS_FILE); every key in it becomes a Worker secret.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
secrets="${SUGI_STAGING_SECRETS_FILE:-$HOME/.config/sugi/staging.env}"

if grep -q '^UPLOAD_TOKEN=' "$secrets"; then
  echo "deploy-staging: $secrets contains UPLOAD_TOKEN; remove it first (the scripts expect anonymous uploads to work)" >&2
  exit 1
fi
for key in IP_HASH_SECRET ADMIN_TOKEN TRUSTED_TOKEN; do
  grep -q "^$key=." "$secrets" || { echo "deploy-staging: $key is missing from $secrets" >&2; exit 1; }
done

cd "$here"
npx wrangler d1 migrations apply sugi-staging --remote --config wrangler.staging.jsonc
npx wrangler deploy --config wrangler.staging.jsonc --secrets-file "$secrets"
