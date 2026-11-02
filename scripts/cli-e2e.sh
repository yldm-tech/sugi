#!/usr/bin/env bash
# End-to-end check of install.sh and the sugi CLI against a running instance (default: the staging Worker). Uses a throwaway install dir and config dir, uploads only synthetic files, and deletes everything it created.
#
# Usage: SUGI_TOKEN=<token or empty> scripts/cli-e2e.sh [BASE_URL]
#
# BASE_URL defaults to the staging Worker (https://sugi-staging.evan-e2b.workers.dev); there, without SUGI_TOKEN, the trusted token from ~/.config/sugi/staging.env is used.
set -uo pipefail

staging="https://sugi-staging.evan-e2b.workers.dev"
base="${1:-$staging}"
if [ "$base" = "$staging" ] && [ -z "${SUGI_TOKEN+x}" ] && [ -r "$HOME/.config/sugi/staging.env" ]; then
  SUGI_TOKEN="$(sed -n 's/^TRUSTED_TOKEN=//p' "$HOME/.config/sugi/staging.env")"
  export SUGI_TOKEN
fi
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

plain="$("$sugi" up --plain --no-copy "$work/a.png" 2>/dev/null)"
printf '%s\n' "$plain" | grep -Eqx 'https?://[^ ]+\.png' && [ "$(printf '%s\n' "$plain" | wc -l | tr -d ' ')" = 1 ] && pass "--plain prints only the link (Typora)" || fail "--plain: $plain"

printf '<svg xmlns="http://www.w3.org/2000/svg"/>' >"$work/x.svg"
if "$sugi" up --no-copy "$work/x.svg" 2>"$work/err"; then fail "svg accepted"; else grep -q '415' "$work/err" && pass "svg refused with a non-zero exit" || fail "svg error: $(cat "$work/err")"; fi
if "$sugi" up --no-copy "$work/a.png" "$work/missing.png" >/dev/null 2>&1; then fail "missing file did not fail"; else pass "a missing file makes the exit code non-zero"; fi

png "$work/big.png" $((95 * 1024 * 1024))
start=$(date +%s)
# Interrupt the chunked upload after its first part (curl slowed down by a throwaway .curlrc so there is time), then run the same command again: it must continue, not start over.
mkdir -p "$work/slow"
printf 'limit-rate = 15M\n' >"$work/slow/.curlrc"
CURL_HOME="$work/slow" "$sugi" up --no-copy "$work/big.png" >"$work/int.out" 2>"$work/int.err" &
pid=$!
for _ in $(seq 1 300); do compgen -G "$SUGI_CONFIG_DIR/pending/*" >/dev/null && break; sleep 0.2; done
sleep 1
kill -TERM "$pid" 2>/dev/null
wait "$pid"
code=$?
[ "$code" = 130 ] && grep -q 'continue' "$work/int.err" && compgen -G "$SUGI_CONFIG_DIR/pending/*" >/dev/null && pass "an interrupted chunked upload keeps its progress" || fail "interrupt: exit $code, $(cat "$work/int.err")"
out="$("$sugi" up --no-copy "$work/big.png" 2>"$work/resume.err")" && grep -q 'resuming: 1 of 2' "$work/resume.err" && pass "95 MB file resumes and finishes ($(( $(date +%s) - start ))s)" || fail "big: $out $(cat "$work/resume.err")"
compgen -G "$SUGI_CONFIG_DIR/pending/*" >/dev/null && fail "progress file left after finishing" || pass "progress file removed after finishing"
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
# `sugi rm` only deletes files; albums are deleted with the delete token the CLI saved.
while IFS= read -r line; do
  aid="$(printf '%s' "$line" | sed -nE 's/.*"id":"([a-z0-9]{8})".*/\1/p')"
  atok="$(printf '%s' "$line" | sed -nE 's/.*"delete_token":"([^"]+)".*/\1/p')"
  [ -n "$aid" ] || continue
  code="$(printf 'header = "Sugi-Token: %s"\n' "$atok" | curl -s -K - -o /dev/null -w '%{http_code}' -X DELETE "$base/api/albums/$aid")"
  [ "$code" = 200 ] && pass "album $aid deleted" || fail "album $aid delete answered $code"
done <"$SUGI_CONFIG_DIR/albums.jsonl"
code="$(curl -s -o /dev/null -w '%{http_code}' "$big_url")"
[ "$code" = 404 ] && pass "deleted file is gone" || fail "deleted file answers $code"

if "$sugi" login not-a-token >/dev/null 2>&1; then fail "login accepted garbage"; else pass "login refuses a malformed token"; fi
[ "$(stat -c '%a' "$SUGI_CONFIG_DIR" 2>/dev/null || stat -f '%Lp' "$SUGI_CONFIG_DIR")" = 700 ] && pass "config dir is private" || fail "config dir permissions"

[ "$failures" -eq 0 ] && echo "all checks passed" || { echo "$failures check(s) failed"; exit 1; }
