/**
 * Geo tagging service.
 * Resolves GPS coordinates to administrative regions (country / state / LGA)
 * and place names to coordinates, with in-memory caching + light throttling.
 *
 * Providers:
 *  1. OpenStreetMap Nominatim (primary — reliable, returns LGA as `county`,
 *     throttled to comply with the 1 req/sec usage policy)
 *  2. BigDataCloud free client endpoint (fallback, no API key required)
 */

export interface RegionInfo {
  country?: string;
  state?: string;
  /** LGA / county level */
  lga?: string;
  /** Neighborhood / district level (e.g. "Gwarinpa") */
  area?: string;
}

/**
 * Known naming variants between administrative registries (onboarding lists)
 * and geocoders. Keys are lowercased. Used to broaden dashboard queries so
 * tagged reports never disappear due to spelling variants.
 */
const REGION_ALIASES: Record<string, string[]> = {
  'fct - abuja': [
    'federal capital territory',
    'abuja federal capital territory',
    'federal capital territory (fct)',
    'abuja',
    'fct',
  ],
  'federal capital territory': [
    'fct - abuja',
    'abuja federal capital territory',
    'abuja',
    'fct',
  ],
  'abuja federal capital territory': [
    'fct - abuja',
    'federal capital territory',
    'abuja',
    'fct',
  ],
};

/**
 * Known naming variants between the onboarding LGA lists and geocoders.
 * OpenStreetMap reports Abuja's "Abuja Municipal" as "Municipal Area Council",
 * which used to hide every report from Local Admin dashboards on a strict match.
 */
const LGA_ALIASES: Record<string, string[]> = {
  'abuja municipal': [
    'abuja municipal lga',
    'municipal area council',
    'abuja municipal area council',
  ],
  'municipal area council': [
    'abuja municipal',
    'abuja municipal lga',
    'abuja municipal area council',
  ],
};

/** Expand a region name into all accepted variants (original included). */
export function expandRegionName(name?: string | null): string[] {
  if (!name) return [];
  const norm = name.trim().toLowerCase();
  const variants = new Set<string>([name]);
  for (const [key, aliases] of Object.entries(REGION_ALIASES)) {
    if (norm === key || aliases.some((a) => a.toLowerCase() === norm)) {
      variants.add(key);
      aliases.forEach((a) => variants.add(a));
    }
  }
  return [...variants];
}

/** Same as expandRegionName but for LGA-level names. */
export function expandLgaName(name?: string | null): string[] {
  if (!name) return [];
  const norm = name.trim().toLowerCase();
  const variants = new Set<string>([name]);
  for (const [key, aliases] of Object.entries(LGA_ALIASES)) {
    if (norm === key || aliases.some((a) => a.toLowerCase() === norm)) {
      variants.add(key);
      aliases.forEach((a) => variants.add(a));
    }
  }
  return [...variants];
}

const BDC_BASE = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'GeoAlert/1.0 (emergency-response-dashboard)';
const FETCH_TIMEOUT_MS = 6000;

// Simple caches so repeated lookups don't hammer providers
const reverseCache = new Map<string, RegionInfo | null>();
const forwardCache = new Map<string, [number, number] | null>();

let lastNominatimSlot = 0;

/**
 * Claim the next available Nominatim slot (1 req/sec policy).
 * Safe under concurrency — each caller reserves a distinct time slot.
 */
async function throttle(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(lastNominatimSlot + 1100, now);
  lastNominatimSlot = slot;
  const wait = slot - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function roundCoord(n: number): number {
  return Math.round(n * 500) / 500; // ~50m precision cache buckets
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Reverse geocode lat/lng into { country, state, lga }. Returns null on failure. */
export async function reverseGeocode(lat: number, lng: number): Promise<RegionInfo | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const key = `${roundCoord(lat)},${roundCoord(lng)}`;
  if (reverseCache.has(key)) return reverseCache.get(key)!;

  let region: RegionInfo | null = null;

  // 1) Nominatim (zoom=16 → neighborhood detail, still includes county/LGA)
  await throttle();
  const nom = await fetchJson(
    `${NOMINATIM_REVERSE}?format=json&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`,
    { 'User-Agent': USER_AGENT }
  );
  if (nom?.address) {
    const a = nom.address;
    region = {
      country: a.country || undefined,
      state: a.state || a.region || undefined,
      lga: a.county || a.municipality || a.city || a.town || undefined,
      area:
        a.neighbourhood ||
        a.suburb ||
        a.quarter ||
        a.city_district ||
        a.hamlet ||
        a.village ||
        a.township ||
        undefined,
    };
    if (!region.country && !region.state && !region.lga) region = null;
  }

  // 2) BigDataCloud fallback
  if (!region) {
    const d = await fetchJson(
      `${BDC_BASE}?latitude=${lat}&longitude=${lng}&localityLanguage=en`
    );
    if (d) {
      region = {
        country: d.countryName || undefined,
        state: d.principalSubdivision || undefined,
        lga: d.city || d.locality || undefined,
      };
      if (!region.country && !region.state && !region.lga) region = null;
    }
  }

  reverseCache.set(key, region);
  return region;
}

/** Forward geocode a place name (optionally qualified by country) to [lat, lng]. */
export async function geocodePlace(name: string, country?: string): Promise<[number, number] | null> {
  if (!name) return null;
  const key = `${name}|${country || ''}`;
  if (forwardCache.has(key)) return forwardCache.get(key)!;

  let coords: [number, number] | null = null;
  await throttle();
  const d = await fetchJson(
    `${NOMINATIM_SEARCH}?format=json&q=${encodeURIComponent(country ? `${name}, ${country}` : name)}&limit=1`,
    { 'User-Agent': USER_AGENT }
  );
  if (Array.isArray(d) && d.length > 0) {
    const lat = parseFloat(d[0].lat);
    const lng = parseFloat(d[0].lon);
    if (Number.isFinite(lat) && Number.isFinite(lng)) coords = [lat, lng];
  }

  forwardCache.set(key, coords);
  return coords;
}
