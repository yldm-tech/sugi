#!/usr/bin/env bash
# End-to-end check against a deployed sugi instance. Uploads a real image, verifies the round trip and headers, verifies that HTML/SVG and (while the gate is on) anonymous uploads are rejected, then deletes the test object.
#
# Usage: scripts/e2e.sh BASE_URL IMAGE.png
# Tokens come from ~/.config/sugi/secrets.env (or SUGI_SECRETS_FILE) and are only ever passed to curl through stdin.

set -euo pipefail

base="${1:?usage: e2e.sh BASE_URL IMAGE.png}"
base="${base%/}"
image="${2:?usage: e2e.sh BASE_URL IMAGE.png}"
secrets="${SUGI_SECRETS_FILE:-$HOME/.config/sugi/secrets.env}"
here="$(cd "$(dirname "$0")/.." && pwd)"

upload_token="$(sed -n 's/^UPLOAD_TOKEN=//p' "$secrets")"
admin_token="$(sed -n 's/^ADMIN_TOKEN=//p' "$secrets")"
trusted_token="$(sed -n 's/^TRUSTED_TOKEN=//p' "$secrets")"
burst="${SUGI_E2E_BURST:-60}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1 ($2)"; else fail "$1: expected '$3', got '$2'"; fi; }

# curl with an optional bearer token supplied via a config on stdin.
c() {
  local token="$1"
  shift
  if [ -n "$token" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$token" | curl --silent --show-error --connect-timeout 10 --max-time 120 --config - "$@"
  else
    curl --silent --show-error --connect-timeout 10 --max-time 120 "$@" </dev/null
  fi
}

header() { grep -i "^$1:" "$2" | head -n1 | cut -d' ' -f2- | tr -d '\r'; }

echo "== $base"

code="$(c "" -o "$work/index.html" -D "$work/index.h" -w '%{http_code}' "$base/")"
check "GET / status" "$code" 200
grep -q 'abuse@sugi.moe' "$work/index.html" && pass "index mentions abuse contact" || fail "index lacks abuse contact"

code="$(c "" -o "$work/anon.txt" -w '%{http_code}' -T "$image" "$base/upload")"
check "anonymous upload rejected while gate is on" "$code" 401

url="$(SUGI_URL="$base" SUGI_TRUSTED_TOKEN="$trusted_token" "$here/bin/sugi-upload" "$image")"
expected_key="$(shasum -a 256 "$image" | cut -c1-16).png"
check "sugi-upload returns content-addressed URL" "$url" "$base/$expected_key"
key="${url##*/}"

code="$(c "" -o "$work/back.png" -D "$work/get.h" -w '%{http_code}' "$url")"
check "GET image status" "$code" 200
cmp -s "$image" "$work/back.png" && pass "downloaded bytes identical" || fail "downloaded bytes differ"
check "Content-Type" "$(header content-type "$work/get.h")" "image/png"
check "X-Content-Type-Options" "$(header x-content-type-options "$work/get.h")" "nosniff"
check "Content-Disposition" "$(header content-disposition "$work/get.h")" "inline; filename=\"$key\""
check "Content-Security-Policy" "$(header content-security-policy "$work/get.h")" "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"
check "Cache-Control" "$(header cache-control "$work/get.h")" "public, max-age=31536000, immutable"
etag="$(header etag "$work/get.h")"
[ -n "$etag" ] && pass "ETag present ($etag)" || fail "ETag missing"

code="$(c "" -o /dev/null -D "$work/head.h" -w '%{http_code}' -I "$url")"
check "HEAD status" "$code" 200
check "HEAD Content-Length" "$(header content-length "$work/head.h")" "$(wc -c <"$image" | tr -d ' ')"

code="$(c "" -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" "$url")"
check "conditional GET" "$code" 304

