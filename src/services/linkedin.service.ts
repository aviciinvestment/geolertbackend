/**
 * LinkedIn social broadcasting service.
 *
 * Publishes curated incident alerts to the Achiv Apps brand page whenever the
 * AI risk assessment flags a reported incident as severe. The page (and the
 * bearer token) come from env; when no page is configured the service falls
 * back to the authenticated member's own feed so the pipeline still runs.
 *
 * Configuration (server/.env):
 *   LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET — app credentials
 *   LINKEDIN_ACCESS_TOKEN                        — OAuth bearer token
 *   LINKEDIN_REFRESH_TOKEN                       — optional, for auto-renewal
 *   LINKEDIN_PAGE_URN            — e.g. urn:li:organization:XXXX (preferred)
 *   LINKEDIN_PERSON_URN          — fallback author, e.g. urn:li:person:XXXX
 *   LINKEDIN_SEVERITY_THRESHOLD  — only incidents >= this severity post (0.7)
 */

import Reel from '../models/Reel';
import { reverseGeocodeAddress } from './geo.service';
import { categoryLabel } from '../data/incidentCategories';

const REST = 'https://api.linkedin.com/rest';
const V2 = 'https://api.linkedin.com/v2';

export const SEVERITY_THRESHOLD =
  parseFloat(process.env.LINKEDIN_SEVERITY_THRESHOLD || '0.7') || 0.7;

let cachedToken: string | null = null;
let orgCache: { urn: string; name: string }[] | null = null;

