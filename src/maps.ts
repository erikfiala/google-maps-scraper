import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { dataDir, randomDelay } from "./config.js";
import {
  appendPlace,
  fallbackPlaceKey,
  loadPlaceIdSet,
  loadProgress,
  saveProgress,
} from "./store.js";
import type { GeoTile, PlaceRecord, ScrapeOptions } from "./types.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function buildSearchUrl(tile: GeoTile, query: string): string {
  const q = encodeURIComponent(`${query} near ${tile.queryLocation}`);
  return `https://www.google.com/maps/search/${q}/@${tile.lat},${tile.lng},${tile.zoom}z`;
}

/** Extract a durable place id from Maps detail URL. */
export function extractPlaceId(url: string): string | null {
  // ChIJ-style place ids in !1s or query
  const chij = url.match(/!1s(ChIJ[\w-]+)/) ?? url.match(/[?&]place_id=(ChIJ[\w-]+)/);
  if (chij?.[1]) return chij[1];

  // Hex feature id pair: 0x...:0x...
  const hex = url.match(/!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/);
  if (hex?.[1]) return hex[1];

  // /maps/place/Name/@lat,lng or /maps/place/Name/data=
  const placePath = url.match(/\/maps\/place\/([^/@]+)/);
  if (placePath?.[1]) {
    try {
      return `path:${decodeURIComponent(placePath[1]).toLowerCase()}`;
    } catch {
      return `path:${placePath[1].toLowerCase()}`;
    }
  }

  return null;
}

async function dismissConsent(page: Page): Promise<void> {
  const candidates = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("I agree")',
    'button:has-text("Reject all")',
    'form[action*="consent"] button',
    '#L2AGLb',
  ];
  for (const sel of candidates) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click({ timeout: 2000 });
        await page.waitForTimeout(800);
        return;
      }
    } catch {
      // try next
    }
  }
}

/**
 * True only for real Google rate-limit /sorry/ interstitial URLs.
 * Must NOT match Maps place paths like /maps/place/Sorry...+Bookstore/...
 */
export function isGoogleSorryBlockUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    // google.com, www.google.com, ipv4.google.com, google.co.uk, etc.
    if (!/(^|\.)google\./i.test(host)) return false;
    const path = u.pathname.toLowerCase();
    // Pathname must be /sorry or /sorry/... — never a substring inside /maps/place/...
    return path === "/sorry" || path.startsWith("/sorry/");
  } catch {
    return false;
  }
}

async function detectCaptchaOrBlock(page: Page): Promise<boolean> {
  const url = page.url();
  // Consent interstitial is not a hard block — dismissConsent handles it.
  // Do not treat consent.google.com as CAPTCHA; only real /sorry/ rate-limit pages.
  if (isGoogleSorryBlockUrl(url)) {
    console.warn(`[maps] Block URL: ${url}`);
    return true;
  }
  // Visible reCAPTCHA / unusual traffic copy (avoid matching unrelated "captcha" in scripts
  // or place-name substrings in the URL).
  const unusual = page.getByText(/unusual traffic from your computer network/i);
  if (await unusual.isVisible().catch(() => false)) {
    console.warn(`[maps] Unusual traffic interstitial visible`);
    return true;
  }
  const captchaFrame = page.locator('iframe[src*="recaptcha"], #captcha-form, form#captcha');
  if (await captchaFrame.first().isVisible().catch(() => false)) {
    console.warn(`[maps] CAPTCHA widget visible at ${url}`);
    return true;
  }
  return false;
}

async function getFeed(page: Page) {
  // Results feed — role/aria is more durable than generated class names
  const feed = page.locator('div[role="feed"]').first();
  if (await feed.count()) return feed;
  return page.locator('div[aria-label*="Results"]').first();
}

