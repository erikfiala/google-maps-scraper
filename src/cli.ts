#!/usr/bin/env node
import {
  listCategorySlugs,
  listEnabledCategorySlugs,
} from "./categories.js";
import {
  DEFAULT_CATEGORY,
  DEFAULT_COUNTRY,
  DEFAULT_ENRICH_CONCURRENCY,
  DEFAULT_ENRICH_TIMEOUT_MS,
  DEFAULT_MAX_PER_TILE,
  DEFAULT_MAX_PLACES,
  DEFAULT_PILOT_STATES,
  allStateCodes,
  getDefaultCategory,
  getEnabledExportFields,
  isFieldEnabled,
  loadCategory,
  loadCountry,
} from "./config.js";
import { runEnrich } from "./enrich.js";
import { runScrape } from "./maps.js";
import {
  ensureDataDir,
  exportCsv,
  loadPlaces,
  migrateLegacyBookPublisher,
} from "./store.js";
import type { EnrichOptions, ScrapeOptions } from "./types.js";

function usage(): never {
  const enabled = listEnabledCategorySlugs();
  const defaultCat = (() => {
    try {
      return getDefaultCategory();
    } catch {
      return DEFAULT_CATEGORY;
    }
  })();
  const fields = (() => {
    try {
      return getEnabledExportFields().join(",");
    } catch {
      return "name,email,category";
    }
  })();

  console.log(`
google-maps-scraper — multi-category Google Maps harvest

Usage:
  npm run scrape -- [options]
  npm run enrich -- [options]
  npm run export -- [options]

Commands:
  scrape   Discover places on Google Maps (Playwright)
  enrich   Fetch websites and extract emails (only if fields.email=true)
  export   Write data/<country>/<category>/leads.csv (enabled fields only)

Scrape options:
  --country <code>     Country config (default: ${DEFAULT_COUNTRY})
  --category <slug>    Category slug (default: ${defaultCat})
                       Known: ${listCategorySlugs().join(", ") || "(see config/scraper.json)"}
                       Enabled: ${enabled.join(", ") || "(none)"}
  --states <list>      Comma-separated state codes, or "all" (default pilot: ${DEFAULT_PILOT_STATES.join(",")})
  --max-places <n>     Global place cap (default: ${DEFAULT_MAX_PLACES})
  --max-per-tile <n>   Per-tile result cap (default: ${DEFAULT_MAX_PER_TILE})
  --headed             Show browser (debug / CAPTCHA resolve)
  --dry-run            Scrape first tile, 5 places, log only (no JSONL write)

Enrich / export options:
  --country <code>
  --category <slug>
  --concurrency <n>    Parallel fetches (default: ${DEFAULT_ENRICH_CONCURRENCY})
  --timeout <ms>       Per-request timeout (default: ${DEFAULT_ENRICH_TIMEOUT_MS})

Config: config/scraper.json
  Export columns (enabled): ${fields}
  Pipeline (enabled categories): ${enabled.join(" → ") || "(none — enable in config)"}

Data layout: data/<country>/<category-slug>/{places.jsonl,progress.json,leads.csv}
`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === "-h" || command === "--help") usage();

  const flags = new Map<string, string | boolean>();
  while (args.length) {
    const a = args.shift()!;
    if (a === "-h" || a === "--help") usage();
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[0];
      if (!next || next.startsWith("--")) {
        flags.set(key, true);
      } else {
        flags.set(key, args.shift()!);
      }
    }
  }
  return { command, flags };
}

function flagStr(flags: Map<string, string | boolean>, key: string, fallback: string): string {
  const v = flags.get(key);
  if (v === undefined || typeof v === "boolean") return fallback;
  return v;
}

