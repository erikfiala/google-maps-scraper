import * as cheerio from "cheerio";
import { CONTACT_PATHS, isFieldEnabled, randomDelay } from "./config.js";
import { loadPlaces, rewritePlaces } from "./store.js";
import type { EnrichOptions, PlaceRecord } from "./types.js";

const EMAIL_RE =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const JUNK_LOCAL = /^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|webmaster|abuse|spam)$/i;
const JUNK_EXT = /\.(png|jpe?g|gif|svg|webp|css|js|ico|woff2?|ttf|eot|pdf|mp[34]|wav|zip)$/i;
const JUNK_DOMAIN =
  /(^|\.)(example\.com|email\.com|domain\.com|yourdomain\.com|sentry\.io|wixpress\.com|sentry-next\.wixpress\.com)$/i;

export function isValidEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  if (!e.includes("@") || e.length > 254) return false;
  if (e.startsWith("?") || e.includes("..")) return false;
  if (JUNK_EXT.test(e)) return false;
  const [local, domain] = e.split("@");
  if (!local || !domain) return false;
  if (JUNK_LOCAL.test(local)) return false;
  if (JUNK_DOMAIN.test(domain)) return false;
  if (local.endsWith(".png") || local.endsWith(".jpg")) return false;
  // filter common template placeholders
  if (/\{|\}|%|<|>/.test(e)) return false;
  return true;
}

export function extractEmailsFromHtml(html: string): string[] {
  const found = new Set<string>();
  const $ = cheerio.load(html);

  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const raw = href.replace(/^mailto:/i, "").split("?")[0];
    for (const part of raw.split(/[;,]/)) {
      const e = part.trim().toLowerCase();
      if (isValidEmail(e)) found.add(e);
    }
  });

  const text = $.root().text() + "\n" + html;
  for (const m of text.matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase();
    if (isValidEmail(e)) found.add(e);
  }

  return [...found];
}

function normalizeWebsite(url: string): string | null {
  let u = url.trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try {
    const parsed = new URL(u);
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, ""));
  } catch {
    return null;
  }
}

async function fetchHtml(url: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct && !/text\/html|application\/xhtml/i.test(ct)) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function enrichPlace(
  place: PlaceRecord,
  opts: EnrichOptions,
): Promise<PlaceRecord> {
  if (!place.website) {
    return { ...place, enriched_at: new Date().toISOString() };
  }
  const base = normalizeWebsite(place.website);
  if (!base) {
    return { ...place, enriched_at: new Date().toISOString() };
  }

  const emails = new Set<string>();
  const urls = [base, ...CONTACT_PATHS.map((p) => {
    try {
      return new URL(p, base.endsWith("/") ? base : `${base}/`).toString();
    } catch {
      return null;
    }
  }).filter((u): u is string => Boolean(u))];

  // Dedupe URL strings
  const uniqueUrls = [...new Set(urls)];

  for (const url of uniqueUrls) {
    const html = await fetchHtml(url, opts.timeoutMs);
    if (!html) continue;
    for (const e of extractEmailsFromHtml(html)) emails.add(e);
    // early exit if we already have a good contact email
    if (emails.size >= 3) break;
    await randomDelay(100, 300);
  }

  const list = [...emails];
  // Prefer non-generic local parts
  const preferred =
    list.find((e) => /^(info|contact|hello|publish|submissions?|editorial|press|rights)@/i.test(e)) ??
    list[0] ??
    null;

  return {
    ...place,
    emails: list,
    email: preferred,
    enriched_at: new Date().toISOString(),
  };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function checkpointPlaces(
  country: string,
  categorySlug: string,
  places: PlaceRecord[],
  updatedById: Map<string, PlaceRecord>,
): PlaceRecord[] {
  // Re-read disk so concurrent scrapes' appends are not wiped by a stale in-memory list.
  const onDisk = loadPlaces(country, categorySlug);
  const byId = new Map<string, PlaceRecord>();
  for (const p of onDisk) byId.set(p.place_id, p);
  // Keep any in-memory rows not yet flushed (shouldn't happen, but safe).
  for (const p of places) {
    if (!byId.has(p.place_id)) byId.set(p.place_id, p);
  }
  for (const [id, updated] of updatedById) {
    const prev = byId.get(id);
    byId.set(id, prev ? { ...prev, ...updated } : updated);
  }
  const merged = [...byId.values()];
  rewritePlaces(country, categorySlug, merged);
  // Mutate caller's array reference length is unused; return authoritative merge.
  places.length = 0;
  places.push(...merged);
  return merged;
}

export async function runEnrich(opts: EnrichOptions): Promise<{
  total: number;
  enriched: number;
  withEmail: number;
  skipped?: boolean;
}> {
  if (!isFieldEnabled("email")) {
    console.log(
      `[enrich] Skipping: fields.email is false in config/scraper.json`,
    );
    return { total: 0, enriched: 0, withEmail: 0, skipped: true };
  }

  const places = loadPlaces(opts.country, opts.categorySlug);
  if (!places.length) {
    console.log(
      `[enrich] No places in data/${opts.country}/${opts.categorySlug}/places.jsonl — run scrape first`,
    );
    return { total: 0, enriched: 0, withEmail: 0 };
  }

  const needsWork = places.filter((p) => !p.enriched_at);
  console.log(
    `[enrich] category=${opts.categorySlug} ${places.length} places, ` +
      `${needsWork.length} need enrichment (concurrency=${opts.concurrency})`,
  );

  let done = 0;
  const updatedById = new Map<string, PlaceRecord>();
  const CHECKPOINT_EVERY = 25;

  // undici can throw AssertionError on abrupt socket close outside fetch()'s promise
  const onUncaught = (err: unknown) => {
    const e = err as { code?: string; stack?: string; message?: string };
    if (e?.code === "ERR_ASSERTION" && String(e.stack ?? "").includes("undici")) {
      console.warn(`[enrich] Ignoring undici socket assertion: ${e.message ?? err}`);
      return;
    }
    console.error(err);
    process.exit(1);
  };
  process.on("uncaughtException", onUncaught);

  try {
    await mapPool(needsWork, opts.concurrency, async (place) => {
      let updated: PlaceRecord;
      try {
        updated = await enrichPlace(place, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[enrich] Failed ${place.name}: ${msg}`);
        updated = { ...place, enriched_at: new Date().toISOString() };
      }
      updatedById.set(place.place_id, updated);
      done += 1;
      if (done % CHECKPOINT_EVERY === 0 || done === needsWork.length) {
        checkpointPlaces(opts.country, opts.categorySlug, places, updatedById);
        console.log(
          `[enrich] ${done}/${needsWork.length} (emails: ${updated.email ?? "-"} for ${updated.name})`,
        );
      }
      return updated;
    });
  } finally {
    process.off("uncaughtException", onUncaught);
  }

  const merged = checkpointPlaces(opts.country, opts.categorySlug, places, updatedById);
  const withEmail = merged.filter((p) => p.email).length;
  console.log(
    `[enrich] Done. ${withEmail}/${merged.length} places have email ` +
      `(${merged.length ? ((withEmail / merged.length) * 100).toFixed(1) : 0}%)`,
  );

  return { total: merged.length, enriched: needsWork.length, withEmail };
}