code="$(c "$upload_token" -o "$work/dup.json" -w '%{http_code}' -H 'Accept: application/json' -T "$image" "$base/upload")"
check "re-upload of same content" "$code" 200
grep -q '"deduplicated":true' "$work/dup.json" && pass "re-upload reported as deduplicated" || fail "re-upload not deduplicated: $(cat "$work/dup.json")"

printf '<!doctype html><html><body><script>alert(1)</script></body></html>\n' >"$work/evil.html"
printf '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n' >"$work/evil.svg"
check "HTML rejected (multipart, claimed image/png)" "$(c "$upload_token" -o /dev/null -w '%{http_code}' -F "file=@$work/evil.html;type=image/png;filename=x.png" "$base/upload")" 415
check "SVG rejected (multipart)" "$(c "$upload_token" -o /dev/null -w '%{http_code}' -F "file=@$work/evil.svg" "$base/upload")" 415
check "SVG rejected (raw PUT)" "$(c "$upload_token" -o /dev/null -w '%{http_code}' -T "$work/evil.svg" "$base/upload")" 415

check "unknown key" "$(c "" -o /dev/null -w '%{http_code}' "$base/0000000000000000.png")" 404
check "DELETE without admin token" "$(c "" -o /dev/null -w '%{http_code}' -X DELETE "$url")" 401
check "DELETE with upload token" "$(c "$upload_token" -o /dev/null -w '%{http_code}' -X DELETE "$url")" 401

code="$(c "$admin_token" -o "$work/info.json" -w '%{http_code}' "$base/admin/info/$key")"
check "admin info" "$code" 200
grep -Eq '"source":"[0-9a-f]{64}"' "$work/info.json" && pass "source HMAC recorded" || fail "source HMAC missing"

check "DELETE with admin token" "$(c "$admin_token" -o /dev/null -w '%{http_code}' -X DELETE "$url")" 200
check "GET after delete" "$(c "" -o /dev/null -w '%{http_code}' "$url")" 404

# Rate limits: a burst well above both the Worker limiter and the zone WAF rule must all pass with the trusted token, and must start returning 429 without it. Every burst object comes from this client, so one purge-by-source cleans them all up.
burst_upload() {
  local token="$1" tag="$2" i codes=""
  for i in $(seq 1 "$burst"); do
    printf '\x89PNG\r\n\x1a\nsugi-e2e-%s-%s-%s' "$tag" "$i" "$(date +%s%N)" >"$work/burst.png"
    codes="$codes $(c "$token" -o "$work/burst.out" -w '%{http_code}' -T "$work/burst.png" "$base/upload")"
    [ ! -s "$work/burst.key" ] && grep -q '^https://' "$work/burst.out" && sed 's#.*/##' "$work/burst.out" >"$work/burst.key"
  done
  echo "$codes"
}
trusted_codes="$(burst_upload "$trusted_token" trusted)"
check "trusted burst of $burst: non-201 responses" "$(echo $trusted_codes | tr ' ' '\n' | grep -vc '^201$' || true)" 0
untrusted_codes="$(burst_upload "$upload_token" untrusted)"
n429="$(echo $untrusted_codes | tr ' ' '\n' | grep -c '^429$' || true)"
if [ "$n429" -gt 0 ]; then pass "untrusted burst of $burst hit 429 ($n429 times, first at #$(echo $untrusted_codes | tr ' ' '\n' | grep -n '^429$' | head -n1 | cut -d: -f1))"; else fail "untrusted burst of $burst never got 429"; fi
if [ -s "$work/burst.key" ]; then
  burst_key="$(cat "$work/burst.key")"
  src="$(c "$admin_token" "$base/admin/info/$burst_key" | sed -E 's/.*"source":"([0-9a-f]+)".*/\1/')"
  purged="$(c "$admin_token" -H 'content-type: application/json' -d "{\"source\":\"$src\"}" "$base/admin/purge-by-source" | grep -oE '"count":[0-9]+' | cut -d: -f2)"
  pass "purged $purged burst objects"
fi

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
