/**
 * Incident response taxonomy.
 *
 * Every reported incident is classified into exactly one category — first from
 * the AI analysis (Gemini is asked to return a `category`), falling back to a
 * deterministic keyword scan over the description + AI summary.
 *
 * Authority Responders are onboarded with a `specialization` chosen from these
 * same categories. Routing works like this:
 *   1. Authorities in the incident's LGA whose specialization matches → alerted
 *   2. If none match but authorities exist in that LGA → ALL authorities in the
 *      LGA are alerted (specialization ignored)
 *   3. If no authority exists in that LGA → authorities in the nearest other
 *      location (same state, ranked by proximity) are alerted; nearest location
 *      takes priority before any farther one.
 *
 * An authority whose specialization is empty / "general" is a general
 * responder and matches every category.
 */

export const INCIDENT_CATEGORIES = [
  'fire',
  'medical',
  'police',
  'rescue',
  'flood',
  'gas_hazard',
  'traffic',
  'building_collapse',
  'general',
] as const;

export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<IncidentCategory, string> = {
  fire: 'Fire',
  medical: 'Medical',
  police: 'Police / Security',
  rescue: 'Search & Rescue',
  flood: 'Flood',
  gas_hazard: 'Gas / Hazardous Materials',
  traffic: 'Traffic / Accident',
  building_collapse: 'Building Collapse',
  general: 'General',
};

const NON_GENERAL: Exclude<IncidentCategory, 'general'>[] = [
  'fire',
  'medical',
  'police',
  'rescue',
  'flood',
  'gas_hazard',
  'traffic',
  'building_collapse',
];

export const CATEGORY_KEYWORDS: Record<Exclude<IncidentCategory, 'general'>, string[]> = {
  fire: [
    'fire', 'fire incident', 'flames', 'flame', 'burning', 'burn', 'smoke', 'blaze',
    'wildfire', 'inferno', 'burnt', 'charred', 'arson',
  ],
  medical: [
    'medical', 'first aid', 'ambulance', 'cardiac arrest', 'unconscious', 'bleeding',
    'blood', 'injured', 'injury', 'wound', 'overdose', 'patient', 'sick', 'health',
    'emergency care', 'trip and fell', 'collapsed person',
  ],
  police: [
    'police', 'theft', 'robbery', 'burglary', 'assault', 'gun', 'shooting', 'weapon',
    'violence', 'fight', 'attacked', 'stolen', 'kidnap', 'rape', 'criminal',
  ],
  rescue: [
    'trapped', 'debris', 'rescue', 'landslide', 'earthquake', 'drowning', 'stranded',
    'entrapped', 'rubble', 'stuck',
  ],
  flood: [
    'flood', 'flooding', 'submerged', 'water rising', 'overflow', 'drainage', 'torrent',
    'heavy rain', 'inundat',
  ],
  gas_hazard: [
    'gas leak', 'gas', 'chemical', 'toxic', 'hazardous', 'spill', 'fumes', 'explosion',
    'explosive', 'radiological',
  ],
  traffic: [
    'accident', 'crash', 'collision', 'vehicle incident', 'car crash', 'traffic',
    'motorcycle', 'truck', 'pileup', 'hit by car',
  ],
  building_collapse: [
    'building collapse', 'structure collapse', 'roof caving', 'wall fell',
    'demolition', 'unsafe building', 'cracked building', 'crane fell',
  ],
};

export function isIncidentCategory(value?: string | null): value is IncidentCategory {
  return !!value && (INCIDENT_CATEGORIES as readonly string[]).includes(value);
}

export function categoryLabel(value?: string | null): string {
  if (!value) return 'General';
  const v = value.toLowerCase();
  return (CATEGORY_LABELS as Record<string, string>)[v] || 'General';
}

/**
 * Deterministic keyword classifier. Returns 'general' when no category scores
 * higher than zero. Used as the fallback when the AI category is missing.
 */
export function classifyIncidentText(text?: string | null): IncidentCategory {
  const hay = ` ${(text || '').toLowerCase()} `;
  let best: IncidentCategory = 'general';
  let bestCount = 0;
  for (const cat of NON_GENERAL) {
    let count = 0;
    for (const kw of CATEGORY_KEYWORDS[cat]) {
      if (hay.includes(kw)) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = cat;
    }
  }
  return best;
}