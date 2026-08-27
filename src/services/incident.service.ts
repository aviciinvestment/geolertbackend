/**
 * Incident classification + routing service.
 *
 * Classifies every reported incident into a response category (from the AI
 * analysis with a keyword fallback) and routes it to the Authority Responders
 * who should respond, strictly by jurisdiction and specialization:
 *
 *   1. Authorities inside the incident's LGA with a matching specialization
 *      are alerted (authorities without a specialization = generalist, match all).
 *   2. If no specialization matches but authorities DO exist in that LGA,
 *      every authority there is alerted regardless of specialization.
 *   3. If the LGA has no authority at all, the nearest registered authority
 *      location is expanded first (location B before location C) — only the
 *      nearest location's authorities are used, specialization rule reapplied.
 *
 * Assignment is recomputed on the fly for the authority dashboard endpoint, so
 * legacy + newly created authorities both see their incidents correctly.
 */

import Reel from '../models/Reel';
import { User } from '../models/User';
import { Notification } from '../models/Notification';
import { io } from '../server';
import { expandRegionName, expandLgaName } from './geo.service';
import { getAreaCoords } from './lga.service';
import {
  IncidentCategory,
  classifyIncidentText,
  categoryLabel,
  isIncidentCategory,
} from '../data/incidentCategories';

export interface IncidentAuthority {
  _id: any;
  name: string;
  specialization?: string | null;
  jurisdiction?: { country?: string; state?: string; lga?: string };
  location?: { type: string; coordinates: number[] } | null;
}

export type RoutingTier =
  | 'home_specialist'
  | 'home_all'
  | 'nearby_specialist'
  | 'nearby_all'
  | 'none';

export interface AssignmentResult {
  category: IncidentCategory;
  tier: RoutingTier;
  targets: IncidentAuthority[];
}

const norm = (s?: string | null): string =>
  (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** An authority without a specialization is a general responder → matches all. */
export function specializationMatches(spec?: string | null, category?: string | null): boolean {
  if (!spec || spec === 'general') return true;
  return spec.toLowerCase() === (category || 'general').toLowerCase();
}

/** Resolve the response category for a reel (existing tag → keyword fallback). */
export function classifyIncident(reel: {
  category?: string;
  description?: string;
  aiAnalysis?: any;
}): IncidentCategory {
  if (isIncidentCategory(reel.category)) return reel.category as IncidentCategory;
  const ai: any = reel.aiAnalysis || {};
  const text = [reel.description, ai.summary, ai.description, ai.severityReason]
    .filter((t) => typeof t === 'string')
    .join('\n');
  return classifyIncidentText(text);
}

/**
 * In-memory, lazily-loaded pool of approved authorities, refreshed on process
 * restart and invalidated whenever an authority is onboarded or approved.
 */
class AuthorityPoolImpl {
  private cache: IncidentAuthority[] | null = null;
  private expire = 0;
  private readonly ttl = 60_000;

  async get(): Promise<IncidentAuthority[]> {
    const now = Date.now();
    if (!this.cache || now > this.expire) {
      this.cache = await User.find({ role: 'authority', authorizationStatus: 'approved' })
        .select('name specialization jurisdiction location')
        .lean();
      this.expire = now + this.ttl;
    }
    return this.cache;
  }

  invalidate(): void {
    this.cache = null;
  }
}
export const AuthorityPool = new AuthorityPoolImpl();

/**
 * Core routing over an already-fetched pool of authorities.
 */
export async function routeIncident(opts: {
  category: IncidentCategory;
  lat?: number;
  lng?: number;
  state?: string | null;
  lga?: string | null;
  country?: string | null;
  authorities: IncidentAuthority[];
}): Promise<AssignmentResult> {
  const { category, lat, lng } = opts;
  const stateNames = new Set(expandRegionName(opts.state).map(norm));
  const lgaNames = new Set(expandLgaName(opts.lga).map(norm));

  // ---- Tier 1: authorities inside the incident's own LGA ----
  const home = opts.authorities.filter((a) => {
    const st = norm(a.jurisdiction?.state);
    const lg = norm(a.jurisdiction?.lga);
    if (stateNames.size > 0 && !stateNames.has(st)) return false;
    if (lgaNames.size > 0 && lg !== '' && !lgaNames.has(lg)) return false;
    return lg !== '' || lgaNames.size === 0;
  });

  const homeMatched = home.filter((a) => specializationMatches(a.specialization, category));
  if (homeMatched.length > 0) return { category, tier: 'home_specialist', targets: homeMatched };
  if (home.length > 0) return { category, tier: 'home_all', targets: home };

  // ---- Tier 2: no authority in that LGA → nearest registered location first ----
  if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { category, tier: 'none', targets: [] };
  }

  const statePool =
    stateNames.size > 0
      ? opts.authorities.filter((a) => stateNames.has(norm(a.jurisdiction?.state)))
      : opts.authorities;

  const lgaCenterCache = new Map<string, [number, number] | null>();
  const scored: { a: IncidentAuthority; dist: number }[] = [];
  for (const a of statePool) {
    let dist = Infinity;
    const loc = a.location?.coordinates;
    if (Array.isArray(loc) && loc.length >= 2 && Number.isFinite(loc[0]) && Number.isFinite(loc[1])) {
      dist = haversineKm(lat, lng, loc[1], loc[0]);
    } else {
      const key = norm(a.jurisdiction?.lga);
      if (key) {
        if (!lgaCenterCache.has(key)) {
          lgaCenterCache.set(
            key,
            await getAreaCoords(opts.country, opts.state, a.jurisdiction?.lga)
          );
        }
        const center = lgaCenterCache.get(key);
        if (center) dist = haversineKm(lat, lng, center[0], center[1]);
      }
    }
    scored.push({ a, dist });
  }

  if (scored.length === 0) return { category, tier: 'none', targets: [] };

  scored.sort((x, y) => {
    if (x.dist !== y.dist) return x.dist - y.dist;
    return String(x.a._id).localeCompare(String(y.a._id));
  });

  const nearest = scored[0];
  if (!Number.isFinite(nearest.dist)) return { category, tier: 'none', targets: [] };

  // Only the nearest location is used first ("location B, not skip to C").
  const nearestLga = norm(nearest.a.jurisdiction?.lga);
  const nearestGroup = scored
    .filter((s) => nearestLga !== '' && norm(s.a.jurisdiction?.lga) === nearestLga)
    .map((s) => s.a);
  const group = nearestGroup.length > 0 ? nearestGroup : [nearest.a];

  const matched = group.filter((a) => specializationMatches(a.specialization, category));
  if (matched.length > 0) {
    return { category, tier: 'nearby_specialist', targets: matched };
  }
  return { category, tier: 'nearby_all', targets: group };
}

