#!/bin/sh
# Puts the fast-agent bridge (python/fast-agent) and the Python bridge SDK (python/src/kedi_bridge)
# into the package source, as the release workflow does: `kedi install package.kedi` then
# installs a working package from this checkout.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
source="$here/src/fast_agent"
for module in bridge convert; do
  cp "$root/python/fast-agent/$module.py" "$source/$module.py"
done
rm -rf "$source/kedi_bridge"
cp -R "$root/python/src/kedi_bridge" "$source/kedi_bridge"
find "$source" -name __pycache__ -prune -exec rm -rf {} +
