/**
 * Standalone scrape entry — avoids process cmdlines matching `cli.ts scrape`
 * (parallel enrich watchdogs were pkill'ing that pattern).
 */
import {
  DEFAULT_CATEGORY,
  DEFAULT_COUNTRY,
  DEFAULT_MAX_PER_TILE,
  DEFAULT_MAX_PLACES,
  DEFAULT_PILOT_STATES,
  allStateCodes,
  getDefaultCategory,
  loadCategory,
  loadCountry,
} from "./config.js";
import { runScrape } from "./maps.js";
import { ensureDataDir, migrateLegacyBookPublisher } from "./store.js";
import type { ScrapeOptions } from "./types.js";

function parseFlags(argv: string[]) {
  const flags = new Map<string, string | boolean>();
  const args = [...argv];
  while (args.length) {
    const a = args.shift()!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[0];
    if (!next || next.startsWith("--")) flags.set(key, true);
    else flags.set(key, args.shift()!);
  }
  return flags;
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

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const country = flagStr(flags, "country", DEFAULT_COUNTRY).toLowerCase();
  const defaultCat = (() => {
    try {
      return getDefaultCategory();
    } catch {
      return DEFAULT_CATEGORY;
    }
  })();
  const category = loadCategory(flagStr(flags, "category", defaultCat));
  const config = loadCountry(country);

  if (category.slug === "book-publisher") migrateLegacyBookPublisher(country);
  ensureDataDir(country, category.slug);

  const statesRaw = flagStr(flags, "states", DEFAULT_PILOT_STATES.join(","));
  const states =
    statesRaw.trim().toLowerCase() === "all"
      ? allStateCodes(country)
      : statesRaw
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean);

  let tiles = config.tiles.filter((t) => states.includes(t.code));
  if (!tiles.length) {
    throw new Error(`No tiles for states [${states.join(", ")}] in country ${country}`);
  }

  const dryRun = flags.get("dry-run") === true;
  if (dryRun) tiles = tiles.slice(0, 1);

  const opts: ScrapeOptions = {
    country,
    categorySlug: category.slug,
    searchQueries: category.queries,
    categoryLabel: category.label,
    states,
    maxPlaces: flagNum(
      flags,
      "max-places",
      Number(process.env.MAX_PLACES || process.env.AW_CAP) || DEFAULT_MAX_PLACES,
    ),
    maxPerTile: flagNum(flags, "max-per-tile", DEFAULT_MAX_PER_TILE),
    headed: flags.get("headed") === true,
    dryRun,
  };

  console.log(
    `[scrape_main] country=${country} category=${category.slug} ` +
      `queries=[${category.queries.join(" | ")}] states=${states.join(",")} ` +
      `tiles=${tiles.length} maxPlaces=${opts.maxPlaces}`,
  );

  const result = await runScrape(tiles, opts);
  console.log(
    `[scrape_main] finished: places=${result.placeCount} tilesDone=${result.tilesDone}` +
      (result.captcha ? " CAPTCHA_PAUSED=true" : ""),
  );
  if (result.captcha) process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
