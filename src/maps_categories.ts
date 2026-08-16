/**
 * Searchable catalog of Google Places / Maps categories.
 * Source: config/google_maps_categories.json (Places API Place Types).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface MapsCategory {
  id: string;
  label: string;
  group: string;
  table: "A" | "B" | string;
  slug: string;
  suggestedQueries: string[];
  note?: string;
}

export interface MapsCategoryCatalog {
  source: string;
  sourceUrl: string;
  updated: string;
  description: string;
  count: number;
  groups: string[];
  categories: MapsCategory[];
}

let cached: MapsCategoryCatalog | null = null;

export function mapsCategoriesPath(): string {
  return resolve(process.cwd(), "config", "google_maps_categories.json");
}

export function loadMapsCategoryCatalog(): MapsCategoryCatalog {
  if (cached) return cached;
  const path = mapsCategoriesPath();
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path}. Restore config/google_maps_categories.json from the repo.`,
    );
  }
  cached = JSON.parse(readFileSync(path, "utf8")) as MapsCategoryCatalog;
  return cached;
}

export function resetMapsCategoryCatalogCache(): void {
  cached = null;
}

export function listMapsCategoryGroups(): string[] {
  return loadMapsCategoryCatalog().groups;
}

export function listMapsCategories(opts?: {
  group?: string;
  table?: string;
}): MapsCategory[] {
  let cats = loadMapsCategoryCatalog().categories;
  if (opts?.group) {
    const g = opts.group.trim().toLowerCase();
    cats = cats.filter(
      (c) =>
        c.group.toLowerCase() === g ||
        c.group.toLowerCase().includes(g),
    );
  }
  if (opts?.table) {
    const t = opts.table.trim().toUpperCase();
    cats = cats.filter((c) => String(c.table).toUpperCase() === t);
  }
  return cats;
}

/** Substring search across id, label, group, slug, and suggested queries. */
export function searchMapsCategories(query: string, limit = 50): MapsCategory[] {
  const q = query.trim().toLowerCase();
  if (!q) return listMapsCategories().slice(0, limit);

  const scored: { cat: MapsCategory; score: number }[] = [];
  for (const cat of loadMapsCategoryCatalog().categories) {
    const hay = [
      cat.id,
      cat.label,
      cat.group,
      cat.slug,
      ...cat.suggestedQueries,
    ]
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q)) continue;

    let score = 0;
    if (cat.id === q || cat.slug === q) score += 100;
    else if (cat.id.includes(q) || cat.slug.includes(q)) score += 40;
    if (cat.label.toLowerCase() === q) score += 80;
    else if (cat.label.toLowerCase().includes(q)) score += 30;
    if (cat.suggestedQueries.some((s) => s.toLowerCase() === q)) score += 50;
    else if (cat.suggestedQueries.some((s) => s.toLowerCase().includes(q)))
      score += 20;
    if (cat.group.toLowerCase().includes(q)) score += 10;
    scored.push({ cat, score: score || 1 });
  }

  scored.sort(
    (a, b) => b.score - a.score || a.cat.label.localeCompare(b.cat.label),
  );
  return scored.slice(0, limit).map((s) => s.cat);
}

/** Example scraper.json category object for a Maps type. */
export function categoryConfigSnippet(cat: MapsCategory): string {
  return JSON.stringify(
    {
      slug: cat.slug,
      enabled: true,
      label: cat.label.toLowerCase(),
      queries: cat.suggestedQueries,
    },
    null,
    2,
  );
}
