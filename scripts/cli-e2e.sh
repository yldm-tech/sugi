#!/usr/bin/env bash
# End-to-end check of install.sh and the sugi CLI against a running instance (default: local `wrangler dev`). Uses a throwaway install dir and config dir, uploads only synthetic files, and deletes everything it created.
#
# Usage: SUGI_TOKEN=<token or empty> scripts/cli-e2e.sh [BASE_URL]
set -uo pipefail

base="${1:-http://localhost:8787}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export SUGI_URL="$base" SUGI_CONFIG_DIR="$work/config" SUGI_INSTALL_DIR="$work/bin" LANG=en_US.UTF-8
failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }

png() {
  timeout 30 python3 -I - "$1" "$2" <<'EOF'
import os, struct, sys, zlib
def chunk(k, d): return struct.pack(">I", len(d)) + k + d + struct.pack(">I", zlib.crc32(k + d) & 0xFFFFFFFF)
pad = int(sys.argv[2])
raw = b"".join(b"\x00" + os.urandom(24) for _ in range(8))
extra = chunk(b"zzZZ", b"\x00" * pad) if pad else b""
open(sys.argv[1], "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0)) + chunk(b"tEXt", b"Comment\x00" + os.urandom(8).hex().encode()) + extra + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
EOF
}

curl -fsSL "$base/install.sh" | sh >"$work/install.log" 2>&1 && pass "install.sh installs the CLI" || { fail "install.sh: $(cat "$work/install.log")"; exit 1; }
sugi="$work/bin/sugi"
"$sugi" version | grep -q '^sugi ' && pass "sugi version" || fail "sugi version"

png "$work/a.png" 0
png "$work/b.png" 0
out="$("$sugi" up --no-copy "$work/a.png" "$work/b.png")" && pass "sugi up two files" || fail "sugi up: $out"
[ "$(printf '%s\n' "$out" | grep -c '→')" = 2 ] && pass "one line per file" || fail "output: $out"

out="$("$sugi" up --no-copy -e 1h --cute "$work/a.png")"
printf '%s' "$out" | grep -Eq '/(_tmp|tmp)[^ ]*/[a-z]+-[a-z]+-[0-9]{2}\.png' && pass "-e 1h --cute gives a temporary cute link" || fail "temporary cute: $out"

png "$work/c.png" 0
out="$(cat "$work/c.png" | "$sugi" up --no-copy - --name piped.png)"
printf '%s' "$out" | grep -q 'piped.png' && pass "upload from stdin with --name" || fail "stdin: $out"

json="$("$sugi" up --json "$work/a.png")"
printf '%s' "$json" | grep -q '"delete_token":"d_' && pass "--json prints the full response" || fail "--json: $json"

printf '<svg xmlns="http://www.w3.org/2000/svg"/>' >"$work/x.svg"
if "$sugi" up --no-copy "$work/x.svg" 2>"$work/err"; then fail "svg accepted"; else grep -q '415' "$work/err" && pass "svg refused with a non-zero exit" || fail "svg error: $(cat "$work/err")"; fi
if "$sugi" up --no-copy "$work/a.png" "$work/missing.png" >/dev/null 2>&1; then fail "missing file did not fail"; else pass "a missing file makes the exit code non-zero"; fi

png "$work/big.png" $((95 * 1024 * 1024))
start=$(date +%s)
out="$("$sugi" up --no-copy "$work/big.png")" && pass "95 MB file uploads in chunks ($(( $(date +%s) - start ))s)" || fail "big: $out"
big_url="$(printf '%s' "$out" | sed -nE 's/.*→  (http[^ ]+).*/\1/p')"
size="$(curl -sI "$big_url" | tr -d '\r' | sed -nE 's/^[Cc]ontent-[Ll]ength: ([0-9]+)/\1/p')"
[ "$size" = "$(wc -c <"$work/big.png" | tr -d ' ')" ] && pass "chunked file has the right size" || fail "chunked size $size"

out="$("$sugi" album --no-copy "CLI album" "$work/a.png" "$big_url")"
printf '%s' "$out" | grep -Eq '/a/[a-z0-9]{8}' && pass "sugi album uploads files and reuses links" || fail "album: $out"

n="$("$sugi" ls | wc -l | tr -d ' ')"
[ "$n" -ge 7 ] && pass "sugi ls lists $n uploads" || fail "ls lists $n"

ids="$(sed -nE 's/.*"id":"([^"]+)".*/\1/p' "$SUGI_CONFIG_DIR/history.jsonl" | sort -u)"
if "$sugi" rm $ids >/dev/null; then pass "sugi rm deletes everything this run uploaded"; else fail "sugi rm"; fi
[ ! -s "$SUGI_CONFIG_DIR/history.jsonl" ] && pass "history is empty afterwards" || fail "history not empty"
code="$(curl -s -o /dev/null -w '%{http_code}' "$big_url")"
[ "$code" = 404 ] && pass "deleted file is gone" || fail "deleted file answers $code"

if "$sugi" login not-a-token >/dev/null 2>&1; then fail "login accepted garbage"; else pass "login refuses a malformed token"; fi
[ "$(stat -c '%a' "$SUGI_CONFIG_DIR" 2>/dev/null || stat -f '%Lp' "$SUGI_CONFIG_DIR")" = 700 ] && pass "config dir is private" || fail "config dir permissions"

[ "$failures" -eq 0 ] && echo "all checks passed" || { echo "$failures check(s) failed"; exit 1; }
