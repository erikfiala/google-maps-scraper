import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FieldKey, FieldsConfig, ScraperConfig } from "./types.js";

/** Fixed export column order — only enabled fields appear in CSV. */
export const FIELD_ORDER: FieldKey[] = [
  "name",
  "email",
  "phone",
  "address",
  "website",
  "category",
  "maps_url",
  "place_id",
  "city",
  "state",
  "country",
];

const DEFAULT_FIELDS: FieldsConfig = {
  name: true,
  email: true,
  phone: false,
  address: false,
  website: false,
  category: true,
  maps_url: false,
  place_id: false,
  city: false,
  state: false,
  country: false,
};

let cachedConfig: ScraperConfig | null = null;

export function scraperConfigPath(): string {
  return resolve(process.cwd(), "config", "scraper.json");
}

export function loadScraperConfig(): ScraperConfig {
  if (cachedConfig) return cachedConfig;

  const path = scraperConfigPath();
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path}. Create config/scraper.json (see README).`,
    );
  }

  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ScraperConfig>;
  const fields: FieldsConfig = { ...DEFAULT_FIELDS, ...(raw.fields ?? {}) };
  const categories = raw.search?.categories ?? [];
  if (!categories.length) {
    throw new Error(
      `config/scraper.json must define search.categories[] with at least one category.`,
    );
  }

  cachedConfig = {
    fields,
    search: {
      country: (raw.search?.country ?? "us").toLowerCase(),
      categories,
    },
  };
  return cachedConfig;
}

/** Clear cached config (useful in tests). */
export function resetScraperConfigCache(): void {
  cachedConfig = null;
}

export function getFieldsConfig(): FieldsConfig {
  return loadScraperConfig().fields;
}

export function isFieldEnabled(key: FieldKey): boolean {
  return Boolean(getFieldsConfig()[key]);
}

/** Enabled fields in fixed FIELD_ORDER. */
export function getEnabledExportFields(): FieldKey[] {
  const fields = getFieldsConfig();
  return FIELD_ORDER.filter((k) => fields[k]);
}
