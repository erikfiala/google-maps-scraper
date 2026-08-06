export interface GeoTile {
  /** Unique tile id, e.g. "CA" or "CA-sf" */
  id: string;
  /** State / region code used for --states filtering */
  code: string;
  name: string;
  /** Human-readable location appended to Maps search */
  queryLocation: string;
  lat: number;
  lng: number;
  zoom: number;
}

export interface CountryConfig {
  country: string;
  countryName: string;
  tiles: GeoTile[];
}

export interface PlaceRecord {
  place_id: string;
  name: string;
  website: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string;
  maps_url: string;
  category: string;
  email: string | null;
  emails: string[];
  tile_id: string;
  scraped_at: string;
  enriched_at: string | null;
}

export interface ProgressState {
  country: string;
  category?: string;
  completedTiles: string[];
  placeCount: number;
  updatedAt: string;
  lastError: string | null;
  pausedForCaptcha: boolean;
  pausedTileId: string | null;
}

export interface ScrapeOptions {
  country: string;
  /** Category folder slug, e.g. marketing-agency */
  categorySlug: string;
  /** Maps search phrases tried per tile (in order) */
  searchQueries: string[];
  /** Label written onto PlaceRecord.category fallback */
  categoryLabel: string;
  states?: string[];
  maxPlaces: number;
  maxPerTile: number;
  headed: boolean;
  dryRun: boolean;
}

export interface EnrichOptions {
  country: string;
  categorySlug: string;
  concurrency: number;
  timeoutMs: number;
}

/** Output / export field keys (fixed order). */
export type FieldKey =
  | "name"
  | "email"
  | "phone"
  | "address"
  | "website"
  | "category"
  | "maps_url"
  | "place_id"
  | "city"
  | "state"
  | "country";

export type FieldsConfig = Record<FieldKey, boolean>;

export interface CategoryConfig {
  slug: string;
  enabled: boolean;
  label: string;
  queries: string[];
}

export interface ScraperConfig {
  fields: FieldsConfig;
  search: {
    country: string;
    categories: CategoryConfig[];
  };
}