export function hasLinkedInConfig(): boolean {
  return Boolean(process.env.LINKEDIN_ACCESS_TOKEN);
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedToken) return cachedToken;

  const refresh = process.env.LINKEDIN_REFRESH_TOKEN;
  if (forceRefresh && refresh) {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: process.env.LINKEDIN_CLIENT_ID || '',
      client_secret: process.env.LINKEDIN_CLIENT_SECRET || '',
    });
    const res = await fetch(`https://www.linkedin.com/oauth/v2/accessToken?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data: any = await res.json();
      cachedToken = data.access_token || '';
      if (cachedToken) return cachedToken;
    }
    console.warn(
      `[LinkedIn] Token refresh failed (${res.status}); falling back to stored token.`
    );
  }

  cachedToken = process.env.LINKEDIN_ACCESS_TOKEN || '';
  if (!cachedToken) throw new Error('LINKEDIN_ACCESS_TOKEN is not configured in server/.env');
  return cachedToken;
}

async function authFetch(
  url: string,
  init: RequestInit = {},
  forceRefresh = false
): Promise<Response> {
  const token = await getAccessToken(forceRefresh);
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': process.env.LINKEDIN_API_VERSION || '202608',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });
}

/** List organizations the authenticated user administers (returns first level
 *  details only — the app must hold w_organization_social). */
export async function findAdministeredOrganizations(): Promise<{ urn: string; name: string }[]> {
  if (orgCache) return orgCache;

  const res = await authFetch(
    `${V2}/organizationalEntityAcls?q=roleAssignee&role=ADMINISTRATOR&count=25`
  );
  if (!res.ok) {
    console.warn(
      `[LinkedIn] Cannot list administered organizations (${res.status}). ` +
        'The token likely lacks the w_organization_social scope for page posting. ' +
        'Set LINKEDIN_PAGE_URN to target the page directly, or fall back to the personal profile.'
    );
    return [];
  }

  const data: any = await res.json();
  const elements: any[] = data?.elements || [];
  const orgs: { urn: string; name: string }[] = [];

  for (const el of elements) {
    const urn = el?.organization as string;
    if (!urn) continue;
    const orgId = String(urn).split(':').pop();
    let name = urn;
    try {
      const o = await authFetch(
        `${V2}/organizations/${orgId}?projection=(localizedName,vanityName)`
      );
      if (o.ok) {
        const od: any = await o.json();
        name = od?.localizedName || od?.vanityName || urn;
      }
    } catch {
      // keep the URN as the display name
    }
    orgs.push({ urn, name });
  }

  orgCache = orgs;
  return orgs;
}

/** Decide who the Author of a post is: configured page -> administered page
 *  (prefer the one whose name mentions Achiv) -> personal profile.
 *  The personal profile is derived from the token itself (userinfo `sub`),
 *  because the member/PERSON URN format changed and a stale URN will make
 *  LinkedIn reject the post as "not authorized". */
export async function resolveAuthorUrn(): Promise<{ author: string; label: string }> {
  const pageUrn = process.env.LINKEDIN_PAGE_URN;
  if (pageUrn) {
    if (/^urn:li:org/i.test(pageUrn)) return { author: pageUrn, label: `${pageUrn} (page)` };
    return { author: `urn:li:organization:${pageUrn}`, label: `${pageUrn} (page)` };
  }

  try {
    const orgs = await findAdministeredOrganizations();
    const preferred =
      orgs.find((o) => /achiv/i.test(o.name)) || orgs.find((o) => /geolert/i.test(o.name));
    const target = preferred || orgs[0];
    if (target) return { author: target.urn, label: `${target.name} (page)` };
  } catch {
    // page discovery failed — fall through to the personal profile
  }

  const personUrn = (await derivePersonUrnFromToken()) || process.env.LINKEDIN_PERSON_URN;
  if (!personUrn) throw new Error('LINKEDIN_PERSON_URN must be set when no page is configured');
  return { author: personUrn, label: `${personUrn} (personal profile)` };
}

/** Derive the token owner's current person URN from the OpenID userinfo
 *  (`sub`). Returns null when the profile endpoint is unreachable. */
async function derivePersonUrnFromToken(): Promise<string | null> {
  try {
    const res = await authFetch(`${V2}/userinfo`);
    if (!res.ok) return null;
    const data: any = await res.json();
    if (typeof data?.sub === 'string' && data.sub) return `urn:li:person:${data.sub}`;
    return null;
  } catch {
    return null;
  }
}

/**
 * Publish a branded, community-safety post for a severe incident.
 * Never throws — logs and returns the outcome so callers stay non-fatal.
 */
export async function maybePublishSevereIncident(
  reel: any
): Promise<{ published: boolean; reason?: string }> {
  if (!reel || !reel._id || !hasLinkedInConfig()) {
    return { published: false, reason: 'linkedin not configured or invalid reel' };
  }
  if (reel.status === 'false_report') return { published: false, reason: 'flagged as false report' };
  if (reel.linkedinPosted) return { published: false, reason: 'already published' };
  if (Number(reel.severity ?? 0) < SEVERITY_THRESHOLD) {
    return { published: false, reason: 'below severity threshold' };
  }

  try {
    const coords = reel.location?.coordinates;
    const address = Array.isArray(coords) && coords.length >= 2
      ? await reverseGeocodeAddress(Number(coords[1]), Number(coords[0]))
      : null;

    const commentary = buildIncidentCommentary(reel, address);
    const published = await publishPost(commentary, true);

    await Reel.findByIdAndUpdate(reel._id, {
      linkedinPosted: true,
      linkedinPostId: published.postId || null,
      linkedinPostUrl: published.feedUrl || null,
      linkedinPostedAt: new Date(),
    });

    console.log(
      `[LinkedIn] Published severe ${reel.category || 'general'} incident ${reel._id} ` +
        `to ${published.authorLabel} (id ${published.postId || 'n/a'})`
    );
    return { published: true };
  } catch (err: any) {
    console.error(`[LinkedIn] Publish failed for incident ${reel._id}:`, err?.message || err);
    return { published: false, reason: err?.message || 'publish failed' };
  }
}

/** Publish an arbitrary curated post (used for the page welcome post). */
export async function publishWelcomePost(
  text: string
): Promise<{ postId: string; feedUrl: string; author: string; authorLabel: string }> {
  return publishPost(text, false);
}

async function publishPost(
  commentary: string,
  autoRefresh: boolean
): Promise<{ postId: string; feedUrl: string; author: string; authorLabel: string }> {
  const { author, label } = await resolveAuthorUrn();

  const body = {
    author,
    commentary,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  let res = await authFetch(`${REST}/posts`, { method: 'POST', body: JSON.stringify(body) });

  if (res.status === 401 && autoRefresh) {
    res = await authFetch(`${REST}/posts`, { method: 'POST', body: JSON.stringify(body) }, true);
  }

  // Fallback: some tokens support /v2/ugcPosts but not the newer /rest/posts endpoint.
  // Only used when posting to a personal profile (org posts need the same scope either way).
  if (!res.ok && /^urn:li:person:/i.test(author)) {
    console.warn(
      `[LinkedIn] /rest/posts failed (${res.status}); trying legacy /v2/ugcPosts fallback.`
    );
    const fallback = await publishViaUgcPosts(author, commentary);
    return { ...fallback, authorLabel: label };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LinkedIn post rejected (${res.status}): ${detail}`);
  }

  const feedUrl = res.headers.get('location') || '';
  const restliId = res.headers.get('x-restli-id') || '';
  const postId = restliId || feedUrl.split('/').pop() || '';

  return { postId, feedUrl, author, authorLabel: label };
}

