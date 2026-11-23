#!/usr/bin/env python3
"""Build a high-quality offline dictionary from ECDICT.

Input may be ECDICT's ecdict.csv or the stardict.db SQLite database shipped by
ECDICT/derivatives. Unlike the FreeDict converter, this parses the Chinese
translation block into part-of-speech groups and adds inflected forms through
ECDICT's exchange field.

ECDICT is MIT-licensed; include its LICENSE and attribution in the package.
The repository does not ship the data.
"""

from __future__ import annotations

import argparse
import csv
import re
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

POS_MAP = {
    "n.": "n.", "n": "n.",
    "v.": "v.", "vt.": "v.", "vi.": "v.", "v": "v.",
    "adj.": "adj.", "a.": "adj.", "adj": "adj.",
    "adv.": "adv.", "ad.": "adv.", "adv": "adv.",
    "prep.": "prep.", "prep": "prep.",
    "conj.": "conj.", "conj": "conj.",
    "pron.": "pron.", "pron": "pron.",
    "num.": "num.", "num": "num.",
    "art.": "art.", "art": "art.",
    "aux.": "aux.", "aux": "aux.",
    "int.": "int.", "interj.": "int.", "int": "int.",
    "abbr.": "abbr.", "abbr": "abbr.",
    "prefix": "prefix", "suffix": "suffix",
}

POS_RE = re.compile(r"^\s*([A-Za-z]+\.)\s*(.+)$")
EXCHANGE_RE = re.compile(r"([a-z0-9]):([^/]+)")
EXAM_TAGS = {"zk", "gk", "cet4", "cet6", "ky", "toefl", "ielts", "gre"}
CJK_RE = re.compile(r"[\u3400-\u9fff]")
CROSSREF_RE = re.compile(r"的(过去式|过去分词|现在分词|第三人称单数|复数|比较级|最高级)")


def clean_text(value) -> str:
    if value is None:
        return ""
    return str(value).replace("\\n", "\n").strip()


def parse_translation(raw: str) -> list[tuple[str, str]]:
    """Return (pos, sense) pairs, grouped and deduplicated."""
    lines = [line.strip() for line in clean_text(raw).splitlines() if line.strip()]
    parsed: list[tuple[str, str]] = []
    for line in lines:
        if line.startswith("[网络]") or line.startswith("[網絡]"):
            continue
        # Drop leading domain markers such as [医] but keep the sense.
        line = re.sub(r"^\[[^\]]{1,12}\]\s*", "", line)
        line = line.strip()
        if not line:
            continue
        match = POS_RE.match(line)
        if match:
            pos = POS_MAP.get(match.group(1).lower(), "")
            sense = match.group(2).strip()
        else:
            pos = ""
            sense = line
        if not sense:
            continue
        sense = re.sub(r"\s+", " ", sense).strip(" ;；")
        if sense and CJK_RE.search(sense):
            parsed.append((pos, sense))
    if not parsed:
        return []

    # ECDICT sometimes adds a bare "X 的过去式/复数" line to a base word.
    # It is useful for an inflected headword but noise when the base word
    # already has real POS-tagged senses.
    has_pos = any(pos for pos, _ in parsed)
    if has_pos:
        parsed = [(pos, sense) for pos, sense in parsed if pos or not CROSSREF_RE.search(sense)]
    if not parsed:
        return []

    grouped: dict[str, list[str]] = {}
    for pos, sense in parsed:
        bucket = grouped.setdefault(pos, [])
        if sense not in bucket:
            bucket.append(sense)
    out: list[tuple[str, str]] = []
    for pos, senses in grouped.items():
        text = "；".join(senses)
        if len(text) > 900:
            text = text[:900].rstrip("；") + "…"
        out.append((pos, text))
    return out


def parse_exchange(raw: str) -> tuple[str, list[str]]:
    lemma = ""
    forms: list[str] = []
    for flag, value in EXCHANGE_RE.findall(clean_text(raw)):
        value = value.strip()
        if not value:
            continue
        if flag == "0":
            lemma = value
        elif flag in {"p", "d", "i", "3", "s", "r", "t"} and value not in forms:
            forms.append(value)
    return lemma, forms


def rank_of(frq: int, bnc: int) -> int:
    values = [v for v in (frq, bnc) if v and v > 0]
    return min(values) if values else 10**9


def read_csv(path: Path, limit: int):
    rows: list[tuple[int, str, dict]] = []
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            word = clean_text(row.get("word")).strip()
            if not word:
                continue
            try:
                frq = int(float(clean_text(row.get("frq")) or 0))
                bnc = int(float(clean_text(row.get("bnc")) or 0))
            except ValueError:
                frq = bnc = 0
            tags = set(clean_text(row.get("tag")).lower().split())
            if not (frq or bnc or tags & EXAM_TAGS):
                continue
            rows.append((rank_of(frq, bnc), word, row))
    rows.sort(key=lambda item: item[0])
    return [row for _, _, row in rows[:limit]]


