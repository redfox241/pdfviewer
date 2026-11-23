#!/usr/bin/env python3
"""Wrap a dictionary SQLite file into an installable .pdfplugin.

Example:
    python3 scripts/make-dict-plugin.py \\
      --db ecdict-50k.sqlite --id ecdict-50k --name "ECDICT 5 万词" \\
      --out build/plugins/ecdict-50k.pdfplugin

The dictionary data is NOT bundled with this repository. You are responsible
for the licence of the data you package. When packaging CC BY-SA data, pass
--license, --license-file, --source and --out; the generated zip contains a
LICENSE and NOTICE so the share-alike/attribution terms travel with the data.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import zipfile
from pathlib import Path

ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
VERSION_RE = re.compile(r"^[0-9]+(\.[0-9]+){0,3}([-+][0-9A-Za-z.-]+)?$")


def main() -> None:
    parser = argparse.ArgumentParser(description="把 SQLite 词典打包为 .pdfplugin")
    parser.add_argument("--db", required=True, type=Path, help="词典 SQLite 文件")
    parser.add_argument("--id", required=True, help="插件 id，例如 ecdict-50k")
    parser.add_argument("--name", required=True, help="显示名称")
    parser.add_argument("--out", required=True, type=Path, help="输出 .pdfplugin")
    parser.add_argument("--version", default="1.0.0")
    parser.add_argument("--description", default="离线英汉词典")
    parser.add_argument("--author", default="")
    parser.add_argument("--homepage", default="")
    parser.add_argument("--source", default="", help="数据来源与版本，写入 manifest/NOTICE")
    parser.add_argument("--license", default="", help="数据许可，例如 CC BY-SA 3.0")
    parser.add_argument("--license-file", type=Path, help="随包附带完整许可文本")
    parser.add_argument("--notice", default="", help="额外署名或修改说明")
    args = parser.parse_args()

    if not ID_RE.match(args.id):
        raise SystemExit("id 只能包含小写字母、数字、点、下划线和短横线（≤64 字符）")
    if not VERSION_RE.match(args.version):
        raise SystemExit("version 需为 1.2.3 形式")
    if not args.db.is_file():
        raise SystemExit(f"找不到词典文件：{args.db}")
    if args.license_file and not args.license_file.is_file():
        raise SystemExit(f"找不到许可文件：{args.license_file}")

    db = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    try:
        cols = {row[1].lower() for row in db.execute("PRAGMA table_info(entries)")}
        if "word" not in cols or "translation" not in cols:
            raise SystemExit("词典需要一个 entries 表，且至少包含 word 与 translation 列")
        count = db.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
    finally:
        db.close()
    if count == 0:
        raise SystemExit("词典没有词条")

    manifest = {
        "id": args.id,
        "name": args.name,
        "version": args.version,
        "kind": "dictionary",
        "description": args.description,
        "author": args.author,
        "homepage": args.homepage,
        "data": "dict.sqlite",
    }
    if args.source:
        manifest["source"] = args.source
    if args.license:
        manifest["license"] = args.license

    notice_lines = [
        args.name,
        "",
        f"Data source: {args.source}" if args.source else "",
        f"License: {args.license}" if args.license else "",
        "",
        "This data file is a modified/derived work: it was converted from the",
        "source format, entries were grouped by headword and part of speech,",
        "fields were reduced, and the result was packaged as SQLite for PDF",
        "Viewer. The data file remains available in this plugin directory.",
        "",
        args.notice,
        "",
    ]
    notice = "\n".join(line for line in notice_lines if line is not None)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        zf.write(args.db, "dict.sqlite")
        if args.license or args.notice:
            zf.writestr("NOTICE", notice)
        if args.license_file:
            zf.write(args.license_file, "LICENSE")
    size_mb = args.out.stat().st_size / 1024 / 1024
    print(f"已生成 {args.out}（{count} 条，{size_mb:.1f} MB）", file=sys.stderr)


if __name__ == "__main__":
    main()
