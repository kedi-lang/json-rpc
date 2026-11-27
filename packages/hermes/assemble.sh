#!/bin/sh
# Puts the Hermes bridge (python/hermes) and the Python bridge SDK (python/src/kedi_bridge) into
# the package source, as the release workflow does: `kedi install package.kedi` then installs a
# working package from this checkout.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
source="$here/src/hermes"
for module in bridge convert gate home; do
  cp "$root/python/hermes/$module.py" "$source/$module.py"
done
rm -rf "$source/kedi_bridge"
cp -R "$root/python/src/kedi_bridge" "$source/kedi_bridge"
find "$source" -name __pycache__ -prune -exec rm -rf {} +
