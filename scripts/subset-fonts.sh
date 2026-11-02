#!/usr/bin/env bash
# Rebuilds the self-hosted font subsets in public/static/fonts from the upstream Google Fonts sources (SIL Open Font License).
#
# ZCOOL KuaiLe is cut down to the characters that actually appear in the page templates and the browser strings, plus printable ASCII; Fredoka is cut to Latin and common punctuation with its weight axis limited to 500-700. Re-run this after changing any user-facing text, otherwise new characters fall back to system fonts.
#
# Needs: curl, uv (runs fonttools without installing it into the project).
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
cache="${SUGI_FONT_CACHE:-$HOME/.cache/sugi-fonts}"
out="$here/public/static/fonts"
mkdir -p "$cache" "$out"

base="https://raw.githubusercontent.com/google/fonts/main/ofl"
fetch() {
  local url="$1" dest="$2"
  [ -s "$dest" ] || curl -fsSL --connect-timeout 15 --max-time 300 -o "$dest" "$url"
}
fetch "$base/zcoolkuaile/ZCOOLKuaiLe-Regular.ttf" "$cache/ZCOOLKuaiLe-Regular.ttf"
fetch "$base/zcoolkuaile/OFL.txt" "$cache/OFL-zcoolkuaile.txt"
fetch "$base/fredoka/Fredoka%5Bwdth,wght%5D.ttf" "$cache/Fredoka-VF.ttf"
fetch "$base/fredoka/OFL.txt" "$cache/OFL-fredoka.txt"

ft() { timeout 600 uvx --quiet --from 'fonttools[woff]==4.60.1' "$@"; }

# Every non-ASCII character used in templates and client strings, plus printable ASCII.
text="$cache/zcool-text.txt"
timeout 60 python3 -I - "$here" "$text" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
chars = set(chr(c) for c in range(0x20, 0x7f))
for p in list((root / "src" / "site").rglob("*.ts")) + list((root / "client").rglob("*.ts")):
    for ch in p.read_text(encoding="utf-8"):
        if ord(ch) > 0x7f:
            chars.add(ch)
pathlib.Path(sys.argv[2]).write_text("".join(sorted(chars)), encoding="utf-8")
print(f"zcool subset: {len(chars)} characters")
PY

ft pyftsubset "$cache/ZCOOLKuaiLe-Regular.ttf" --text-file="$text" --flavor=woff2 --layout-features='*' --output-file="$out/zcool-kuaile-subset.woff2"

ft fonttools varLib.instancer "$cache/Fredoka-VF.ttf" wght=500:700 wdth=100 -q -o "$cache/Fredoka-500-700.ttf"
ft pyftsubset "$cache/Fredoka-500-700.ttf" --unicodes='U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-203A,U+20AC,U+2122,U+2190-2193' --flavor=woff2 --layout-features='*' --output-file="$out/fredoka-subset.woff2"

cp "$cache/OFL-zcoolkuaile.txt" "$out/OFL-ZCOOLKuaiLe.txt"
cp "$cache/OFL-fredoka.txt" "$out/OFL-Fredoka.txt"
ls -l "$out"