def read_sqlite(path: Path, limit: int):
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        table = "stardict" if "stardict" in names else "entries" if "entries" in names else ""
        if not table:
            raise SystemExit(f"看不到 stardict/entries 表：{sorted(names)}")
        cols = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
        if not {"word", "translation"} <= cols:
            raise SystemExit(f"{table} 缺少 word/translation 列：{sorted(cols)}")
        rank_expr = "MIN(CASE WHEN frq>0 THEN frq ELSE 1000000000 END, CASE WHEN bnc>0 THEN bnc ELSE 1000000000 END)"
        tag_expr = "COALESCE(tag, '')" if "tag" in cols else "''"
        select_cols = ["word", "phonetic", "translation", "pos", "tag", "exchange", "frq", "bnc"]
        select_cols = [c for c in select_cols if c in cols or c in {"word", "translation"}]
        query = (
            f"SELECT {', '.join(select_cols)} FROM {table} "
            f"WHERE (frq > 0 OR bnc > 0 OR {tag_expr} != '') "
            f"ORDER BY {rank_expr} LIMIT ?"
        )
        rows = []
        for row in db.execute(query, (limit,)):
            item = dict(row)
            item["_tags"] = item.get("tag", "")
            rows.append(item)
        return rows
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="ECDICT → PDF Viewer 离线词典 SQLite")
    parser.add_argument("input", type=Path, help="ecdict.csv 或 stardict.db")
    parser.add_argument("output", type=Path, help="输出 .sqlite")
    parser.add_argument("--limit", type=int, default=60000, help="按词频保留的词条上限")
    args = parser.parse_args()

    if not args.input.is_file():
        raise SystemExit(f"找不到输入文件：{args.input}")
    rows = read_sqlite(args.input, args.limit) if args.input.suffix.lower() in {".db", ".sqlite", ".sqlite3"} else read_csv(args.input, args.limit)
    if not rows:
        raise SystemExit("没有可写入的词条")

    output_rows: dict[tuple[str, str], dict] = {}
    derived: list[tuple[str, str, str, str]] = []
    skipped = 0
    for row in rows:
        word = clean_text(row.get("word")).strip()
        phonetic = clean_text(row.get("phonetic")).strip()
        parsed = parse_translation(clean_text(row.get("translation")))
        if not parsed:
            skipped += 1
            continue
        lemma, forms = parse_exchange(clean_text(row.get("exchange")))
        if not lemma:
            lemma = word
        for pos, translation in parsed:
            key = (word, pos)
            current = output_rows.get(key)
            if current:
                if translation not in current["translations"]:
                    current["translations"].append(translation)
            else:
                output_rows[key] = {
                    "word": word,
                    "phonetic": phonetic,
                    "pos": pos,
                    "translations": [translation],
                    "lemma": lemma if lemma.casefold() != word.casefold() else "",
                }
        for form in forms:
            form = form.strip()
            if not form or form.casefold() == word.casefold():
                continue
            derived.append((form, phonetic, "；".join(t for _, t in parsed), word))

    # Inflected forms point at the base entry. Do not invent a pronunciation
    # for them: a base-word phonetic is often wrong for an irregular form.
    base_words = {w.casefold() for w, _ in output_rows}
    seen_forms = set(base_words)
    for form, _phonetic, translation, lemma in derived:
        key = form.casefold()
        if key in seen_forms:
            continue
        seen_forms.add(key)
        output_rows[(form, "")] = {
            "word": form,
            "phonetic": "",
            "pos": "",
            "translations": [translation],
            "lemma": lemma,
        }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        args.output.unlink()
    db = sqlite3.connect(args.output)
    try:
        db.executescript(SCHEMA)
        db.executemany(
            "INSERT INTO entries (word, phonetic, pos, translation, lemma) VALUES (?, ?, ?, ?, ?)",
            [
                (item["word"], item["phonetic"], item["pos"], "；".join(item["translations"]), item.get("lemma", ""))
                for item in output_rows.values()
            ],
        )
        db.commit()
        count = db.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
    finally:
        db.close()

    print(
        f"已写入 {count} 行 / {len({w for w, _ in output_rows})} 个词头；"
        f"源词条 {len(rows)}，无中文释义跳过 {skipped}",
        file=sys.stderr,
    )
    print("数据来源：ECDICT（MIT），请随包附带 LICENSE 与署名。", file=sys.stderr)


if __name__ == "__main__":
    main()