async function scrollFeed(page: Page, maxScrolls: number): Promise<number> {
  const feed = await getFeed(page);
  if (!(await feed.count())) return 0;

  let stagnant = 0;
  let lastCount = 0;

  for (let i = 0; i < maxScrolls; i++) {
    const items = page.locator('div[role="feed"] > div > div[jsaction]');
    const count = await items.count().catch(async () => {
      return page.locator('a[href*="/maps/place/"]').count();
    });

    if (count === lastCount) stagnant += 1;
    else stagnant = 0;
    lastCount = count;

    const endMarker = page.getByText(/You've reached the end of the list/i);
    if (await endMarker.isVisible().catch(() => false)) break;
    if (stagnant >= 4) break;

    await feed.evaluate((el) => {
      const node = el as HTMLElement;
      node.scrollBy(0, node.scrollHeight);
    });
    await randomDelay(600, 1400);
  }

  return lastCount;
}

async function listResultLinks(page: Page): Promise<string[]> {
  const anchors = page.locator('a[href*="/maps/place/"]');
  const n = await anchors.count();
  const hrefs: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const href = await anchors.nth(i).getAttribute("href");
    if (!href) continue;
    const abs = href.startsWith("http")
      ? href
      : `https://www.google.com${href}`;
    const key = extractPlaceId(abs) ?? abs;
    if (seen.has(key)) continue;
    seen.add(key);
    hrefs.push(abs);
  }
  return hrefs;
}

function parseCityState(address: string | null): { city: string | null; state: string | null } {
  if (!address) return { city: null, state: null };
  // "... City, ST 12345" or "... City, ST"
  const m = address.match(/,\s*([^,]+),\s*([A-Z]{2})(?:\s+\d{5})?/);
  if (m) return { city: m[1].trim(), state: m[2] };
  const m2 = address.match(/,\s*([A-Z]{2})\s+\d{5}/);
  if (m2) return { city: null, state: m2[1] };
  return { city: null, state: null };
}

async function extractPlaceDetails(
  page: Page,
  tile: GeoTile,
  country: string,
  categoryLabel: string,
): Promise<PlaceRecord | null> {
  await page.waitForTimeout(500);

  const mapsUrl = page.url();
  let placeId = extractPlaceId(mapsUrl);

  // Name: h1 is typically the place title
  const name =
    (await page.locator("h1").first().innerText().catch(() => ""))?.trim() ||
    (await page.locator('[data-attrid="title"]').first().innerText().catch(() => ""))?.trim();
  if (!name || /results|google maps/i.test(name)) return null;

  // Website — prefer the dedicated website button/link
  let website: string | null = null;
  const websiteCandidates = [
    'a[data-item-id="authority"]',
    'a[aria-label^="Website"]',
    'a[aria-label*="Website"]',
  ];
  for (const sel of websiteCandidates) {
    const el = page.locator(sel).first();
    if (await el.count()) {
      const href = await el.getAttribute("href");
      if (href && /^https?:/i.test(href) && !/google\./i.test(href)) {
        website = href;
        break;
      }
    }
  }

  // Phone
  let phone: string | null = null;
  const phoneEl = page.locator('button[data-item-id^="phone:"], button[aria-label^="Phone"]').first();
  if (await phoneEl.count()) {
    const aria = (await phoneEl.getAttribute("aria-label")) ?? "";
    const fromAria = aria.replace(/^Phone:\s*/i, "").trim();
    const dataId = (await phoneEl.getAttribute("data-item-id")) ?? "";
    const fromData = dataId.replace(/^phone:\s*/i, "").trim();
    phone = fromAria || fromData || null;
  }

  // Address
  let address: string | null = null;
  const addrBtn = page
    .locator('button[data-item-id="address"], button[aria-label^="Address"]')
    .first();
  if (await addrBtn.count()) {
    const aria = (await addrBtn.getAttribute("aria-label")) ?? "";
    address = aria.replace(/^Address:\s*/i, "").trim() || null;
    if (!address) {
      address = (await addrBtn.innerText().catch(() => ""))?.trim() || null;
    }
  }

  // Category / type from Maps UI, fall back to our search label
  let category = categoryLabel;
  const catEl = page.locator('button[jsaction*="category"], button[jsaction*="pane.rating.category"]').first();
  if (await catEl.count()) {
    const t = (await catEl.innerText().catch(() => ""))?.trim();
    if (t) category = t;
  }

  if (!placeId) {
    placeId = fallbackPlaceKey(name, address);
  }

  const { city, state } = parseCityState(address);

  return {
    place_id: placeId,
    name,
    website,
    phone,
    address,
    city,
    state: state ?? tile.code,
    country: country.toUpperCase() === "US" ? "US" : country.toUpperCase(),
    maps_url: mapsUrl.split("&")[0],
    category,
    email: null,
    emails: [],
    tile_id: tile.id,
    scraped_at: new Date().toISOString(),
    enriched_at: null,
  };
}

