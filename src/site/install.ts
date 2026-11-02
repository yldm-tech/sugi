import { ASSETS } from "../generated/assets";

// POSIX sh installer for the sugi CLI, served at /install.sh. It downloads the script from the same origin and refuses it unless the SHA-256 matches the one baked in at build time. The published CLI defaults to https://sugi.moe; for any other server the installer rewrites that one default line after the checksum check, so the installed command talks to the server it came from.
export function installScript(env: Env): string {
  return `#!/bin/sh
# Installs the sugi command-line tool (${ASSETS.cliVersion}) from ${env.MAIN_ORIGIN}.
#   curl -fsSL ${env.MAIN_ORIGIN}/install.sh | sh
# Set SUGI_INSTALL_DIR to choose where it goes (default: ~/.local/bin).
set -eu

origin="\${SUGI_URL:-${env.MAIN_ORIGIN}}"
dir="\${SUGI_INSTALL_DIR:-\$HOME/.local/bin}"
expected="${ASSETS.cliSha256}"

command -v curl >/dev/null 2>&1 || { echo "sugi: curl is required" >&2; exit 1; }
command -v bash >/dev/null 2>&1 || { echo "sugi: bash is required" >&2; exit 1; }

tmp="\$(mktemp "\${TMPDIR:-/tmp}/sugi-install.XXXXXX")"
trap 'rm -f "\$tmp" "\$tmp.base"' EXIT INT TERM
curl -fsSL --connect-timeout 15 --max-time 120 -o "\$tmp" "\$origin${ASSETS.cli}"

if command -v sha256sum >/dev/null 2>&1; then actual="\$(sha256sum "\$tmp" | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then actual="\$(shasum -a 256 "\$tmp" | cut -d' ' -f1)"
else echo "sugi: need sha256sum or shasum to verify the download" >&2; exit 1
fi
if [ "\$actual" != "\$expected" ]; then
  echo "sugi: checksum mismatch (got \$actual, expected \$expected); not installing" >&2
  exit 1
fi

if [ "\$origin" != "https://sugi.moe" ]; then
  awk -v o="\$origin" '\$0 == "BASE=\\"\${SUGI_URL:-https://sugi.moe}\\"" { print "BASE=\\"\${SUGI_URL:-" o "}\\""; next } { print }' "\$tmp" >"\$tmp.base"
  mv "\$tmp.base" "\$tmp"
fi

mkdir -p "\$dir"
cp "\$tmp" "\$dir/sugi"
chmod 755 "\$dir/sugi"
echo "✿ sugi ${ASSETS.cliVersion} installed to \$dir/sugi"
case ":\$PATH:" in
  *":\$dir:"*) ;;
  *) echo "  add it to your PATH, e.g.: echo 'export PATH=\\"\$dir:\\$PATH\\"' >> ~/.profile" ;;
esac
echo "  try: sugi up picture.png"
`;
}