function flagNum(flags: Map<string, string | boolean>, key: string, fallback: number): number {
  const v = flags.get(key);
  if (v === undefined || typeof v === "boolean") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --${key}: ${v}`);
  return n;
}

function flagBool(flags: Map<string, string | boolean>, key: string): boolean {
  return flags.get(key) === true;
}

function resolveStates(flags: Map<string, string | boolean>, country: string): string[] {
  const statesRaw = flagStr(flags, "states", DEFAULT_PILOT_STATES.join(","));
  if (statesRaw.trim().toLowerCase() === "all") {
    return allStateCodes(country);
  }
  return statesRaw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

async function cmdScrape(flags: Map<string, string | boolean>): Promise<void> {
  const country = flagStr(flags, "country", DEFAULT_COUNTRY).toLowerCase();
  const category = loadCategory(flagStr(flags, "category", getDefaultCategory()));
  const config = loadCountry(country);

  if (category.slug === "book-publisher") migrateLegacyBookPublisher(country);
  ensureDataDir(country, category.slug);

  const states = resolveStates(flags, country);
  let tiles = config.tiles.filter((t) => states.includes(t.code));
  if (!tiles.length) {
    throw new Error(
      `No tiles for states [${states.join(", ")}] in country ${country}. ` +
        `Available codes: ${[...new Set(config.tiles.map((t) => t.code))].join(", ")}`,
    );
  }

  const dryRun = flagBool(flags, "dry-run");
  if (dryRun) {
    tiles = tiles.slice(0, 1);
    console.log(`[cli] Dry-run: first tile only (${tiles[0].id}), 5 places, no writes`);
  }

  const opts: ScrapeOptions = {
    country,
    categorySlug: category.slug,
    searchQueries: category.queries,
    categoryLabel: category.label,
    states,
    maxPlaces: flagNum(flags, "max-places", DEFAULT_MAX_PLACES),
    maxPerTile: flagNum(flags, "max-per-tile", DEFAULT_MAX_PER_TILE),
    headed: flagBool(flags, "headed"),
    dryRun,
  };

  console.log(
    `[cli] scrape country=${country} category=${category.slug} ` +
      `queries=[${category.queries.join(" | ")}] states=${states.length === allStateCodes(country).length ? "all" : states.join(",")} ` +
      `tiles=${tiles.length} maxPlaces=${opts.maxPlaces}`,
  );

  const result = await runScrape(tiles, opts);
  console.log(
    `[cli] scrape finished: places=${result.placeCount} tilesDone=${result.tilesDone}` +
      (result.captcha ? " CAPTCHA_PAUSED=true" : ""),
  );
  if (result.captcha) process.exitCode = 2;
}

async function cmdEnrich(flags: Map<string, string | boolean>): Promise<void> {
  if (!isFieldEnabled("email")) {
    console.log(
      `[cli] enrich skipped — set fields.email to true in config/scraper.json to extract emails`,
    );
    return;
  }

  const country = flagStr(flags, "country", DEFAULT_COUNTRY).toLowerCase();
  const category = loadCategory(flagStr(flags, "category", getDefaultCategory()));
  if (category.slug === "book-publisher") migrateLegacyBookPublisher(country);

  const opts: EnrichOptions = {
    country,
    categorySlug: category.slug,
    concurrency: flagNum(flags, "concurrency", DEFAULT_ENRICH_CONCURRENCY),
    timeoutMs: flagNum(flags, "timeout", DEFAULT_ENRICH_TIMEOUT_MS),
  };
  await runEnrich(opts);
}

async function cmdExport(flags: Map<string, string | boolean>): Promise<void> {
  const country = flagStr(flags, "country", DEFAULT_COUNTRY).toLowerCase();
  const category = loadCategory(flagStr(flags, "category", getDefaultCategory()));
  if (category.slug === "book-publisher") migrateLegacyBookPublisher(country);

  const places = loadPlaces(country, category.slug);
  if (!places.length) {
    console.log(`[cli] No places to export for ${country}/${category.slug}`);
    process.exit(1);
  }
  const { path, count, columns } = exportCsv(country, category.slug, category.slug);
  const emailNote = isFieldEnabled("email")
    ? "; rows with email only"
    : "; all places";
  console.log(`[cli] Wrote ${path}`);
  console.log(
    `[cli] ${count} rows; columns=${columns.join(",")}${emailNote}`,
  );
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "scrape":
      await cmdScrape(flags);
      break;
    case "enrich":
      await cmdEnrich(flags);
      break;
    case "export":
      await cmdExport(flags);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
