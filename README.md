<div align="center">

# Google Maps Scraper

---

**One self-hosted Playwright endpoint for Google Maps lead gen — harvest by category, checkpoint to JSONL, enrich emails and phones, and export only the fields you enable.**

Discover businesses across states and categories, resume after CAPTCHAs, and skip paid scrape APIs (Monid, Apify, Bright Data, and the rest) — your machine, your data, your pipeline.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![GitHub stars](https://img.shields.io/github/stars/erikfiala/google-maps-scraper?style=social)](https://github.com/erikfiala/google-maps-scraper)

[Quick Start](#quick-start) · [Output Fields](#configuring-output-fields) · [Categories](#configuring-search-categories) · [CLI](#cli-reference) · [Contributing](#contributing)

</div>

## Quick start

```bash
npm i && npx playwright install chromium
# edit config/scraper.json — toggle fields + categories
npm run scrape -- --states all
npm run enrich
npm run export
```

Default category is **marketing-agency** (enabled in config). Pilot scrape uses CA + NY unless you pass `--states all` or a custom list.

## Configuring output fields

Edit `config/scraper.json` → `fields`. Each key is `true` / `false`.

| Field | Default | Notes |
|-------|---------|--------|
| `name` | `true` | Business name |
| `email` | `true` | From website enrich; export keeps rows with email only when this is `true` |
| `phone` | `false` | From Maps place details; website enrich fills gaps when enabled |
| `address` | `false` | From Maps |
| `website` | `false` | From Maps |
| `category` | `true` | Harvest category slug |
| `maps_url` | `false` | Google Maps URL |
| `place_id` | `false` | Durable place id |
| `city` | `false` | Parsed when available |
| `state` | `false` | Parsed when available |
| `country` | `false` | Country code from harvest |

**Behavior**

- **CSV columns** = only fields set to `true`, in the order above.
- **Email enrich** (`npm run enrich`) runs when `fields.email` is `true`; extracts emails from business websites.
- **Phone enrich** runs in the same pass when `fields.phone` is `true`; keeps the Maps phone when present, otherwise fills from `tel:` links / phone patterns on the site. Skips places that already have a phone.
- Enrich is a no-op only when **both** `fields.email` and `fields.phone` are `false`.
- Maps scrape still stores a full place record in `places.jsonl` for resume/debugging; export and docs emphasize the toggled fields.

Example (defaults):

```json
{
  "fields": {
    "name": true,
    "email": true,
    "phone": false,
    "address": false,
    "website": false,
    "category": true,
    "maps_url": false,
    "place_id": false,
    "city": false,
    "state": false,
    "country": false
  }
}
```

## Configuring search categories

Same file → `search.categories[]`:

| Property | Meaning |
|----------|---------|
| `slug` | Data folder under `data/<country>/<slug>/` |
| `enabled` | Pipeline / default runs only enabled categories when `--category` is omitted |
| `label` | Human label on logs / records |
| `queries` | Google Maps search phrases (tried in order per geo tile) |

**Default shipped**

- `marketing-agency` — queries `marketing agency`, `advertising agency`

Add more categories by copying objects into `search.categories[]`. Starter example:

```json
{
  "slug": "marketing-agency",
  "enabled": true,
  "label": "marketing agency",
  "queries": ["marketing agency", "advertising agency"]
}
```

### Browse all Google Maps categories

A full Places API place-type catalog ships in `config/google_maps_categories.json` (~500 types across Automotive, Services, Food and Drink, Shopping, etc.). Use it to see what you can track, then paste a snippet into `scraper.json`.

```bash
# List groups + counts
npm run categories

# Search by name / id / suggested query
npm run categories -- --search marketing
npm run categories -- --search dentist --snippet

# Filter by group
npm run categories -- --group Services --limit 30
npm run categories -- --group "Food and Drink" --json
```

`--snippet` prints a ready-to-paste `search.categories[]` entry (`slug`, `label`, `suggestedQueries`).
## CLI reference

```bash
# Full US scrape for the default (first enabled) category
npm run scrape -- --states all

# Or an explicit category
npm run scrape -- --country us --category marketing-agency --states all

# Standalone scrape entry (preferred for long runs)
npx tsx src/geo_harvest.ts --country us --category marketing-agency --states all

# Enrich websites → emails/phones (no-op if both fields.email and fields.phone are false)
npm run enrich -- --country us --category marketing-agency

# Write leads.csv (enabled fields only)
npm run export -- --country us --category marketing-agency

# Full pipeline over enabled categories
python3 scripts/run_category_pipeline.py
# Or a subset (ignores enabled flags):
python3 scripts/run_category_pipeline.py marketing-agency
```

### Options

| Flag | Commands | Default | Notes |
|------|----------|---------|-------|
| `--country` | all | `us` | Loads `src/countries/<code>.ts` |
| `--category` | all | first enabled in config | Slug from `config/scraper.json` |
| `--states` | scrape | `CA,NY` | Comma-separated codes, or `all` |
| `--max-places` | scrape | `50000` | Global unique place cap per category |
| `--max-per-tile` | scrape | `120` | Soft cap per geo tile per query |
| `--headed` | scrape | off | Visible browser (debug / CAPTCHA) |
| `--dry-run` | scrape | off | First tile, 5 places, no writes |
| `--concurrency` | enrich | `4` | Parallel website fetches |
| `--timeout` | enrich | `10000` | Per-request timeout (ms) |
| `--search` | categories | — | Substring search over the Maps catalog |
| `--group` | categories | — | Filter by catalog group |
| `--snippet` | categories | off | Print paste-ready `scraper.json` category JSON |
## Data layout

```
data/<country>/<category-slug>/
  places.jsonl      # append-only checkpoint (scrape + enrich)
  progress.json     # completed tiles + CAPTCHA pause flag
  leads.csv         # export (enabled fields only)
```

`data/` is gitignored. Deduplicate within a category by `place_id`. Cross-category overlap is OK.

## CAPTCHA / resume

- Completed tiles are recorded in `progress.json` and skipped on re-run.
- Existing `place_id`s in `places.jsonl` are skipped (dedupe).
- Multiple Maps queries for a category run per tile before the tile is marked complete.
- CAPTCHA detection only treats real Google `/sorry/` interstitial pathnames. Consent pages are dismissed, not treated as hard blocks.
- If Google shows a CAPTCHA, the scraper **pauses**, logs the tile, and sets `pausedForCaptcha` in `progress.json`.
- Resolve manually with `--headed` if headless retries fail.

**Concurrency locks** — scrape and enrich are mutually exclusive per category:

- `scrape` creates `.scrape_lock` exclusively (and refuses to start while `.enrich_lock` exists, or if another scrape already holds the lock).
- `enrich` creates `.enrich_lock` exclusively (and refuses to start while `.scrape_lock` exists, or if another enrich already holds the lock).
- Each process removes only its own lock (PID-matched) on normal exit. If a process is killed, a stale lock blocks the other command — delete `data/<country>/<category>/.scrape_lock` or `.enrich_lock` to force.

## Disclaimer

This tool is for educational and legitimate research use. Respect Google’s Terms of Service, applicable laws, and website robots/terms when enriching emails. You are responsible for how you use scraped data (including CAN-SPAM / GDPR / marketing consent). Scraping at scale may trigger rate limits or blocks; be a good citizen.

## Contributing

Contributions are welcome — bug reports, fixes, docs, and small features all help.

1. Fork the repo and create a branch from `main`.
2. Install deps and Chromium: `npm i && npx playwright install chromium`.
3. Make your change. Prefer focused PRs over large catch-alls.
4. Sanity-check locally (TypeScript + a short dry-run when touching scrape/enrich):

```bash
npx tsc --noEmit
npm run scrape -- --dry-run
```

5. Open a pull request against `main` with a short description of the problem and the fix.

**Good fits:** race/data-loss bugs, resume/CAPTCHA edge cases, export/CSV correctness, config/docs clarity, safer defaults, and small CLI UX improvements.

**Please avoid:** scraping paid third-party proxies into the core path, large refactors without a clear win, or changes that ignore Google’s ToS / local laws. Keep secrets and scraped `data/` out of commits (already gitignored).

## Contributors

Thank you to everyone who has contributed to this project:

- [Erik Fiala](https://github.com/erikfiala) — author and maintainer
- [Avres (@Shinzzyak)](https://github.com/Shinzzyak) — critical enrich/scrape data-loss race fix, dry-run caps, fetch memory limit, and CSV injection hardening ([PR #2](https://github.com/erikfiala/google-maps-scraper/pull/2))

If you have contributed and are missing here, open a PR or ping the maintainer — happy to add you.

## Support the author

If this helped you:

- Visit [erikfiala.com](https://erikfiala.com)
- Follow on [X](https://x.com/fialaerik) and [LinkedIn](https://www.linkedin.com/in/erikfiala)
- Share [Audioworm](https://www.audioworm.fm), [Breakflare](https://www.breakflare.com), and [Hausive](https://www.hausive.com) with people who might find them valuable

## License

[MIT](LICENSE) © Erik Fiala
