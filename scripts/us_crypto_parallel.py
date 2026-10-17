#!/usr/bin/env python3
"""
Parallel US cryptocurrency Maps harvest → email-only CSV.

Scrapes the cryptocurrency category across every US geo tile, merges shards,
enriches websites for emails, and writes a dedicated CSV (never commit data/).
"""
from __future__ import annotations

import json
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG_DIR = Path("/tmp/google-maps-scraper-pipeline/us-crypto")
COUNTRY = "us"
CATEGORY = "cryptocurrency"

MAX_PER_TILE = "30"
MAX_PLACES = "50"
ENRICH_CONCURRENCY = "8"
MAX_PARALLEL_SCRAPES = 12

# Single Maps query keeps per-tile runtime short while covering the niche.
QUERY = "cryptocurrency"


def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] {msg}"
    print(line, flush=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with (LOG_DIR / "runner.log").open("a") as f:
        f.write(line + "\n")


def run_cmd(cmd: list[str], log_name: str) -> int:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    path = LOG_DIR / log_name
    log(f"$ {' '.join(cmd)}")
    with path.open("a") as lf:
        lf.write(f"\n=== {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} ===\n")
        lf.write(f"$ {' '.join(cmd)}\n")
        lf.flush()
        proc = subprocess.Popen(
            cmd,
            cwd=str(ROOT),
            stdout=lf,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env={
                **os.environ,
                "NODE_OPTIONS": "--max-old-space-size=512",
                "FAST_SCRAPE": "1",
            },
        )
        ec = proc.wait()
        log(f"exit={ec} log={path.name}")
        return ec


def cat_dir(slug: str) -> Path:
    return ROOT / "data" / COUNTRY / slug


def list_tile_ids() -> list[str]:
    out = subprocess.check_output(
        [
            "npx",
            "tsx",
            "-e",
            "import { usCountry } from './src/countries/us.ts'; "
            "console.log(usCountry.tiles.map(t => t.id).join('\\n'))",
        ],
        cwd=str(ROOT),
        text=True,
    )
    return [line.strip() for line in out.splitlines() if line.strip()]


def shard_slug(tile_id: str) -> str:
    return f"{CATEGORY}__shard_{tile_id}".lower()


def clear_locks(slug: str) -> None:
    d = cat_dir(slug)
    for name in (".scrape_lock", ".enrich_lock"):
        lock = d / name
        if lock.exists():
            lock.unlink()


def places_count(slug: str = CATEGORY) -> int:
    p = cat_dir(slug) / "places.jsonl"
    if not p.exists():
        return 0
    return sum(1 for line in p.read_text().splitlines() if line.strip())


def email_count(slug: str = CATEGORY) -> int:
    p = cat_dir(slug) / "places.jsonl"
    if not p.exists():
        return 0
    n = 0
    for line in p.read_text().splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (row.get("email") or "").strip():
            n += 1
    return n


def scrape_shard(tile_id: str) -> tuple[str, int]:
    data_slug = shard_slug(tile_id)
    clear_locks(data_slug)
    shard = cat_dir(data_slug)
    for name in ("progress.json", ".scrape_lock", ".enrich_lock"):
        p = shard / name
        if p.exists():
            p.unlink()
    ec = run_cmd(
        [
            "npx",
            "tsx",
            "src/geo_harvest.ts",
            "--country",
            COUNTRY,
            "--category",
            CATEGORY,
            "--data-slug",
            data_slug,
            "--tiles",
            tile_id,
            "--query",
            QUERY,
            "--max-places",
            MAX_PLACES,
            "--max-per-tile",
            MAX_PER_TILE,
        ],
        f"{data_slug}-scrape.log",
    )
    return tile_id, ec


def merge_shards() -> int:
    dest = cat_dir(CATEGORY)
    dest.mkdir(parents=True, exist_ok=True)
    places_path = dest / "places.jsonl"
    by_id: dict[str, dict] = {}
    if places_path.exists():
        for line in places_path.read_text().splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            pid = row.get("place_id")
            if pid:
                by_id[pid] = row
    before = len(by_id)
    for shard_path in (ROOT / "data" / COUNTRY).glob(f"{CATEGORY}__shard_*/places.jsonl"):
        for line in shard_path.read_text().splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            pid = row.get("place_id")
            if not pid:
                continue
            row["category"] = CATEGORY
            prev = by_id.get(pid)
            if not prev:
                by_id[pid] = row
                continue
            if (row.get("email") or "") and not (prev.get("email") or ""):
                by_id[pid] = row
            elif row.get("enriched_at") and not prev.get("enriched_at"):
                by_id[pid] = {**prev, **{k: v for k, v in row.items() if v}}
    places_path.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in by_id.values())
    )
    log(f"[merge] {CATEGORY}: {len(by_id)} unique places (+{len(by_id) - before} from shards)")
    return len(by_id)


