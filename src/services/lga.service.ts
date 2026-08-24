import mongoose from 'mongoose';
import { GeoPlace } from '../models/GeoPlace';
import { geocodePlace, expandRegionName } from './geo.service';
import { NIGERIA_LGAS } from '../data/nigeriaLGAs';

const CN_CITIES_URL = 'https://countriesnow.space/api/v0.1/countries/state/cities';

function normKey(value?: string | null): string {
  return (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

const sortNames = (items: string[]): string[] =>
  [...new Set(items.map((i) => i.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

// Never let a missing/disconnected DB hang or fail list resolution
const dbReady = (): boolean => mongoose.connection.readyState === 1;

async function readListCache(key: string): Promise<string[] | null> {
  if (!dbReady()) return null;
  try {
    const doc = await GeoPlace.findOne({ key }).lean<{ items?: string[] }>();
    return doc?.items?.length ? doc.items.map(String) : null;
  } catch {
    return null;
  }
}

async function writeCache(payload: Record<string, unknown>): Promise<void> {
  if (!dbReady()) return;
  try {
    await GeoPlace.updateOne({ key: payload.key as string }, payload as Record<string, any>, {
      upsert: true,
    });
  } catch {
    /* cache writes are best-effort */
  }
}

function findStaticNigeriaList(state: string): string[] | null {
  const wanted = expandRegionName(state).map(normKey);
  const entry = Object.entries(NIGERIA_LGAS).find(([k]) => wanted.includes(normKey(k)));
  return entry ? sortNames(entry[1]) : null;
}

async function fetchCitiesOnline(country: string, state: string): Promise<string[] | null> {
  try {
    const res = await fetch(CN_CITIES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country, state }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    if (!Array.isArray(json?.data)) return null;
    const names = json.data.filter((c: unknown) => typeof c === 'string' && c.trim());
    return names.length ? sortNames(names as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * All known LGAs/provinces for a country+state.
 * Order of preference: Mongo cache -> static Nigeria directory ->
 * countriesnow.space API (result cached either way).
 */
export async function getAreaList(
  country?: string | null,
  state?: string | null
): Promise<string[] | null> {
  if (!country || !state) return null;

  const key = `list|${normKey(country)}|${normKey(state)}`;
  const cached = await readListCache(key);
  if (cached) return cached;

  if (normKey(country) === 'nigeria') {
    const staticList = findStaticNigeriaList(state);
    if (staticList) {
      await writeCache({ key, kind: 'list', country, state, items: staticList, source: 'static' });
      return staticList;
    }
  }

  const online = await fetchCitiesOnline(country, state);
  if (online) {
    await writeCache({ key, kind: 'list', country, state, items: online, source: 'countriesnow' });
    return online;
  }
  return null;
}

/**
 * True when `name` is a constitutional LGA of `state` (vs a neighborhood /
 * district like Gwarinpa). Drives sweep radius sizing on the dashboard.
 */
export function isKnownLga(country?: string | null, state?: string | null, name?: string | null): boolean {
  if (!country || !state || !name) return false;
  if (normKey(country) !== 'nigeria') return false;
  const wanted = expandRegionName(name).map(normKey);
  return Object.entries(NIGERIA_LGAS).some(([k, lgas]) => {
    const stateHit = expandRegionName(state).map(normKey).includes(normKey(k));
    return stateHit && lgas.some((l) => wanted.includes(normKey(l)));
  });
}

/**
 * [lat, lng] center for a named area, resolved via Nominatim and cached
 * in Mongo so each area is geocoded at most once per deployment.
 */
export async function getAreaCoords(
  country?: string | null,
  state?: string | null,
  name?: string | null
): Promise<[number, number] | null> {
  if (!country || !name) return null;

  const key = `coord|${normKey(country)}|${normKey(state ?? '')}|${normKey(name)}`;
  if (dbReady()) {
    try {
      const doc = await GeoPlace.findOne({ key }).lean<{ coordinates?: number[] }>();
      if (doc?.coordinates && doc.coordinates.length === 2) {
        // Stored as [lng, lat]; callers use [lat, lng]
        return [doc.coordinates[1], doc.coordinates[0]];
      }
    } catch {
      /* fall through to live geocoding */
    }
  }

  const queries = [state ? `${name}, ${state}` : name];
  for (const q of queries) {
    const hit = await geocodePlace(q, country);
    if (hit) {
      await writeCache({
        key,
        kind: 'coord',
        country,
        state,
        name,
        coordinates: [hit[1], hit[0]], // GeoJSON order [lng, lat]
        source: 'nominatim',
      });
      return hit;
    }
  }
  return null;
}
