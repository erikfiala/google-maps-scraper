import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  dataDir,
  getEnabledExportFields,
  isFieldEnabled,
  leadsPath,
  legacyDataDir,
  placesPath,
  progressPath,
} from "./config.js";
import type { FieldKey, PlaceRecord, ProgressState } from "./types.js";

export function ensureDataDir(country: string, categorySlug: string): void {
  mkdirSync(dataDir(country, categorySlug), { recursive: true });
}

/**
 * If category is book-publisher and the new subfolder is empty but legacy
 * data/us/{places,progress,leads} exists, copy into book-publisher/ without
 * deleting the legacy files.
 */
export function migrateLegacyBookPublisher(country: string): void {
  const slug = "book-publisher";
  const destPlaces = placesPath(country, slug);
  if (existsSync(destPlaces)) return;

  const legacy = legacyDataDir(country);
  const srcPlaces = resolveJoin(legacy, "places.jsonl");
  if (!existsSync(srcPlaces)) return;

  ensureDataDir(country, slug);
  console.log(
    `[store] Migrating legacy ${country} book-publisher data → data/${country}/${slug}/ (originals kept)`,
  );
  copyFileSync(srcPlaces, destPlaces);
  for (const name of ["progress.json", "leads.csv"] as const) {
    const src = resolveJoin(legacy, name);
    if (existsSync(src)) {
      copyFileSync(src, resolveJoin(dataDir(country, slug), name));
    }
  }
}

function resolveJoin(dir: string, name: string): string {
  return `${dir}/${name}`;
}

export function loadPlaces(country: string, categorySlug: string): PlaceRecord[] {
  const path = placesPath(country, categorySlug);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const places: PlaceRecord[] = [];
  for (const line of lines) {
    try {
      places.push(JSON.parse(line) as PlaceRecord);
    } catch {
      console.warn(`[store] Skipping malformed JSONL line`);
    }
  }
  return places;
}

export function loadPlaceIdSet(country: string, categorySlug: string): Set<string> {
  return new Set(loadPlaces(country, categorySlug).map((p) => p.place_id));
}

export function appendPlace(
  country: string,
  categorySlug: string,
  place: PlaceRecord,
): void {
  ensureDataDir(country, categorySlug);
  appendFileSync(placesPath(country, categorySlug), `${JSON.stringify(place)}\n`, "utf8");
}

export function rewritePlaces(
  country: string,
  categorySlug: string,
  places: PlaceRecord[],
): void {
  ensureDataDir(country, categorySlug);
  const body = places.map((p) => JSON.stringify(p)).join("\n");
  writeFileSync(placesPath(country, categorySlug), body ? `${body}\n` : "", "utf8");
}

export function defaultProgress(country: string, categorySlug: string): ProgressState {
  return {
    country: country.toLowerCase(),
    category: categorySlug,
    completedTiles: [],
    placeCount: 0,
    updatedAt: new Date().toISOString(),
    lastError: null,
    pausedForCaptcha: false,
    pausedTileId: null,
  };
}

export function loadProgress(country: string, categorySlug: string): ProgressState {
  const path = progressPath(country, categorySlug);
  if (!existsSync(path)) return defaultProgress(country, categorySlug);
  try {
    const p = JSON.parse(readFileSync(path, "utf8")) as ProgressState;
    if (!p.category) p.category = categorySlug;
    return p;
  } catch {
    return defaultProgress(country, categorySlug);
  }
}

export function saveProgress(
  country: string,
  categorySlug: string,
  progress: ProgressState,
): void {
  ensureDataDir(country, categorySlug);
  progress.category = categorySlug;
  progress.updatedAt = new Date().toISOString();
  writeFileSync(progressPath(country, categorySlug), JSON.stringify(progress, null, 2), "utf8");
}

function csvEscape(value: string | null | undefined): string {
  const s = value ?? "";
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function fieldValue(
  place: PlaceRecord,
  key: FieldKey,
  categoryValue: string,
): string {
  switch (key) {
    case "name":
      return place.name ?? "";
    case "email":
      return place.email ?? "";
    case "phone":
      return place.phone ?? "";
    case "address":
      return place.address ?? "";
    case "website":
      return place.website ?? "";
    case "category":
      return categoryValue;
    case "maps_url":
      return place.maps_url ?? "";
    case "place_id":
      return place.place_id ?? "";
    case "city":
      return place.city ?? "";
    case "state":
      return place.state ?? "";
    case "country":
      return place.country ?? "";
    default:
      return "";
  }
}

/**
 * Export CSV with columns = enabled fields from config/scraper.json (fixed order).
 * When `fields.email` is true, only rows with a non-empty email are written.
 * When `fields.email` is false, all places are exported.
 */
export function exportCsv(
  country: string,
  categorySlug: string,
  /** Maps harvest category written on every lead row (slug or label). */
  categoryColumn?: string,
): { path: string; count: number; withEmail: number; columns: FieldKey[] } {
  const places = loadPlaces(country, categorySlug);
  const columns = getEnabledExportFields();
  if (!columns.length) {
    throw new Error(
      "No export fields enabled. Set at least one fields.* to true in config/scraper.json.",
    );
  }

  const requireEmail = isFieldEnabled("email");
  const rows = requireEmail
    ? places.filter((p) => Boolean(p.email?.trim()))
    : places;

  ensureDataDir(country, categorySlug);
  const path = leadsPath(country, categorySlug);
  const categoryValue = categoryColumn ?? categorySlug;
  const lines = [columns.join(",")];
  for (const p of rows) {
    lines.push(columns.map((k) => csvEscape(fieldValue(p, k, categoryValue))).join(","));
  }
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  const withEmail = places.filter((p) => Boolean(p.email?.trim())).length;
  return {
    path,
    count: rows.length,
    withEmail,
    columns,
  };
}

/** Normalize name+address fallback key when place_id is missing. */
export function fallbackPlaceKey(name: string, address: string | null): string {
  const n = name.trim().toLowerCase().replace(/\s+/g, " ");
  const a = (address ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${n}|${a}`;
}
