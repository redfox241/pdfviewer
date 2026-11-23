#!/usr/bin/env bash
# Build the recommended high-accuracy offline dictionary from ECDICT.
#
# The download is ~54 MB and may take several minutes; the resulting plugin
# contains an ECDICT-derived SQLite database under the MIT licence.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

db_path=""
work="/tmp/ecdict-v2"
zip="/tmp/ecdict-v2.zip"

if [ ! -f "$zip" ]; then
  python3 scripts/download-ecdict-pack.py
fi

expected="1e745ea698878772226a7df584129409dd4b27cb7ea26b4259bc770e7533352f"
actual="$(shasum -a 256 "$zip" | awk '{print $1}')"
if [ "$actual" != "$expected" ]; then
  echo "ECDICT 包校验失败：$actual" >&2
  echo "删除 $zip 后重试" >&2
  exit 1
fi

rm -rf "$work"
mkdir -p "$work"
unzip -q "$zip" -d "$work"
db_path="$(find "$work" -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) | head -n 1)"
if [ -z "$db_path" ]; then
  echo "压缩包里没有找到 SQLite 数据库" >&2
  exit 1
fi

mkdir -p build/plugins
python3 scripts/build-ecdict.py "$db_path" build/ecdict-essential.sqlite --limit 60000

if [ ! -f build/ECDICT-LICENSE ]; then
  curl -fsSL --max-time 30 -o build/ECDICT-LICENSE \
    https://raw.githubusercontent.com/skywind3000/ECDICT/master/LICENSE
fi

python3 scripts/make-dict-plugin.py \
  --db build/ecdict-essential.sqlite \
  --id ecdict-essential \
  --name "ECDICT 精简英汉词典" \
  --version "1.0.0" \
  --description "按词频筛选的 ECDICT 英汉词典，含音标、词性、多义项和常见变形；比 FreeDict 更准确，体积也更大。" \
  --source "ECDICT bc015ed2 (Fluency offline pack)" \
  --license "MIT" \
  --license-file build/ECDICT-LICENSE \
  --notice "Copyright (c) 2025 Linwei. Trimmed by frequency, grouped by part of speech, inflected forms added from the exchange field." \
  --out build/plugins/ecdict-essential.pdfplugin

echo "已生成 build/plugins/ecdict-essential.pdfplugin"
