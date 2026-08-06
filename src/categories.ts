/**
 * Maps search categories — loaded from config/scraper.json.
 * Each slug gets its own data/<country>/<slug>/ tree.
 * `queries` are durable Google Maps search phrases (tried in order per tile).
 */

import { loadScraperConfig } from "./scraper_config.js";
import type { CategoryConfig } from "./types.js";

export interface CategoryDef {
  /** Folder slug under data/<country>/ */
  slug: string;
  /** Human label stored on records / logs */
  label: string;
  /** Google Maps search phrases for this category */
  queries: string[];
  /** Whether pipeline runs this category when --category is omitted */
  enabled: boolean;
}

function toDef(c: CategoryConfig): CategoryDef {
  return {
    slug: c.slug,
    label: c.label,
    queries: c.queries,
    enabled: Boolean(c.enabled),
  };
}

function categoryMap(): Record<string, CategoryDef> {
  const cfg = loadScraperConfig();
  const map: Record<string, CategoryDef> = {};
  for (const c of cfg.search.categories) {
    map[c.slug] = toDef(c);
  }
  return map;
}

/** All categories from config (enabled and disabled). */
export function getCategories(): Record<string, CategoryDef> {
  return categoryMap();
}

/** Pipeline order = config order, enabled categories only. */
export function getPipelineOrder(): string[] {
  const cfg = loadScraperConfig();
  return cfg.search.categories.filter((c) => c.enabled).map((c) => c.slug);
}

/** First enabled category, or first listed, or marketing-agency. */
export function getDefaultCategorySlug(): string {
  const cfg = loadScraperConfig();
  const enabled = cfg.search.categories.find((c) => c.enabled);
  if (enabled) return enabled.slug;
  if (cfg.search.categories[0]) return cfg.search.categories[0].slug;
  return "marketing-agency";
}

export function resolveCategory(input: string): CategoryDef {
  const categories = categoryMap();
  const raw = input.trim().toLowerCase();
  if (categories[raw]) return categories[raw];

  for (const cat of Object.values(categories)) {
    if (cat.label === raw || cat.queries.some((q) => q.toLowerCase() === raw)) {
      return cat;
    }
  }

  const slug = raw
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (categories[slug]) return categories[slug];

  throw new Error(
    `Unknown category "${input}". Known: ${Object.keys(categories).join(", ")}. ` +
      `Add or enable categories in config/scraper.json.`,
  );
}

export function listCategorySlugs(): string[] {
  return Object.keys(categoryMap());
}

export function listEnabledCategorySlugs(): string[] {
  return getPipelineOrder();
}
