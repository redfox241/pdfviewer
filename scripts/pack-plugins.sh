#!/usr/bin/env bash
# Pack every plugins/<id>/ directory into build/plugins/<id>.pdfplugin.
# Dictionary sources with entries.csv are converted to dict.sqlite first.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/plugins"
out="$root/build/plugins"
mkdir -p "$out"

if ! command -v zip >/dev/null 2>&1; then
  echo "需要 zip 命令" >&2
  exit 1
fi

generated=()
shopt -s nullglob
for dir in "$src"/*/; do
  id="$(basename "$dir")"
  manifest="$dir/manifest.json"
  [ -f "$manifest" ] || continue
  if [ -f "$dir/entries.csv" ]; then
    if ! command -v python3 >/dev/null 2>&1; then
      echo "构建词典插件需要 python3" >&2
      exit 1
    fi
    python3 "$root/scripts/build-dict.py" "$dir/entries.csv" "$dir/dict.sqlite"
    generated+=("$dir/dict.sqlite")
  fi
  tmp="$(mktemp -d)"
  cp -R "$dir"/. "$tmp"/
  rm -f "$tmp/entries.csv"
  find "$tmp" -name .DS_Store -delete
  (cd "$tmp" && zip -q -r -X "$out/$id.pdfplugin" .)
  rm -rf "$tmp"
  echo "已生成 build/plugins/$id.pdfplugin"
done

# Remove only the databases this script generated.
if [ ${#generated[@]} -gt 0 ]; then
  rm -f "${generated[@]}"
fi