async function publishViaUgcPosts(
  author: string,
  text: string
): Promise<{ postId: string; feedUrl: string; author: string }> {
  const body = {
    author,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
    },
  };

  const res = await authFetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`UGC fallback rejected (${res.status}): ${detail}`);
  }

  const data: any = await res.json();
  const postId = data?.id || '';
  const feedUrl = postId ? `https://www.linkedin.com/feed/update/${postId}` : '';
  return { postId, feedUrl, author };
}

/** Curate a readable, factual update from an incident record. */
export function buildIncidentCommentary(reel: any, address: string | null): string {
  const ai: any = reel.aiAnalysis || {};
  const description: string = (reel.description || '').trim();
  const summary: string = (ai.summary || '').trim();
  const severity = Number(reel.severity ?? 0);
  const sevLabel = severity >= 0.9 ? 'Critical' : severity >= 0.8 ? 'High' : 'Severe';

  const category = categoryLabel(reel.category || 'general');
  const coords = reel.location?.coordinates;
  const region: any = reel.region || {};

  const lines: string[] = [];
  lines.push(`${category} Incident Reported — ${sevLabel} Severity`);
  lines.push('');
  lines.push(
    'A witness reported this incident through GeoLert, a community incident reporting ' +
      'platform, and our AI risk assessment has flagged it as severe.'
  );
  lines.push('');

  const body = summary || description;
  if (body) lines.push(body);
  lines.push('');

  if (address) {
    lines.push(`Location: ${address}`);
  } else if (region.area || region.lga || region.state) {
    lines.push(`Location: ${[region.area, region.lga, region.state].filter(Boolean).join(', ')}`);
  }
  if (Array.isArray(coords) && coords.length >= 2) {
    lines.push(`Coordinates: ${Number(coords[1]).toFixed(5)}, ${Number(coords[0]).toFixed(5)}`);
  }

  lines.push('');
  lines.push('If you are nearby, stay safe and keep clear of the scene. Responders have been alerted.');
  lines.push('Verified updates can be shared through the GeoLert app.');
  lines.push('');
  lines.push('#GeoLert #AchivApps #CommunitySafety #EmergencyAlert');

  return lines.join('\n');
}

export const linkedinService = {
  hasLinkedInConfig,
  findAdministeredOrganizations,
  resolveAuthorUrn,
  maybePublishSevereIncident,
  publishWelcomePost,
  buildIncidentCommentary,
  SEVERITY_THRESHOLD,
};

export default linkedinService;