async function scrapeQueryOnTile(
  page: Page,
  tile: GeoTile,
  query: string,
  opts: ScrapeOptions,
  knownIds: Set<string>,
  knownFallback: Set<string>,
): Promise<{ added: number; hitCaptcha: boolean }> {
  const url = buildSearchUrl(tile, query);
  console.log(`[maps] Tile ${tile.id} q="${query}": ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dismissConsent(page);
  await page.waitForTimeout(1500);

  if (await detectCaptchaOrBlock(page)) {
    console.error(`[maps] CAPTCHA/block detected on tile ${tile.id} q="${query}"`);
    return { added: 0, hitCaptcha: true };
  }

  // Wait for feed or empty state
  try {
    await page.waitForSelector('div[role="feed"], a[href*="/maps/place/"]', {
      timeout: 20_000,
    });
  } catch {
    console.warn(`[maps] No results feed for tile ${tile.id} q="${query}"`);
    return { added: 0, hitCaptcha: false };
  }

  const maxScrolls = opts.dryRun ? 2 : 25;
  await scrollFeed(page, maxScrolls);
  let links = await listResultLinks(page);
  if (opts.dryRun) links = links.slice(0, 5);
  else links = links.slice(0, opts.maxPerTile);

  console.log(`[maps] Tile ${tile.id} q="${query}": ${links.length} result links`);

  let added = 0;
  for (const href of links) {
    if (!opts.dryRun && knownIds.size >= opts.maxPlaces) break;

    const previewId = extractPlaceId(href);
    if (previewId && knownIds.has(previewId)) continue;

    try {
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await dismissConsent(page);
      // Consent pages sometimes linger; retry once after dismiss
      if (/consent\.google/i.test(page.url())) {
        await dismissConsent(page);
        await page.waitForTimeout(1000);
        if (/consent\.google/i.test(page.url())) {
          await page.goto(href, { waitUntil: "domcontentloaded", timeout: 45_000 });
        }
      }
      if (await detectCaptchaOrBlock(page)) {
        return { added, hitCaptcha: true };
      }

      const place = await extractPlaceDetails(
        page,
        tile,
        opts.country,
        opts.categoryLabel,
      );
      if (!place) continue;

      if (knownIds.has(place.place_id)) continue;
      const fb = fallbackPlaceKey(place.name, place.address);
      if (knownFallback.has(fb)) continue;

      knownIds.add(place.place_id);
      knownFallback.add(fb);

      if (!opts.dryRun) {
        appendPlace(opts.country, opts.categorySlug, place);
      } else {
        console.log(`[dry-run] ${place.name} | ${place.website ?? "-"} | ${place.phone ?? "-"} | ${place.address ?? "-"}`);
        // Keep dry-run bounded: cap the in-memory set at maxPlaces so the
        // `knownIds.size >= opts.maxPlaces` guard works without writing.
        if (knownIds.size >= opts.maxPlaces) break;
      }
      added += 1;
      // Slower pacing reduces /sorry/ rate-limits on sustained runs
      await randomDelay(1200, 2800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[maps] Failed place on ${tile.id}: ${msg}`);
      await randomDelay(1500, 3000);
    }
  }

  return { added, hitCaptcha: false };
}

async function scrapeTile(
  page: Page,
  tile: GeoTile,
  opts: ScrapeOptions,
  knownIds: Set<string>,
  knownFallback: Set<string>,
): Promise<{ added: number; hitCaptcha: boolean }> {
  let added = 0;
  for (const query of opts.searchQueries) {
    if (!opts.dryRun && knownIds.size >= opts.maxPlaces) break;
    const result = await scrapeQueryOnTile(
      page,
      tile,
      query,
      opts,
      knownIds,
      knownFallback,
    );
    added += result.added;
    if (result.hitCaptcha) return { added, hitCaptcha: true };
    await randomDelay(800, 1600);
  }
  return { added, hitCaptcha: false };
}

