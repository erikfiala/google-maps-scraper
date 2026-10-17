#!/usr/bin/env python3
"""
Parallel US finance harvest for the same categories used in the UAE run.

Scrapes each enabled finance category across every US geo tile (shard per tile),
merges, enriches, and writes a dedicated email-only CSV per category under
gitignored data/us/ (plus /opt/cursor/artifacts/).

Cryptocurrency is skipped for scrape when data/us/cryptocurrency/places.jsonl
already exists (from a prior US crypto run); it is still exported.
"""
from __future__ import annotations

import json
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config" / "scraper.json"
LOG_DIR = Path("/tmp/google-maps-scraper-pipeline/us-finance")
COUNTRY = "us"
ARTIFACTS = Path("/opt/cursor/artifacts")

# Match UAE finance set; first query used per category for speed.
CATEGORY_QUERIES: dict[str, str] = {
    "investment-firm": "investment firm",
    "financial-advisor": "wealth management",
    "venture-capital": "venture capital",
    "brokerage": "stock broker",
    "cryptocurrency": "cryptocurrency",
    "bank": "investment bank",
    "finance": "fintech",
    "accounting": "accounting",
}

MAX_PER_TILE = "30"
MAX_PLACES = "50"
ENRICH_CONCURRENCY = "8"
MAX_PARALLEL_SCRAPES = 12
MAX_PARALLEL_ENRICH = 4


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


def load_categories() -> list[str]:
    # Prefer explicit UAE/US finance set order; fall back to enabled config.
    cfg_slugs = []
    try:
        cfg = json.loads(CONFIG.read_text())
        cfg_slugs = [
            c["slug"] for c in cfg.get("search", {}).get("categories", []) if c.get("enabled")
        ]
    except Exception:
        pass
    ordered = [c for c in CATEGORY_QUERIES if c in cfg_slugs or not cfg_slugs]
    return ordered or list(CATEGORY_QUERIES.keys())


def shard_slug(category: str, tile_id: str) -> str:
    return f"{category}__shard_{tile_id}".lower()


def clear_locks(slug: str) -> None:
    d = cat_dir(slug)
    for name in (".scrape_lock", ".enrich_lock"):
        lock = d / name
        if lock.exists():
            lock.unlink()


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


def scrape_shard(category: str, tile_id: str) -> tuple[str, str, int]:
    data_slug = shard_slug(category, tile_id)
    clear_locks(data_slug)
    shard = cat_dir(data_slug)
    for name in ("progress.json", ".scrape_lock", ".enrich_lock"):
        p = shard / name
        if p.exists():
            p.unlink()
    query = CATEGORY_QUERIES.get(category, category.replace("-", " "))
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
            "--query",
            query,
            "--max-places",
            MAX_PLACES,
            "--max-per-tile",
            MAX_PER_TILE,
        ],
        f"{data_slug}-scrape.log",
    )
    return category, tile_id, ec


def merge_category(category: str) -> int:
    dest = cat_dir(category)
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
    for shard_path in (ROOT / "data" / COUNTRY).glob(f"{category}__shard_*/places.jsonl"):
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
            row["category"] = category
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
    log(f"[merge] {category}: {len(by_id)} unique (+{len(by_id) - before} shards)")
    return len(by_id)


def enrich_category(category: str) -> int:
    if places_count(category) == 0:
        return 0
    clear_locks(category)
    return run_cmd(
        [
            "npm",
            "run",
            "enrich",
            "--",
            "--country",
            COUNTRY,
            "--category",
            category,
            "--concurrency",
            ENRICH_CONCURRENCY,
        ],
        f"{category}-enrich.log",
    )


def export_category(category: str) -> int:
    if places_count(category) == 0:
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
            category,
        ],
        f"{category}-export.log",
    )


def category_email_csv_name(category: str) -> str:
    # Avoid colliding with the combined us_finance_emails.csv
    if category == "finance":
        return "us_fintech_emails.csv"
    return f"us_{category}_emails.csv"


def write_category_email_csv(category: str) -> Path:
    out = ROOT / "data" / COUNTRY / category_email_csv_name(category)
    places = cat_dir(category) / "places.jsonl"
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
                    "category": category,
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
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / f"us_{category}_emails.csv").write_text(body)
    # Also copy leads.csv when present
    leads = cat_dir(category) / "leads.csv"
    if leads.exists():
        (ARTIFACTS / f"us_{category}_leads.csv").write_text(leads.read_text())
    log(f"[csv] {category}: {len(rows)} unique emails → {out}")
    return out


def write_combined_csv(categories: list[str]) -> Path:
    out = ROOT / "data" / COUNTRY / "us_finance_emails.csv"
    rows: list[dict] = []
    seen: set[str] = set()
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
    for category in categories:
        path = ROOT / "data" / COUNTRY / f"us_{category}_emails.csv"
        if not path.exists():
            continue
        import csv

        with path.open() as f:
            for r in csv.DictReader(f):
                email = (r.get("email") or "").strip().lower()
                if not email or email in seen:
                    continue
                seen.add(email)
                rows.append({h: r.get(h) or "" for h in headers})

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
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / "us_finance_emails.csv").write_text(body)
    log(f"[csv] combined: {len(rows)} unique emails → {out}")
    return out


def main() -> int:
    started = time.time()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    cats = load_categories()
    tiles = list_tile_ids()
    log(f"US finance parallel start cats={cats} tiles={len(tiles)}")

    # Skip scrape for categories that already have substantial data (e.g. crypto).
    scrape_cats = []
    for c in cats:
        existing = places_count(c)
        if c == "cryptocurrency" and existing >= 500:
            log(f"[skip-scrape] {c} already has {existing} places")
            continue
        scrape_cats.append(c)

    jobs = [(c, t) for c in scrape_cats for t in tiles]
    log(f"=== PHASE 1: scrape {len(jobs)} shards (cap={MAX_PARALLEL_SCRAPES}) ===")
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_SCRAPES) as pool:
        futs = {pool.submit(scrape_shard, c, t): (c, t) for c, t in jobs}
        done = 0
        for fut in as_completed(futs):
            c, t = futs[fut]
            done += 1
            try:
                _, _, ec = fut.result()
                log(f"[scrape] {done}/{len(jobs)} {c}/{t} exit={ec}")
            except Exception as e:
                log(f"[scrape] {done}/{len(jobs)} {c}/{t} error={e}")

    log("=== PHASE 2: merge shards ===")
    for c in scrape_cats:
        merge_category(c)

    log("=== PHASE 3: enrich ===")
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_ENRICH) as pool:
        futs = {pool.submit(enrich_category, c): c for c in cats}
        for fut in as_completed(futs):
            c = futs[fut]
            try:
                ec = fut.result()
                log(f"[enrich] {c} exit={ec} places={places_count(c)} emails={email_count(c)}")
            except Exception as e:
                log(f"[enrich] {c} error={e}")

    log("=== PHASE 4: export email-only CSVs ===")
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_ENRICH) as pool:
        list(pool.map(export_category, cats))
    for c in cats:
        write_category_email_csv(c)
    combined = write_combined_csv(cats)

    elapsed = time.time() - started
    summary = {
        "elapsed_sec": round(elapsed),
        "tiles": len(tiles),
        "categories": {
            c: {"places": places_count(c), "emails": email_count(c)} for c in cats
        },
        "combined_csv": str(combined),
        "artifact_combined": str(ARTIFACTS / "us_finance_emails.csv"),
    }
    (LOG_DIR / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (ARTIFACTS / "us_finance_summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    log(f"DONE in {elapsed/60:.1f} min {summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
