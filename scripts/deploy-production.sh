#!/usr/bin/env bash
# Deploys https://sugi.moe from wrangler.production.jsonc. Only for the sugi.moe maintainers; self-hosters run `npm run deploy` with wrangler.jsonc.
#
# Secrets are uploaded from ~/.config/sugi/secrets.env (or SUGI_SECRETS_FILE). Every key in that file becomes a Worker secret, so it must never contain UPLOAD_TOKEN: that would close sugi.moe to anonymous uploads.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
secrets="${SUGI_SECRETS_FILE:-$HOME/.config/sugi/secrets.env}"

if grep -q '^UPLOAD_TOKEN=' "$secrets"; then
  echo "deploy-production: $secrets contains UPLOAD_TOKEN; remove it first (it would close uploads to the public)" >&2
  exit 1
fi
for key in IP_HASH_SECRET ADMIN_TOKEN TRUSTED_TOKEN CF_PURGE_TOKEN; do
  grep -q "^$key=." "$secrets" || { echo "deploy-production: $key is missing from $secrets" >&2; exit 1; }
done

cd "$here"
echo "rollback target (current version):"
npx wrangler deployments list --config wrangler.production.jsonc 2>/dev/null | grep -E 'Version\(s\)' | tail -n 1 || true
npx wrangler deploy --config wrangler.production.jsonc --secrets-file "$secrets"
