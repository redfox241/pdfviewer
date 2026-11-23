#!/usr/bin/env python3
"""Download the Fluency ECDICT SQLite archive in parallel ranges.

The public mirror is slow per connection, so this splits the ~54 MB zip into
1 MB ranges and fetches them with a small thread pool. It is a build helper,
not part of the app.
"""
from __future__ import annotations

import concurrent.futures
import os
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

URL = ("https://hf-mirror.com/datasets/iamzhangship/fluency-ecdict-offline/"
       "resolve/main/ecdict-ecdict-bc015ed2-focus13-v2.zip")
TOTAL = 54_594_964
CHUNK = 1_000_000
WORKERS = 16
OUT = Path("/tmp/ecdict-v2.zip")
PARTS = Path("/tmp/ecdict-parts")


def fetch(idx: int, start: int, end: int) -> tuple[int, int]:
    target = PARTS / f"{idx:03d}"
    want = end - start + 1
    if target.exists() and target.stat().st_size == want:
        return idx, want
    last: Exception | None = None
    for attempt in range(6):
        try:
            req = urllib.request.Request(
                URL,
                headers={
                    "Range": f"bytes={start}-{end}",
                    "User-Agent": "Mozilla/5.0 pdfviewer-build/1.0",
                    "Accept-Encoding": "identity",
                },
            )
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = resp.read()
            if len(data) != want:
                raise RuntimeError(f"short range {idx}: {len(data)} != {want}")
            tmp = target.with_suffix(".tmp")
            tmp.write_bytes(data)
            tmp.replace(target)
            return idx, len(data)
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"chunk {idx} failed: {last}")


def main() -> None:
    PARTS.mkdir(parents=True, exist_ok=True)
    jobs = []
    idx = 0
    for start in range(0, TOTAL, CHUNK):
        end = min(TOTAL - 1, start + CHUNK - 1)
        jobs.append((idx, start, end))
        idx += 1

    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(fetch, *job) for job in jobs]
        for fut in concurrent.futures.as_completed(futures):
            _, size = fut.result()
            done += size
            print(f"{done / TOTAL * 100:6.1f}%  {done / 1024 / 1024:.1f} MB", flush=True)

    if OUT.exists():
        OUT.unlink()
    with OUT.open("wb") as out:
        for i, _ in enumerate(jobs):
            out.write((PARTS / f"{i:03d}").read_bytes())
    if OUT.stat().st_size != TOTAL:
        raise SystemExit(f"size mismatch: {OUT.stat().st_size} != {TOTAL}")
    with zipfile.ZipFile(OUT) as zf:
        names = zf.namelist()
        if not any(name.endswith(".db") or name.endswith(".sqlite") for name in names):
            raise SystemExit(f"no sqlite database in {names[:8]}")
        print("zip ok:", names, flush=True)


if __name__ == "__main__":
    main()
