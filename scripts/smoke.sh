#!/usr/bin/env bash
# Light check of a live instance, cheap enough to run after every production deploy: health, the main pages, and one upload that is fetched back byte for byte and deleted with its own delete token. The full end-to-end suites run against staging.
#
# Usage: scripts/smoke.sh [BASE_URL]   (default https://sugi.moe; the trusted token comes from ~/.config/sugi/secrets.env or SUGI_SECRETS_FILE)
set -uo pipefail
base="${1:-https://sugi.moe}"
base="${base%/}"
secrets="${SUGI_SECRETS_FILE:-$HOME/.config/sugi/secrets.env}"
trusted="$(sed -n 's/^TRUSTED_TOKEN=//p' "$secrets" 2>/dev/null | head -n1)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }
code() { curl -s -o /dev/null --max-time 30 -w '%{http_code}' "$@"; }

for i in 1 2 3 4 5 6; do [ "$(code "$base/healthz")" = 200 ] && break; sleep 5; done
[ "$(code "$base/healthz")" = 200 ] && pass "/healthz" || fail "/healthz is not 200"
for p in / /faq /dev /terms /privacy; do c="$(code -H 'accept: text/html' "$base$p")"; [ "$c" = 200 ] && pass "$p" || fail "$p answered $c"; done

printf '\x89PNG\r\n\x1a\nsmoke-%s' "$(openssl rand -hex 16)" >"$work/p.png"
auth=()
[ -n "$trusted" ] && { printf 'header = "Authorization: Bearer %s"\n' "$trusted" >"$work/t.cfg"; chmod 600 "$work/t.cfg"; auth=(-K "$work/t.cfg"); }
c="$(curl -s --max-time 60 "${auth[@]}" -H 'accept: application/json' -o "$work/up.json" -w '%{http_code}' -T "$work/p.png" "$base/api/upload")"
url="$(sed -nE 's/.*"url":"([^"]+)".*/\1/p' "$work/up.json")"
id="$(sed -nE 's/.*"id":"([^"]+)".*/\1/p' "$work/up.json")"
tok="$(sed -nE 's/.*"delete_token":"([^"]+)".*/\1/p' "$work/up.json")"
[ "$c" = 201 ] && [ -n "$url" ] && pass "upload" || fail "upload answered $c"
if [ -n "$url" ]; then
  curl -s --max-time 60 -o "$work/back.png" "$url"
  cmp -s "$work/p.png" "$work/back.png" && pass "the file comes back byte for byte" || fail "the file did not come back intact"
  printf 'header = "Sugi-Token: %s"\n' "$tok" >"$work/d.cfg"
  c="$(curl -s -o /dev/null --max-time 30 -K "$work/d.cfg" -w '%{http_code}' -X DELETE "$base/api/files/$id")"
  [ "$c" = 200 ] && pass "delete" || fail "delete answered $c"
  c="$(code "$url")"
  [ "$c" = 404 ] && pass "deleted file is gone" || fail "deleted file answers $c"
fi
# Cross-host requests on one connection: browsers reuse an HTTP/2 connection for a sibling host its certificate covers, so the site, files and tmp hosts must answer for each other (an empty 403 from the edge here means the hostnames have separate certificates; see README, "Your own domain").
origins="$(curl -s --max-time 30 -H 'accept: text/html' "$base/" | sed -nE 's/.*"origins":\{"main":"([^"]*)","files":"([^"]*)","tmp":"([^"]*)"\}.*/\1 \2 \3/p')"
read -r o_main o_files o_tmp <<<"$origins"
host() { printf '%s' "$1" | sed -E 's#^https?://([^/]+).*#\1#'; }
if [ -n "$o_files" ] && [ "$(host "$o_files")" != "$(host "$o_main")" ]; then
  h_main="$(host "$o_main")"; h_files="$(host "$o_files")"; h_tmp="$(host "$o_tmp")"
  for pair in "$h_main $h_files" "$h_main $h_tmp" "$h_files $h_main" "$h_files $h_tmp" "$h_tmp $h_main" "$h_tmp $h_files"; do
    read -r sni hst <<<"$pair"
    if [ "$hst" = "$h_main" ]; then p=/healthz; want=200; else p=/zzzzzzzz.png; want=404; fi
    c="$(curl -s -o /dev/null --max-time 30 -H "Host: $hst" -w '%{http_code}' "https://$sni$p")"
    # 000 is no connection at all, which is about the network this runs on (for example a machine without working IPv6), not the site: try again, then over IPv4.
    [ "$c" = 000 ] && c="$(curl -s -o /dev/null --max-time 30 -H "Host: $hst" -w '%{http_code}' "https://$sni$p")"
    [ "$c" = 000 ] && c="$(curl -4 -s -o /dev/null --max-time 30 -H "Host: $hst" -w '%{http_code}' "https://$sni$p")"
    [ "$c" = "$want" ] && pass "Host $hst on a $sni connection" || fail "Host $hst on a $sni connection answered $c (want $want)"
  done
fi
[ "$failures" -eq 0 ] && echo "smoke: all checks passed" || echo "smoke: $failures check(s) failed"
exit $((failures > 0))