export async function runScrape(
  tiles: GeoTile[],
  opts: ScrapeOptions,
): Promise<{ placeCount: number; tilesDone: number; captcha: boolean }> {
  const progress = loadProgress(opts.country, opts.categorySlug);
  const knownIds = loadPlaceIdSet(opts.country, opts.categorySlug);
  const knownFallback = new Set<string>();

  // Seed fallback keys from existing places
  for (const id of knownIds) {
    // ids may already be path: or name|addr — fine
    knownFallback.add(id);
  }

  // File lock so enrichment can pause scrape without racing progress.json writers.
  // Created by enrich (see enrich.ts); checked here so a concurrent enrich run
  // does not get its rewritePlaces() output wiped by stale scrape appends.

  if (progress.pausedForCaptcha) {
    // Manual hold — do not auto-clear.
    if (progress.pausedTileId === "HOLD-FOR-ENRICH") {
      console.error(
        `[maps] pausedForCaptcha is held (HOLD-FOR-ENRICH). ` +
          `Clear pausedTileId/pausedForCaptcha in progress.json to resume scraping.`,
      );
      return { placeCount: knownIds.size, tilesDone: 0, captcha: true };
    }
    console.log(
      `[maps] Resuming after CAPTCHA pause (was on tile ${progress.pausedTileId ?? "?"}). ` +
        `Waiting 45s cool-down, then clearing pause flag.`,
    );
    await new Promise((r) => setTimeout(r, 45_000));
    progress.pausedForCaptcha = false;
    progress.pausedTileId = null;
    progress.lastError = null;
    saveProgress(opts.country, opts.categorySlug, progress);
  }

  const pending = tiles.filter((t) => !progress.completedTiles.includes(t.id));

  // Mutual exclusion with enrich: scrape writes .scrape_lock for its whole run
  // and refuses to start while .enrich_lock exists; enrich writes .enrich_lock
  // and refuses to start while .scrape_lock exists. Prevents checkpointPlaces()
  // (rewritePlaces) in enrich from wiping appends made by a concurrent scrape.
  const dataRoot = dataDir(opts.country, opts.categorySlug);
  const selfLock = resolve(dataRoot, ".scrape_lock");
  const enrichLock = resolve(dataRoot, ".enrich_lock");
  if (existsSync(enrichLock)) {
    console.error(
      `[maps] Enrich lock present (${enrichLock}). Remove it to resume scraping.`,
    );
    return { placeCount: knownIds.size, tilesDone: 0, captcha: true };
  }
  if (!opts.dryRun) writeFileSync(selfLock, String(process.pid), "utf8");
  console.log(
    `[maps] category=${opts.categorySlug} queries=[${opts.searchQueries.join(" | ")}] ` +
      `${pending.length} tiles pending (${progress.completedTiles.length} done), ` +
      `${knownIds.size} places already saved, max=${opts.maxPlaces}`,
  );

  let browser: Browser | null = null;
  let tilesDone = 0;
  let captcha = false;
  let lockRemoved = false;

  const removeLocks = () => {
    if (lockRemoved) return;
    lockRemoved = true;
    for (const f of [selfLock, enrichLock]) {
      try {
        if (existsSync(f)) rmSync(f);
      } catch {
        // best-effort; stale locks are documented in README
      }
    }
  };

  try {
    browser = await chromium.launch({
      headless: !opts.headed,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: "en-US",
      viewport: { width: 1440, height: 900 },
      geolocation: tiles[0]
        ? { latitude: tiles[0].lat, longitude: tiles[0].lng }
        : undefined,
      permissions: ["geolocation"],
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();

    for (const tile of pending) {
      if (!opts.dryRun && knownIds.size >= opts.maxPlaces) {
        console.log(`[maps] Global max-places ${opts.maxPlaces} reached`);
        break;
      }

      const { added, hitCaptcha } = await scrapeTile(
        page,
        tile,
        opts,
        knownIds,
        knownFallback,
      );
      console.log(`[maps] Tile ${tile.id}: +${added} places (total ${knownIds.size})`);

      if (hitCaptcha) {
        captcha = true;
        progress.pausedForCaptcha = true;
        progress.pausedTileId = tile.id;
        progress.lastError = `CAPTCHA or block on tile ${tile.id}`;
        progress.placeCount = knownIds.size;
        saveProgress(opts.country, opts.categorySlug, progress);
        console.error(
          `[maps] Paused. Re-run with --headed to resolve, then resume (completed tiles are skipped).`,
        );
        break;
      }

      if (!opts.dryRun) {
        progress.completedTiles.push(tile.id);
        progress.placeCount = knownIds.size;
        progress.lastError = null;
        saveProgress(opts.country, opts.categorySlug, progress);
      }
      tilesDone += 1;

      await randomDelay(1000, 2200);
    }
  } finally {
    await browser?.close();
    if (!opts.dryRun) removeLocks();
  }

  return { placeCount: knownIds.size, tilesDone, captcha };
}
