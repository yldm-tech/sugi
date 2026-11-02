#!/usr/bin/env bash
# End-to-end check against a deployed sugi instance. Uploads a synthetic image that is unique to this run, verifies the round trip and headers, verifies that HTML/SVG and (while the gate is on) anonymous uploads are rejected, runs rate limit bursts, then deletes only the objects this run created.
#
# Keys are content hashes, so uploading a real file and deleting its key would delete anyone's identical upload. This script therefore never takes an input file: every image it uploads is generated here with random content, and it only deletes a key after the service confirmed (201, deduplicated:false) that this run created it.
#
# Usage: scripts/e2e.sh [BASE_URL]   (default the staging Worker, https://sugi-staging.evan-e2b.workers.dev)
# Tokens come from ~/.config/sugi/staging.env for staging and ~/.config/sugi/secrets.env for anything else (or SUGI_SECRETS_FILE), and are only ever passed to curl through stdin.

set -euo pipefail

staging="https://sugi-staging.evan-e2b.workers.dev"
base="${1:-$staging}"
base="${base%/}"
if [ "$base" = "$staging" ]; then default_secrets="$HOME/.config/sugi/staging.env"; else default_secrets="$HOME/.config/sugi/secrets.env"; fi
# Only sugi.moe sits behind the zone (WAF rule, cache-through on r2.sugi.moe); staging and other workers.dev instances do not.
if [ "$base" = "https://sugi.moe" ]; then zone=1; else zone=0; fi
secrets="${SUGI_SECRETS_FILE:-$default_secrets}"
here="$(cd "$(dirname "$0")/.." && pwd)"

upload_token="$(sed -n 's/^UPLOAD_TOKEN=//p' "$secrets")"
admin_token="$(sed -n 's/^ADMIN_TOKEN=//p' "$secrets")"
trusted_token="$(sed -n 's/^TRUSTED_TOKEN=//p' "$secrets")"
burst="${SUGI_E2E_BURST:-100}"
# Set to 0 when checking an instance without the zone WAF rate limiting rule (e.g. workers.dev, which the zone rules do not cover).
expect_waf="${SUGI_E2E_EXPECT_WAF:-$zone}"
# The abuse address the terms page must show (ABUSE_EMAIL); set to empty for an instance without one, such as a fresh template deployment.
abuse_email="${SUGI_E2E_ABUSE_EMAIL-abuse@sugi.moe}"
# The R2 custom domain the Worker reads images through (wrangler.jsonc CACHE_ORIGIN); set to empty to skip the cache checks.
if [ "$zone" = 1 ]; then default_cache="https://r2.sugi.moe"; else default_cache=""; fi
cache_origin="${SUGI_CACHE_ORIGIN-$default_cache}"

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

# A valid 16x16 RGB PNG with random pixels and a tEXt chunk naming this run, so its hash cannot match any real upload.
make_png() {
  timeout 30 python3 -I - "$1" "$2" <<'EOF'
import os, struct, sys, zlib
def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
w = h = 16
raw = b"".join(b"\x00" + os.urandom(w * 3) for _ in range(h))
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"tEXt", b"Comment\x00sugi-e2e " + sys.argv[2].encode()) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
open(sys.argv[1], "wb").write(png)
EOF
}

run_id="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 8)"
# Ten minutes of slack for clock skew between this machine and Cloudflare; the 201 response is the primary proof of ownership.
run_started="$(date -u -v-10M +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d '-10 min' +%Y-%m-%dT%H:%M:%S)"
image="$work/e2e.png"
make_png "$image" "$run_id"

echo "== $base"

code="$(c "" -o "$work/index.html" -D "$work/index.h" -w '%{http_code}' "$base/")"
check "GET / status" "$code" 200
c "" -o "$work/terms.html" "$base/terms"
if [ -n "$abuse_email" ]; then
  grep -q "$abuse_email" "$work/terms.html" && pass "terms page names the abuse contact" || fail "terms page lacks the abuse contact"
fi

# The gate is optional: production runs without UPLOAD_TOKEN. With a token in the secrets file, anonymous uploads must be refused; without one, they must work (checked on the current API further down, where the object can be deleted with its own token).
if [ -n "$upload_token" ]; then
  code="$(c "" -o "$work/anon.txt" -w '%{http_code}' -T "$image" "$base/upload")"
  check "anonymous upload rejected while the gate is on" "$code" 401
fi

