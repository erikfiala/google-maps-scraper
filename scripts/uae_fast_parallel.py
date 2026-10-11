#!/usr/bin/env python3
"""
Fast parallel UAE finance harvest.

Strategy:
  1) Enrich whatever we already scraped (email-only export later).
  2) Launch one scrape worker per (category × hub tile) into shard data dirs.
  3) Merge shards into canonical category folders.
  4) Enrich again + export leads.csv (rows with email only).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config" / "scraper.json"
LOG_DIR = Path("/tmp/google-maps-scraper-pipeline/fast")
COUNTRY = "ae"

# Top finance hubs only — sized for ~20 min on a 4-vCPU box.
HUB_TILES = [
    "DXB-difc",
    "DXB-marina",
    "AUH-adgm",
]

MAX_PER_TILE = "28"
MAX_PLACES = "40"
ENRICH_CONCURRENCY = "8"
MAX_PARALLEL_SCRAPES = 12
MAX_PARALLEL_ENRICH = 8


def load_categories() -> list[str]:
    cfg = json.loads(CONFIG.read_text())
    return [c["slug"] for c in cfg["search"]["categories"] if c.get("enabled")]


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


def places_count(slug: str) -> int:
    p = cat_dir(slug) / "places.jsonl"
    if not p.exists():
        return 0
    return sum(1 for line in p.read_text().splitlines() if line.strip())


def email_count(slug: str) -> int:
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


def clear_locks(slug: str) -> None:
    d = cat_dir(slug)
    for name in (".scrape_lock", ".enrich_lock"):
        lock = d / name
        if lock.exists():
            lock.unlink()


def enrich_category(slug: str) -> int:
    if places_count(slug) == 0:
        return 0
    clear_locks(slug)
    return run_cmd(
        [
            "npm",
            "run",
            "enrich",
            "--",
            "--country",
            COUNTRY,
            "--category",
            slug,
            "--concurrency",
            ENRICH_CONCURRENCY,
        ],
        f"{slug}-enrich.log",
    )


def export_category(slug: str) -> int:
    if places_count(slug) == 0:
        return 0
    return run_cmd(
        [
            "npm",
            "run",
            "export",
            "--",
            "--country",
            COUNTRY,
            "--category",
            slug,
        ],
        f"{slug}-export.log",
    )


def shard_slug(category: str, tile_id: str) -> str:
    # dataDir() lowercases category slug segments — keep shards lowercase.
    return f"{category}__shard_{tile_id}".lower()


def scrape_shard(category: str, tile_id: str) -> tuple[str, str, int]:
    data_slug = shard_slug(category, tile_id)
    clear_locks(data_slug)
    # Fresh shard progress each fast run for this tile
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
            category,
            "--data-slug",
            data_slug,
            "--tiles",
            tile_id,
            "--max-places",
            MAX_PLACES,
            "--max-per-tile",
            MAX_PER_TILE,
        ],
        f"{data_slug}-scrape.log",
    )
    return category, tile_id, ec


def merge_shards(categories: list[str]) -> None:
    for category in categories:
        dest = cat_dir(category)
        dest.mkdir(parents=True, exist_ok=True)
        places_path = dest / "places.jsonl"
        by_id: dict[str, dict] = {}
        # Keep existing canonical places
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
        # Merge shards (also glob in case of naming drift)
        shard_files = list((ROOT / "data" / COUNTRY).glob(f"{category}__shard_*/places.jsonl"))
        for shard_path in shard_files:
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
                # Canonical category label on merged rows
                row["category"] = category
                prev = by_id.get(pid)
                if not prev:
                    by_id[pid] = row
                    continue
                # Prefer row that already has email / enrichment
                if (row.get("email") or "") and not (prev.get("email") or ""):
                    by_id[pid] = row
                elif row.get("enriched_at") and not prev.get("enriched_at"):
                    by_id[pid] = {**prev, **{k: v for k, v in row.items() if v}}
        places_path.write_text(
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in by_id.values())
        )
        log(f"[merge] {category}: {len(by_id)} unique places (+{len(by_id) - before} from shards)")


def combine_email_leads(categories: list[str]) -> Path:
    out = ROOT / "data" / COUNTRY / "uae_finance_emails.csv"
    rows: list[dict] = []
    seen_email: set[str] = set()
    for category in categories:
        leads = cat_dir(category) / "leads.csv"
        if not leads.exists():
            continue
        lines = leads.read_text().splitlines()
        if not lines:
            continue
        headers = lines[0].split(",")
        # naive CSV — export is simple enough; also read places.jsonl for safety
        places = cat_dir(category) / "places.jsonl"
        if not places.exists():
            continue
        for line in places.read_text().splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            email = (row.get("email") or "").strip().lower()
            if not email or email in seen_email:
                continue
            seen_email.add(email)
            rows.append(
                {
                    "name": row.get("name") or "",
                    "email": row.get("email") or "",
                    "website": row.get("website") or "",
                    "address": row.get("address") or "",
                    "city": row.get("city") or "",
                    "state": row.get("state") or "",
                    "country": row.get("country") or "ae",
                    "category": category,
                }
            )
    # Write CSV
    headers = ["name", "email", "website", "address", "city", "state", "country", "category"]
    def esc(v: str) -> str:
        v = str(v)
        if any(c in v for c in [",", '"', "\n"]):
            return '"' + v.replace('"', '""') + '"'
        return v

    body = ",".join(headers) + "\n" + "\n".join(
        ",".join(esc(r[h]) for h in headers) for r in rows
    ) + ("\n" if rows else "")
    out.write_text(body)
    log(f"[combine] wrote {len(rows)} unique emails → {out}")
    return out


def main() -> int:
    started = time.time()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    cats = load_categories()
    log(f"Fast parallel start cats={cats} hubs={HUB_TILES}")

    # Phase 1+2 overlapped: enrich existing canonical dirs while scraping into shards
    log("=== PHASE 1+2: enrich existing + parallel hub-tile scrapes ===")
    jobs = [(c, t) for c in cats for t in HUB_TILES]
    log(
        f"Launching {len(jobs)} shard scrapes (cap={MAX_PARALLEL_SCRAPES}) "
        f"+ {len(cats)} enrichers"
    )

    scrape_pool = ThreadPoolExecutor(max_workers=MAX_PARALLEL_SCRAPES)
    enrich_pool = ThreadPoolExecutor(max_workers=MAX_PARALLEL_ENRICH)
    try:
        scrape_futs = {scrape_pool.submit(scrape_shard, c, t): (c, t) for c, t in jobs}
        enrich_futs = {enrich_pool.submit(enrich_category, c): c for c in cats}

        enrich_done = 0
        for fut in as_completed(enrich_futs):
            c = enrich_futs[fut]
            enrich_done += 1
            try:
                ec = fut.result()
                log(
                    f"[enrich-existing] {enrich_done}/{len(cats)} {c} "
                    f"exit={ec} emails={email_count(c)}"
                )
            except Exception as e:
                log(f"[enrich-existing] {c} error={e}")

        # Mid-run email export so user has something before scrapes finish
        with ThreadPoolExecutor(max_workers=MAX_PARALLEL_ENRICH) as pool:
            list(pool.map(export_category, cats))
        mid = combine_email_leads(cats)
        log(f"[midpoint] early email CSV ready: {mid}")

        scrape_done = 0
        for fut in as_completed(scrape_futs):
            c, t = scrape_futs[fut]
            scrape_done += 1
            try:
                _, _, ec = fut.result()
                log(f"[scrape] {scrape_done}/{len(jobs)} {c}/{t} exit={ec}")
            except Exception as e:
                log(f"[scrape] {scrape_done}/{len(jobs)} {c}/{t} error={e}")
    finally:
        scrape_pool.shutdown(wait=True)
        enrich_pool.shutdown(wait=True)

    # Phase 3: merge + enrich + export
    log("=== PHASE 3: merge shards ===")
    merge_shards(cats)

    log("=== PHASE 4: enrich merged ===")
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_ENRICH) as pool:
        futs = {pool.submit(enrich_category, c): c for c in cats}
        for fut in as_completed(futs):
            c = futs[fut]
            try:
                ec = fut.result()
                log(f"[enrich-merged] {c} exit={ec} emails={email_count(c)}")
            except Exception as e:
                log(f"[enrich-merged] {c} error={e}")

    log("=== PHASE 5: export email-only ===")
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_ENRICH) as pool:
        list(pool.map(export_category, cats))

    combined = combine_email_leads(cats)
    # Copy artifact outside the repo (never commit lead CSVs)
    art = Path("/opt/cursor/artifacts")
    art.mkdir(parents=True, exist_ok=True)
    target = art / "uae_finance_emails.csv"
    target.write_text(combined.read_text())
    elapsed = time.time() - started
    summary = {
        "elapsed_sec": round(elapsed),
        "categories": {
            c: {"places": places_count(c), "emails": email_count(c)} for c in cats
        },
        "combined_csv": str(combined),
        "artifact_csv": str(target),
    }
    (LOG_DIR / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (art / "uae_finance_summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    log(f"DONE in {elapsed/60:.1f} min summary={summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
