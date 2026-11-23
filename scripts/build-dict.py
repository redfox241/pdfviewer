#!/usr/bin/env python3
"""Build a PDF Viewer dictionary database from CSV.

The canonical input is:

    word,phonetic,pos,translation,lemma

Only word and translation are required. The output is the SQLite schema the
reader expects (see docs/PLUGINS.md). ECDICT-style CSV files are detected by
their `exchange` and `definition` columns and converted as well; pass --limit
to keep only the N most frequent entries when a frequency column is present.

You are responsible for the licence of whatever dictionary data you convert.
The repository ships no third-party dictionary data.
"""

from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from pathlib import Path

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

EXCHANGE_LABELS = {
    "p": "过去式",
    "d": "过去分词",
    "i": "现在分词",
    "3": "第三人称单数",
    "r": "比较级",
    "t": "最高级",
    "s": "复数",
}


def clean(value: str | None) -> str:
    return (value or "").strip()


def read_rows(path: Path, limit: int | None) -> tuple[list[tuple], bool]:
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames:
            raise SystemExit("CSV 没有表头")
        fields = {name.strip().lower() for name in reader.fieldnames}
        if "word" not in fields or "translation" not in fields:
            raise SystemExit("CSV 至少需要 word 和 translation 两列")
        ecdict = "exchange" in fields and "definition" in fields

        rows = list(reader)
        if limit and limit > 0:
            rank_col = "frq" if "frq" in fields else ("bnc" if "bnc" in fields else None)
            if rank_col:
                def rank(row: dict) -> int:
                    raw = clean(row.get(rank_col))
                    try:
                        value = int(float(raw))
                    except ValueError:
                        return 10**9
                    return value if value > 0 else 10**9

                rows.sort(key=rank)
            rows = rows[:limit]

        out: list[tuple[str, str, str, str, str]] = []
        seen: set[tuple[str, str]] = set()

        def add(word: str, phonetic: str, pos: str, translation: str, lemma: str) -> None:
            word = clean(word)
            translation = clean(translation).replace("\\n", "\n")
            if not word or not translation:
                return
            key = (word.casefold(), translation)
            if key in seen:
                return
            seen.add(key)
            out.append((word, clean(phonetic), clean(pos), translation, clean(lemma)))

        for row in rows:
            word = clean(row.get("word"))
            if ecdict:
                phonetic = clean(row.get("phonetic"))
                pos = clean(row.get("pos"))
                translation = clean(row.get("translation")) or clean(row.get("definition"))
                add(word, phonetic, pos, translation, "")
                exchange = clean(row.get("exchange"))
                if exchange:
                    for part in exchange.split("/"):
                        if ":" not in part:
                            continue
                        flag, form = part.split(":", 1)
                        form = clean(form)
                        if not form or form.casefold() == word.casefold():
                            continue
                        note = EXCHANGE_LABELS.get(flag)
                        label = f"（{word} 的{note}）" if note else f"（{word} 的变形）"
                        add(form, phonetic, pos, translation + "\n" + label, word)
            else:
                add(
                    word,
                    clean(row.get("phonetic")),
                    clean(row.get("pos")),
                    clean(row.get("translation")),
                    clean(row.get("lemma")),
                )
    return out, ecdict


def main() -> None:
    parser = argparse.ArgumentParser(description="把 CSV 转换为 PDF Viewer 词典 SQLite")
    parser.add_argument("input", type=Path, help="输入 CSV")
    parser.add_argument("output", type=Path, help="输出 .sqlite")
    parser.add_argument("--limit", type=int, default=0, help="只保留词频最高的 N 条（若 CSV 有 frq/bnc 列）")
    args = parser.parse_args()

    if not args.input.is_file():
        raise SystemExit(f"找不到输入文件：{args.input}")
    rows, ecdict = read_rows(args.input, args.limit)
    if not rows:
        raise SystemExit("没有可写入的词条")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        args.output.unlink()
    db = sqlite3.connect(args.output)
    try:
        db.executescript(SCHEMA)
        db.executemany("INSERT INTO entries (word, phonetic, pos, translation, lemma) VALUES (?, ?, ?, ?, ?)", rows)
        db.commit()
    finally:
        db.close()

    kind = "ECDICT" if ecdict else "CSV"
    print(f"已写入 {len(rows)} 条（{kind} → {args.output}）", file=sys.stderr)


if __name__ == "__main__":
    main()
