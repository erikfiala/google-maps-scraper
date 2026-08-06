import { resolve } from "node:path";
import {
  getDefaultCategorySlug,
  resolveCategory,
  type CategoryDef,
} from "./categories.js";
import type { CountryConfig } from "./types.js";
import { usCountry } from "./countries/us.js";

export {
  FIELD_ORDER,
  getEnabledExportFields,
  getFieldsConfig,
  isFieldEnabled,
  loadScraperConfig,
  resetScraperConfigCache,
  scraperConfigPath,
} from "./scraper_config.js";

export const DEFAULT_COUNTRY = "us";

/** Resolved at call time from config (first enabled category). */
export function getDefaultCategory(): string {
  return getDefaultCategorySlug();
}

/** Static fallback for help text / early imports. */
export const DEFAULT_CATEGORY = "marketing-agency";

export const DEFAULT_MAX_PLACES = 50_000;
export const DEFAULT_MAX_PER_TILE = 120;
export const DEFAULT_ENRICH_CONCURRENCY = 4;
export const DEFAULT_ENRICH_TIMEOUT_MS = 10_000;
export const DEFAULT_PILOT_STATES = ["CA", "NY"];

/** Contact-ish paths to try after the homepage. */
export const CONTACT_PATHS = [
  "/contact",
  "/contact-us",
  "/contactus",
  "/about",
  "/about-us",
  "/aboutus",
];

const COUNTRIES: Record<string, CountryConfig> = {
  us: usCountry,
};

export function loadCountry(code: string): CountryConfig {
  const key = code.toLowerCase();
  const config = COUNTRIES[key];
  if (!config) {
    const available = Object.keys(COUNTRIES).join(", ");
    throw new Error(`Unknown country "${code}". Available: ${available}`);
  }
  return config;
}

export function loadCategory(input: string): CategoryDef {
  return resolveCategory(input);
}

/**
 * Per-category data root: data/<country>/<category-slug>/
 * Legacy book-publisher files may still live at data/us/ (see migrateLegacy).
 */
export function dataDir(country: string, categorySlug: string): string {
  return resolve(
    process.cwd(),
    "data",
    country.toLowerCase(),
    categorySlug.toLowerCase(),
  );
}

/** Legacy flat layout used by the original book-publisher harvest. */
export function legacyDataDir(country: string): string {
  return resolve(process.cwd(), "data", country.toLowerCase());
}

export function placesPath(country: string, categorySlug: string): string {
  return resolve(dataDir(country, categorySlug), "places.jsonl");
}

export function progressPath(country: string, categorySlug: string): string {
  return resolve(dataDir(country, categorySlug), "progress.json");
}

export function leadsPath(country: string, categorySlug: string): string {
  return resolve(dataDir(country, categorySlug), "leads.csv");
}

export function randomDelay(minMs = 400, maxMs = 1200): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((r) => setTimeout(r, ms));
}

/** All unique state/region codes for a country (for --states all). */
export function allStateCodes(country: string): string[] {
  const config = loadCountry(country);
  return [...new Set(config.tiles.map((t) => t.code))];
}