expected_key="$(shasum -a 256 "$image" | cut -c1-16).png"
code="$(c "$trusted_token" -o "$work/first.json" -w '%{http_code}' -H 'Accept: application/json' -T "$image" "$base/upload")"
check "first upload of the run's synthetic image creates it" "$code" 201
owned=0
if [ "$code" = 201 ] && grep -q '"deduplicated":false' "$work/first.json" && grep -q "\"key\":\"$expected_key\"" "$work/first.json"; then owned=1; fi
url="$base/$expected_key"
key="$expected_key"

client_url="$(SUGI_URL="$base" SUGI_TRUSTED_TOKEN="$trusted_token" "$here/bin/sugi-upload" "$image")"
check "sugi-upload returns content-addressed URL" "$client_url" "$url"

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

if [ -n "$cache_origin" ]; then
  # The GET above made the Worker fetch the image through the zone cache, so the origin URL should already be cached in this location.
  c "" -o "$work/origin.png" -D "$work/origin.h" "$cache_origin/$key"
  check "image is in the zone cache after a Worker GET" "$(header cf-cache-status "$work/origin.h")" HIT
  cmp -s "$image" "$work/origin.png" && pass "cached bytes identical" || fail "cached bytes differ"
fi

code="$(c "" -o /dev/null -D "$work/head.h" -w '%{http_code}' -I "$url")"
check "HEAD status" "$code" 200
check "HEAD Content-Length" "$(header content-length "$work/head.h")" "$(wc -c <"$image" | tr -d ' ')"

code="$(c "" -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" "$url")"
check "conditional GET" "$code" 304

code="$(c "$trusted_token" -o "$work/dup.json" -w '%{http_code}' -H 'Accept: application/json' -T "$image" "$base/upload")"
check "re-upload of same content" "$code" 200
grep -q '"deduplicated":true' "$work/dup.json" && pass "re-upload reported as deduplicated" || fail "re-upload not deduplicated: $(cat "$work/dup.json")"

printf '<!doctype html><html><body><script>alert(1)</script></body></html>\n' >"$work/evil.html"
printf '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n' >"$work/evil.svg"
check "HTML rejected (multipart, claimed image/png)" "$(c "$trusted_token" -o /dev/null -w '%{http_code}' -F "file=@$work/evil.html;type=image/png;filename=x.png" "$base/upload")" 415
check "SVG rejected (multipart)" "$(c "$trusted_token" -o /dev/null -w '%{http_code}' -F "file=@$work/evil.svg" "$base/upload")" 415
check "SVG rejected (raw PUT)" "$(c "$trusted_token" -o /dev/null -w '%{http_code}' -T "$work/evil.svg" "$base/upload")" 415

check "unknown key" "$(c "" -o /dev/null -w '%{http_code}' "$base/0000000000000000.png")" 404
check "DELETE without admin token" "$(c "" -o /dev/null -w '%{http_code}' -X DELETE "$url")" 401
check "DELETE with upload token" "$(c "$upload_token" -o /dev/null -w '%{http_code}' -X DELETE "$url")" 401

code="$(c "$admin_token" -o "$work/info.json" -w '%{http_code}' "$base/admin/info/$key")"
check "admin info" "$code" 200
grep -Eq '"source":"[0-9a-f]{64}"' "$work/info.json" && pass "source HMAC recorded" || fail "source HMAC missing"