/** Route an already-persisted incident and fire real-time alerts to targets. */
export async function assignIncidentToAuthorities(reel: any): Promise<AssignmentResult> {
  const coords = reel.location?.coordinates;
  const region: any = reel.region || {};
  const result = await routeIncident({
    category: classifyIncident(reel),
    lat: Array.isArray(coords) && coords.length >= 2 ? coords[1] : undefined,
    lng: Array.isArray(coords) && coords.length >= 2 ? coords[0] : undefined,
    state: region.state,
    lga: region.lga,
    country: region.country,
    authorities: await AuthorityPool.get(),
  });

  await notifyIncidentTargets(result, reel);
  return result;
}

async function notifyIncidentTargets(result: AssignmentResult, reel: any): Promise<void> {
  if (result.targets.length === 0) return;
  const region: any = reel.region || {};
  const locationLabel = region.area || region.lga || region.state || '';
  const label = categoryLabel(result.category).toLowerCase();
  const message = `New ${label} incident reported${locationLabel ? ` in ${locationLabel}` : ''} — assigned to you. Respond now.`;
  const now = new Date();
  const reelId = String(reel._id);
  const severity = reel.severity ?? 0;

  const rows = result.targets.map((t) => ({
    recipientId: t._id,
    senderId: reel.userId ?? null,
    senderName: 'GeoLert',
    message,
    type: 'incident_alert',
    read: false,
    category: result.category,
    severity,
    reelId,
    locationLabel: locationLabel || undefined,
    createdAt: now,
  }));

  const saved = await Notification.insertMany(rows);

  for (let i = 0; i < result.targets.length; i++) {
    io.to(`user:${String(result.targets[i]._id)}`).emit('notification', {
      id: String(saved[i]._id),
      senderName: 'GeoLert',
      message,
      type: 'incident_alert',
      category: result.category,
      severity,
      reelId,
      locationLabel: locationLabel || undefined,
      createdAt: now,
    });
  }

  console.log(
    `[Incident] ${result.category} reel ${reelId} → ${result.targets.length} authority/authorities (${result.tier})`
  );
}

/**
 * Every incident routed to one authority, newest first, shaped like the feed so
 * the mission planner can render it unchanged.
 */
export async function assignedReelsForAuthority(authorityId: string): Promise<any[]> {
  const authority = await User.findById(authorityId)
    .select('name specialization jurisdiction location')
    .lean();
  if (!authority) throw new Error('Authority not found');

  // Canonical DB casing (e.g. 'Nigeria', 'FCT - Abuja') — do NOT lowercase here;
  // routing comparisons normalize separately, but Mongo matches stored casing.
  const countrySet = new Set(expandRegionName((authority.jurisdiction as any)?.country));

  const reels = await Reel.find(
    countrySet.size > 0 ? { 'region.country': { $in: [...countrySet] } } : {}
  )
    .select(
      'url username avatar description likes comments views isLive isAnonymous userId likedBy location aiAnalysis severity category status region createdAt'
    )
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();

  const pool = await AuthorityPool.get();
  const authLoc = (authority as any).location?.coordinates;
  const out: any[] = [];

  for (const reel of reels) {
    if (reel.status === 'false_report') continue;
    const coords = reel.location?.coordinates;
    const region: any = reel.region || {};

    const result = await routeIncident({
      category: classifyIncident(reel as any),
      lat: Array.isArray(coords) && coords.length >= 2 ? coords[1] : undefined,
      lng: Array.isArray(coords) && coords.length >= 2 ? coords[0] : undefined,
      state: region.state,
      lga: region.lga,
      country: region.country,
      authorities: pool,
    });

    if (!result.targets.some((t) => String(t._id) === String(authority._id))) continue;

    let distanceMiles: number | undefined;
    if (
      Array.isArray(authLoc) &&
      authLoc.length >= 2 &&
      Array.isArray(coords) &&
      coords.length >= 2
    ) {
      distanceMiles =
        Math.round(haversineKm(authLoc[1], authLoc[0], coords[1], coords[0]) * 0.621371 * 10) / 10;
    }

    out.push({
      ...reel,
      distanceMiles,
      canInteract: true,
      engagementPriority: reel.severity ?? 0,
    });
  }

  return out;
}

export const incidentService = {
  classifyIncident,
  routeIncident,
  assignIncidentToAuthorities,
  assignedReelsForAuthority,
  specializationMatches,
  AuthorityPool,
};

export default incidentService;