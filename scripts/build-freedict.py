#!/usr/bin/env python3
"""Convert a FreeDict+WikDict TEI dictionary into the reader's SQLite schema.

This does NOT download or bundle dictionary data. Fetch a FreeDict source
archive yourself, e.g.:

  https://download.freedict.org/dictionaries/eng-zho/2025.11.23/
  freedict-eng-zho-2025.11.23.src.tar.xz  (contains eng-zho/eng-zho.tei)

Then:

  python3 scripts/build-freedict.py eng-zho/eng-zho.tei eng-zho.sqlite
  python3 scripts/make-dict-plugin.py --db eng-zho.sqlite \\
    --id freedict-eng-zho --name "FreeDict 英汉" \\
    --license "CC BY-SA 3.0" --license-file eng-zho/COPYING \\
    --source "FreeDict+WikDict eng-zho 2025.11.23" \\
    --out build/plugins/freedict-eng-zho.pdfplugin

FreeDict data is licensed CC BY-SA 3.0. The generated SQLite file is an
adaptation and must remain available under the same license, with attribution
to FreeDict+WikDict, Karl Bartel and Wiktionary contributors.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

NS = "{http://www.tei-c.org/ns/1.0}"
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"

SCHEMA = """
CREATE TABLE entries (
  word TEXT NOT NULL,
  phonetic TEXT,
  pos TEXT,
  translation TEXT NOT NULL,
  lemma TEXT
);
CREATE INDEX entries_word ON entries(word COLLATE NOCASE);
"""


def text_of(el: ET.Element | None) -> str:
    if el is None:
        return ""
    return " ".join("".join(el.itertext()).split())


def dedupe(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        value = value.strip()
        if not value or value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def entry_rows(entry: ET.Element) -> list[tuple[str, str, str, str]]:
    word = text_of(entry.find(f"{NS}form/{NS}orth"))
    if not word:
        return []

    phonetics = dedupe([text_of(p) for p in entry.findall(f"{NS}form/{NS}pron")])
    phonetic = " · ".join(phonetics)

    entry_pos = [text_of(p) for p in entry.findall(f"{NS}gramGrp/{NS}pos")]
    translations: list[str] = []
    for cit in entry.iter(f"{NS}cit"):
        if (cit.get("type") or "").lower() != "trans":
            continue
        lang = cit.get(XML_LANG) or ""
        if lang and not lang.lower().startswith("zh"):
            continue
        for quote in cit.findall(f"{NS}quote"):
            value = text_of(quote)
            if value:
                translations.append(value)
    translations = dedupe(translations)
    if not translations:
        return []

    pos_values = dedupe(entry_pos + [text_of(p) for p in entry.iter(f"{NS}gramGrp/{NS}pos")])
    pos = " / ".join(pos_values)
    return [(word, phonetic, pos, "；".join(translations))]


def main() -> None:
    parser = argparse.ArgumentParser(description="FreeDict TEI → PDF Viewer 词典 SQLite")
    parser.add_argument("input", type=Path, help="FreeDict .tei 文件")
    parser.add_argument("output", type=Path, help="输出 .sqlite")
    args = parser.parse_args()

    if not args.input.is_file():
        raise SystemExit(f"找不到输入文件：{args.input}")

    rows: dict[tuple[str, str], dict] = {}
    entries = 0
    skipped = 0

    for event, elem in ET.iterparse(args.input, events=("end",)):
        if elem.tag != f"{NS}entry":
            continue
        entries += 1
        produced = entry_rows(elem)
        if not produced:
            skipped += 1
        for word, phonetic, pos, translation in produced:
            key = (word.casefold(), pos)
            existing = rows.get(key)
            if existing is None:
                rows[key] = {
                    "word": word,
                    "phonetic": phonetic,
                    "pos": pos,
                    "translations": [translation],
                }
            else:
                if not existing["phonetic"] and phonetic:
                    existing["phonetic"] = phonetic
                for piece in translation.split("；"):
                    if piece and piece not in existing["translations"]:
                        existing["translations"].append(piece)
        elem.clear()

    if not rows:
        raise SystemExit("没有解析出任何词条")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        args.output.unlink()
    db = sqlite3.connect(args.output)
    try:
        db.executescript(SCHEMA)
        db.executemany(
            "INSERT INTO entries (word, phonetic, pos, translation, lemma) VALUES (?, ?, ?, ?, '')",
            [
                (row["word"], row["phonetic"], row["pos"], "；".join(row["translations"]))
                for row in rows.values()
            ],
        )
        db.commit()
    finally:
        db.close()

    print(
        f"已写入 {len(rows)} 行 / {len({w for w, _ in rows})} 个词头 "
        f"（TEI entry {entries}，跳过无中文译文 {skipped}）",
        file=sys.stderr,
    )
    print(
        "数据来源：FreeDict+WikDict，© Karl Bartel 与 Wiktionary 贡献者，CC BY-SA 3.0。"
        "生成文件属于改编数据，需以相同许可分发并署名。",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
