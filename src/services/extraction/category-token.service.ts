/**
 * Pure category-key resolver over the shared vocabulary.
 *
 * Phase 4 split of `src/services/business-extractor.service.ts`. Every declaration
 * below is copied byte-exact from the monolith; only the import block is new.
 */



export function resolveCategoryKey(
  categoryContext: string | string[] | undefined,
  userQuery?: string
): string {
  // Specific vertical keywords take strict priority over generic institutional nouns like 'school' or 'store'
  const PRIORITY_KEYWORD_MAP: Record<string, string> = {
    driving: 'driving', driver: 'driving', drivers: 'driving', motor: 'driving', motors: 'driving',
    license: 'driving', licence: 'driving', vehicle: 'driving', vehicles: 'driving', trial: 'driving',
    furniture: 'furniture', furnishing: 'furniture', furnishings: 'furniture',
    interior: 'furniture', interiors: 'furniture', sofa: 'furniture', wood: 'furniture',
    wooden: 'furniture', decor: 'furniture', mattress: 'furniture',
    dental: 'dental', dentist: 'dental', dentistry: 'dental', orthodontic: 'dental', oral: 'dental',
    beauty: 'beauty', salon: 'beauty', parlour: 'beauty', parlor: 'beauty',
    hair: 'beauty', spa: 'beauty', cosmetic: 'beauty', makeup: 'beauty',
    barber: 'beauty', barbershop: 'beauty', unisex: 'beauty',
    hardware: 'hardware', machinery: 'hardware', tools: 'hardware', sanitary: 'hardware',
    tiles: 'hardware', paint: 'hardware', paints: 'hardware', cement: 'hardware',
    construction: 'hardware', steel: 'hardware', metal: 'hardware', pipe: 'hardware',
    pipes: 'hardware', plywood: 'hardware',
    gym: 'fitness', fitness: 'fitness', workout: 'fitness',
    banquet: 'venue', venue: 'venue', reception: 'venue',
    palace: 'venue', party: 'venue', hall: 'venue',
  };

  const GENERAL_KEYWORD_MAP: Record<string, string> = {
    clinic: 'medical', hospital: 'medical', pharmacy: 'medical', medical: 'medical',
    school: 'education', college: 'education', academy: 'education', institute: 'education',
    hotel: 'hospitality', resort: 'hospitality', restaurant: 'hospitality', cafe: 'hospitality',
    law: 'legal', lawyer: 'legal', advocate: 'legal', legal: 'legal', attorney: 'legal',
    store: 'retail', shop: 'retail', mart: 'retail', kirana: 'retail', grocery: 'retail',
    service: 'services', repair: 'services', cleaning: 'services', plumbing: 'services',
  };

  const contexts = [
    ...(Array.isArray(categoryContext) ? categoryContext : categoryContext ? [categoryContext] : []),
    ...(userQuery ? [userQuery] : []),
  ];

  // Pass 1: Check high-priority vertical keywords
  for (const ctx of contexts) {
    if (!ctx) continue;
    const normalized = ctx.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    for (const word of normalized) {
      if (PRIORITY_KEYWORD_MAP[word]) return PRIORITY_KEYWORD_MAP[word];
    }
  }

  // Pass 2: Check general institutional keywords
  for (const ctx of contexts) {
    if (!ctx) continue;
    const normalized = ctx.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    for (const word of normalized) {
      if (GENERAL_KEYWORD_MAP[word]) return GENERAL_KEYWORD_MAP[word];
    }
  }

  return 'services';
}