def enrich() -> int:
    clear_locks(CATEGORY)
    return run_cmd(
        [
            "npm",
            "run",
            "enrich",
            "--",
            "--country",
            COUNTRY,
            "--category",
            CATEGORY,
            "--concurrency",
            ENRICH_CONCURRENCY,
        ],
        f"{CATEGORY}-enrich.log",
    )


def export_leads() -> int:
    return run_cmd(
        [
            "npm",
            "run",
            "export",
            "--",
            "--country",
            COUNTRY,
            "--category",
            CATEGORY,
        ],
        f"{CATEGORY}-export.log",
    )


def write_separate_csv() -> Path:
    """Dedicated US cryptocurrency email CSV (rows without email skipped)."""
    out = ROOT / "data" / COUNTRY / "us_cryptocurrency_emails.csv"
    places = cat_dir(CATEGORY) / "places.jsonl"
    rows: list[dict] = []
    seen: set[str] = set()
    junk = (
        "example.com",
        "example@",
        "sentry.",
        "wixpress",
        "domain.com",
        "email.com",
        "your@",
        "name@",
    )
    if places.exists():
        for line in places.read_text().splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            email = (row.get("email") or "").strip().lower()
            if not email or "@" not in email or email in seen:
                continue
            if any(j in email for j in junk):
                continue
            seen.add(email)
            rows.append(
                {
                    "name": row.get("name") or "",
                    "email": row.get("email") or "",
                    "website": row.get("website") or "",
                    "address": row.get("address") or "",
                    "city": row.get("city") or "",
                    "state": row.get("state") or "",
                    "country": row.get("country") or "us",
                    "category": CATEGORY,
                }
            )

    headers = [
        "name",
        "email",
        "website",
        "address",
        "city",
        "state",
        "country",
        "category",
    ]

    def esc(v: str) -> str:
        v = str(v)
        if any(c in v for c in [",", '"', "\n"]):
            return '"' + v.replace('"', '""') + '"'
        return v

    body = (
        ",".join(headers)
        + "\n"
        + "\n".join(",".join(esc(r[h]) for h in headers) for r in rows)
        + ("\n" if rows else "")
    )
    out.write_text(body)
    art = Path("/opt/cursor/artifacts")
    art.mkdir(parents=True, exist_ok=True)
    (art / "us_cryptocurrency_emails.csv").write_text(body)
    log(f"[csv] {len(rows)} unique emails → {out}")
    return out


def main() -> int:
    started = time.time()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    tiles = list_tile_ids()
    log(f"US cryptocurrency parallel start tiles={len(tiles)} query={QUERY!r}")

    log("=== PHASE 1: parallel tile scrapes ===")
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_SCRAPES) as pool:
        futs = {pool.submit(scrape_shard, t): t for t in tiles}
        done = 0
        for fut in as_completed(futs):
            t = futs[fut]
            done += 1
            try:
                _, ec = fut.result()
                log(f"[scrape] {done}/{len(tiles)} {t} exit={ec}")
            except Exception as e:
                log(f"[scrape] {done}/{len(tiles)} {t} error={e}")

    log("=== PHASE 2: merge shards ===")
    merge_shards()

    log("=== PHASE 3: enrich ===")
    enrich()
    log(f"[enrich] places={places_count()} emails={email_count()}")

    log("=== PHASE 4: export email-only + separate CSV ===")
    export_leads()
    csv_path = write_separate_csv()

    elapsed = time.time() - started
    summary = {
        "elapsed_sec": round(elapsed),
        "tiles": len(tiles),
        "places": places_count(),
        "emails": email_count(),
        "csv": str(csv_path),
        "artifact": "/opt/cursor/artifacts/us_cryptocurrency_emails.csv",
    }
    (LOG_DIR / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    Path("/opt/cursor/artifacts/us_cryptocurrency_summary.json").write_text(
        json.dumps(summary, indent=2) + "\n"
    )
    log(f"DONE in {elapsed/60:.1f} min {summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