# Second guard before deleting: the stored object must be this run's bytes and must have been stored after the run started.
stored_sha="$(sed -nE 's/.*"sha256":"([0-9a-f]{64})".*/\1/p' "$work/info.json")"
stored_at="$(sed -nE 's/.*"uploaded":"([^"]+)".*/\1/p' "$work/info.json")"
if [ "$owned" = 1 ] && [ "$stored_sha" = "$(shasum -a 256 "$image" | cut -d' ' -f1)" ] && [[ "$stored_at" > "$run_started" ]]; then
  check "DELETE with admin token" "$(c "$admin_token" -o "$work/delete.json" -w '%{http_code}' -X DELETE "$url")" 200
  grep -q '"cache_purged":true' "$work/delete.json" && pass "DELETE purged the zone cache" || fail "DELETE did not purge the cache: $(cat "$work/delete.json")"
  # An admin deletion is a takedown: the link answers 451 from now on and the key holds an empty tombstone.
  check "GET after delete (taken down)" "$(c "" -o /dev/null -w '%{http_code}' "$url")" 451
  if [ -n "$cache_origin" ]; then
    # Purges propagate within seconds; poll briefly rather than fail on the first stale read. The origin now holds the empty tombstone instead of the image.
    origin_bytes=""
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      origin_bytes="$(c "" -o /dev/null -w '%{size_download}' "$cache_origin/$key")"
      [ "$origin_bytes" = 0 ] && break
      sleep 2
    done
    check "cached origin copy gone after purge (bytes served)" "$origin_bytes" 0
  fi
else
  fail "not deleting $key: this run did not create it (owned=$owned, uploaded=$stored_at)"
fi

# Current API (/api/upload, files and tmp hosts, delete tokens, albums). Every object here is created by this run with fresh random content and deleted with its own delete token, so nothing anyone else uploaded can be touched.
if [ "${SUGI_E2E_NEW_API:-1}" = 1 ]; then
  api_png="$work/api.png"
  make_png "$api_png" "$run_id-api"
  # Anonymous when the gate is off, so this also proves anonymous uploads work.
  api_auth="$trusted_token"
  [ -z "$upload_token" ] && api_auth=""
  code="$(c "$api_auth" -o "$work/api.json" -w '%{http_code}' -H 'Accept: application/json' -T "$api_png" "$base/api/upload?style=cute&name=e2e.png")"
  api_label="anonymous"
  [ -n "$api_auth" ] && api_label="trusted"
  check "PUT /api/upload ($api_label)" "$code" 201
  api_url="$(sed -nE 's/.*"url":"([^"]+)".*/\1/p' "$work/api.json")"
  api_id="$(sed -nE 's/.*"id":"([^"]+)".*/\1/p' "$work/api.json")"
  api_tok="$(sed -nE 's/.*"delete_token":"([^"]+)".*/\1/p' "$work/api.json")"
  [[ "$api_id" =~ ^[a-z]+-[a-z]+-[0-9]{2}$ ]] && pass "cute id ($api_id)" || fail "unexpected id: $api_id"
  code="$(c "" -o "$work/api-back.png" -D "$work/api.h" -w '%{http_code}' "$api_url")"
  check "GET on the files origin" "$code" 200
  cmp -s "$api_png" "$work/api-back.png" && pass "files origin bytes identical" || fail "files origin bytes differ"
  check "files origin Content-Type" "$(header content-type "$work/api.h")" "image/png"
  check "files origin CSP" "$(header content-security-policy "$work/api.h")" "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"
  check "Range request" "$(c "" -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-7' "$api_url")" 206
  check "file page" "$(c "" -o /dev/null -w '%{http_code}' "$base/f/$api_id")" 200

  code="$(c "$trusted_token" -o "$work/tmp.json" -w '%{http_code}' -H 'Accept: application/json' -F "file=@$api_png;filename=tmp.png" -F expire=1h "$base/api/upload")"
  check "multipart upload with expire=1h" "$code" 201
  tmp_url="$(sed -nE 's/.*"url":"([^"]+)".*/\1/p' "$work/tmp.json")"
  tmp_id="$(sed -nE 's/.*"id":"([^"]+)".*/\1/p' "$work/tmp.json")"
  tmp_tok="$(sed -nE 's/.*"delete_token":"([^"]+)".*/\1/p' "$work/tmp.json")"
  check "temporary file served" "$(c "" -o /dev/null -w '%{http_code}' "$tmp_url")" 200

  code="$(c "$trusted_token" -o "$work/album.json" -w '%{http_code}' -H 'Accept: application/json' -H 'Content-Type: application/json' -d "{\"files\":[\"$api_id\",\"$tmp_id\"],\"title\":\"e2e $run_id\"}" "$base/api/albums")"
  check "POST /api/albums" "$code" 201
  album_id="$(sed -nE 's/.*"id":"([^"]+)".*/\1/p' "$work/album.json")"
  album_tok="$(sed -nE 's/.*"delete_token":"([^"]+)".*/\1/p' "$work/album.json")"
  grep -q "\"$tmp_id\"" <(c "" "$base/api/albums/$album_id") && pass "album lists its files" || fail "album does not list its files"
  check "album page" "$(c "" -o /dev/null -w '%{http_code}' "$base/a/$album_id")" 200
  check "DELETE album with wrong token" "$(c "" -o /dev/null -w '%{http_code}' -X DELETE -H 'Sugi-Token: a_wrong' "$base/api/albums/$album_id")" 403
  check "DELETE album" "$(c "" -o /dev/null -w '%{http_code}' -X DELETE -H "Sugi-Token: $album_tok" "$base/api/albums/$album_id")" 200

  check "DELETE file with wrong token" "$(c "" -o /dev/null -w '%{http_code}' -X DELETE -H 'Sugi-Token: d_wrong' "$base/api/files/$api_id")" 403
  for pair in "$api_id:$api_tok:$api_url" "$tmp_id:$tmp_tok:$tmp_url"; do
    IFS=: read -r fid ftok _ <<<"$pair"
    furl="${pair#*:*:}"
    check "DELETE /api/files/$fid" "$(c "" -o /dev/null -w '%{http_code}' -X DELETE -H "Sugi-Token: $ftok" "$base/api/files/$fid")" 200
    check "gone after delete" "$(c "" -o /dev/null -w '%{http_code}' "$furl")" 404
  done
fi

# Rate limits: a burst well above both the Worker limiter and the zone WAF rule must all pass with the trusted token, and must start returning 429 without it. Cleanup deletes exactly the keys that came back 201, never by source, because purge-by-source would also remove real uploads made from this machine.
burst_upload() {
  local token="$1" tag="$2" i codes=""
  for i in $(seq 1 "$burst"); do
    printf '\x89PNG\r\n\x1a\nsugi-e2e-%s-%s-%s-%s' "$run_id" "$tag" "$i" "$(openssl rand -hex 16)" >"$work/burst.png"
    code="$(c "$token" -o "$work/burst.out" -w '%{http_code}' -H 'Accept: application/json' -T "$work/burst.png" "$base/api/upload")"
    codes="$codes $code"
    # Burst objects are deleted with their own delete tokens, so cleanup leaves no takedown records behind.
    if [ "$code" = 201 ]; then sed -nE 's/.*"id":"([^"]+)".*"delete_token":"([^"]+)".*/\1 \2/p' "$work/burst.out" >>"$work/burst.keys"; fi
    # Cloudflare's own rate limiting block page says "error code: 1015"; the Worker's 429 says "too many uploads".
    if [ "$code" = 429 ] && [ ! -s "$work/first429-$tag" ]; then { echo "$i"; head -c 200 "$work/burst.out"; } >"$work/first429-$tag"; fi
  done
  echo "$codes"
}
trusted_codes="$(burst_upload "$trusted_token" trusted)"
check "trusted burst of $burst: non-201 responses" "$(echo $trusted_codes | tr ' ' '\n' | grep -vc '^201$' || true)" 0
# One full WAF window (10 s) between the bursts, so the untrusted burst starts from a clean edge counter; the WAF's counting is approximate right after the trusted burst.
sleep 10
untrusted_codes="$(burst_upload "$upload_token" untrusted)"
n429="$(echo $untrusted_codes | tr ' ' '\n' | grep -c '^429$' || true)"
if [ "$n429" -gt 0 ]; then pass "untrusted burst of $burst hit 429 ($n429 times, first at #$(head -n1 "$work/first429-untrusted"))"; else fail "untrusted burst of $burst never got 429"; fi
if [ "$expect_waf" = 1 ]; then
  first_at="$(head -n1 "$work/first429-untrusted" 2>/dev/null || echo none)"
  if [ "$first_at" != none ] && [ "$first_at" -le 6 ] && grep -q 'error code: 1015' "$work/first429-untrusted"; then pass "zone WAF rule blocked the untrusted burst at #$first_at (error 1015)"; else fail "zone WAF rule did not block the untrusted burst within 6 requests (first 429 at #$first_at)"; fi
fi
if [ -s "$work/burst.keys" ]; then
  created="$(wc -l <"$work/burst.keys" | tr -d ' ')"
  deleted=0
  while read -r fid ftok; do
    [ "$(c "" -o /dev/null -w '%{http_code}' -X DELETE -H "Sugi-Token: $ftok" "$base/api/files/$fid")" = 200 ] && deleted=$((deleted + 1))
  done <"$work/burst.keys"
  check "deleted every burst object this run created" "$deleted" "$created"
fi

# The smoke check, which also requests each host on the others' connections (browsers coalesce HTTP/2 connections across hostnames one certificate covers).
if SUGI_SECRETS_FILE="$secrets" "$here/scripts/smoke.sh" "$base" >"$work/smoke.out" 2>&1; then pass "smoke check, including cross-host requests"; else fail "smoke check: $(grep FAIL "$work/smoke.out" | tr '\n' ';')"; fi

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
