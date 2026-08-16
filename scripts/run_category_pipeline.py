#!/usr/bin/env python3
"""
Run full-US Maps scrape → enrich → export for each enabled category.

Categories come from config/scraper.json (enabled: true). Pass slug args to
override and run a specific subset regardless of enabled flags.

Resume-safe: skips categories whose progress.json already has all tiles done
and places are enriched (re-runs enrich/export if needed). One process at a time.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config" / "scraper.json"
LOG_DIR = Path("/tmp/google-maps-scraper-pipeline")
SUMMARY = LOG_DIR / "summary.jsonl"

COUNTRY = "us"
MAX_PLACES = "50000"
ENRICH_CONCURRENCY = "3"


def load_enabled_categories() -> list[str]:
    cfg = json.loads(CONFIG.read_text())
    cats = cfg.get("search", {}).get("categories", [])
    return [c["slug"] for c in cats if c.get("enabled")]


def enrich_fields_enabled() -> bool:
    cfg = json.loads(CONFIG.read_text())
    fields = cfg.get("fields", {})
    return bool(fields.get("email", True)) or bool(fields.get("phone", False))


def field_enabled(name: str, default: bool = False) -> bool:
    cfg = json.loads(CONFIG.read_text())
    return bool(cfg.get("fields", {}).get(name, default))


def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] {msg}"
    print(line, flush=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with (LOG_DIR / "runner.log").open("a") as f:
        f.write(line + "\n")


def cat_dir(slug: str) -> Path:
    return ROOT / "data" / COUNTRY / slug


def load_progress(slug: str) -> dict | None:
    p = cat_dir(slug) / "progress.json"
    if not p.exists():
        return None
    return json.loads(p.read_text())


_TILE_COUNT: int | None = None


def tile_count() -> int:
    global _TILE_COUNT
    if _TILE_COUNT is not None:
        return _TILE_COUNT
    out = subprocess.check_output(
        [
            "npx",
            "tsx",
            "-e",
            "import { usCountry } from './src/countries/us.ts'; console.log(usCountry.tiles.length)",
        ],
        cwd=str(ROOT),
        text=True,
    ).strip()
    _TILE_COUNT = int(out.splitlines()[-1])
    return _TILE_COUNT


def places_stats(slug: str) -> tuple[int, int, int, int]:
    path = cat_dir(slug) / "places.jsonl"
    if not path.exists():
        return 0, 0, 0, 0
    places = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    total = len(places)
    emails = sum(1 for p in places if (p.get("email") or "").strip())
    phones = sum(1 for p in places if (p.get("phone") or "").strip())
    want_phone = field_enabled("phone", False)
    need = sum(
        1
        for p in places
        if (not p.get("enriched_at"))
        or (
            want_phone
            and not (p.get("phone") or "").strip()
            and (p.get("website") or "").strip()
        )
    )
    return total, emails, phones, need


def scrape_done(slug: str) -> bool:
    prog = load_progress(slug)
    if not prog:
        return False
    if prog.get("pausedForCaptcha"):
        return False
    done = len(prog.get("completedTiles") or [])
    return done >= tile_count()


def run(cmd: list[str], log_name: str) -> int:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / log_name
    log(f"$ {' '.join(cmd)}")
    with log_path.open("a") as lf:
        lf.write(f"\n=== {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} ===\n")
        lf.write(f"$ {' '.join(cmd)}\n")
        lf.flush()
        proc = subprocess.Popen(
            cmd,
            cwd=str(ROOT),
            stdout=lf,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        ec = proc.wait()
        log(f"exit={ec} log={log_path}")
        return ec


def scrape_category(slug: str) -> int:
    """Resume scrape until all tiles done. Returns exit code."""
    captcha_hits = 0
    last_captcha_tile: str | None = None
    while True:
        if scrape_done(slug):
            log(f"[{slug}] scrape complete (all tiles)")
            return 0
        prog = load_progress(slug)
        headed = False
        if prog and prog.get("pausedForCaptcha"):
            tile = prog.get("pausedTileId")
            if tile == last_captcha_tile:
                captcha_hits += 1
            else:
                captcha_hits = 1
                last_captcha_tile = tile
            headed = captcha_hits >= 2
            wait_s = 120 if headed else 300
            log(
                f"[{slug}] CAPTCHA pause on tile {tile} "
                f"(hits={captcha_hits}, headed={headed}) — cool-down {wait_s}s"
            )
            prog["pausedForCaptcha"] = False
            (cat_dir(slug) / "progress.json").write_text(json.dumps(prog, indent=2) + "\n")
            time.sleep(wait_s)

        cmd = [
            "npx",
            "tsx",
            "src/geo_harvest.ts",
            "--country",
            COUNTRY,
            "--category",
            slug,
            "--states",
            "all",
            "--max-places",
            MAX_PLACES,
        ]
        if headed:
            cmd.append("--headed")

        ec = run(cmd, f"{slug}-scrape.log")
        if scrape_done(slug):
            return 0
        if ec == 2:
            log(f"[{slug}] scrape exit=2 (CAPTCHA); will cool-down and retry")
            if captcha_hits >= 8:
                log(f"[{slug}] CAPTCHA blocker after {captcha_hits} hits — writing marker")
                (LOG_DIR / f"{slug}.CAPTCHA_BLOCKED").write_text(
                    f"tile={last_captcha_tile} hits={captcha_hits}\n"
                )
                return 2
            continue
        if ec != 0:
            log(f"[{slug}] scrape exit={ec}; retry in 60s")
            time.sleep(60)
            continue
        total, _, _, _ = places_stats(slug)
        log(f"[{slug}] scrape exited 0 with {total} places; tiles may be incomplete")
        return 0


def enrich_category(slug: str) -> int:
    if not enrich_fields_enabled():
        log(f"[{slug}] enrich skipped (fields.email and fields.phone are false)")
        return 0
    rounds = 0
    while True:
        rounds += 1
        total, emails, phones, need = places_stats(slug)
        log(
            f"[{slug}] enrich round={rounds} places={total} need={need} "
            f"emails={emails} phones={phones}"
        )
        if need == 0:
            return 0
        if rounds > 40:
            log(f"[{slug}] enrich round cap; remaining={need}")
            return 1
        ec = run(
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
        _, _, _, need2 = places_stats(slug)
        if need2 == 0:
            return 0
        if need2 >= need:
            time.sleep(20)
        else:
            time.sleep(3)
        if ec != 0 and need2 >= need:
            log(f"[{slug}] enrich stalled exit={ec}")


def export_category(slug: str) -> dict:
    run(
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
    total, emails, phones, need = places_stats(slug)
    leads = cat_dir(slug) / "leads.csv"
    row = {
        "category": slug,
        "places": total,
        "emails": emails,
        "phones": phones,
        "unenriched": need,
        "leads_csv": str(leads) if leads.exists() else None,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with SUMMARY.open("a") as f:
        f.write(json.dumps(row) + "\n")
    log(
        f"[{slug}] DONE places={total} emails={emails} phones={phones} "
        f"leads={leads} unenriched={need}"
    )
    return row


def main() -> int:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    only = [a for a in sys.argv[1:] if not a.startswith("-")]
    cats = only if only else load_enabled_categories()
    if not cats:
        log("No categories to run. Enable categories in config/scraper.json or pass slugs.")
        return 1
    log(f"Pipeline start categories={cats}")

    results = []
    for slug in cats:
        log(f"======== CATEGORY {slug} ========")
        scrape_category(slug)
        enrich_category(slug)
        results.append(export_category(slug))

    log("======== SUMMARY ========")
    for r in results:
        log(
            f"{r['category']}: places={r['places']} emails={r['emails']} "
            f"phones={r['phones']} leads={r['leads_csv']} "
            f"blockers=unenriched:{r['unenriched']}"
        )
    (LOG_DIR / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
