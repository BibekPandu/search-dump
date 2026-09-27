/**
 * Pure geographic math helpers (no I/O, no service dependencies).
 *
 * Lives in `src/lib/` because it is a leaf utility: it must be importable from
 * any layer (services, workflows, tests) without pulling that layer into an
 * import cycle. `services/resolution/geocoding.service.ts` and
 * `services/resolution/geographic-evaluator.service.ts` both depend on this
 * module instead of on each other — this is what breaks the
 * geocoding <-> geographic-evaluator circular dependency.
 */

/**
 * Calculates Great-Circle distance between two GPS coordinates in kilometers using Haversine formula.
 *
 * @param lat1 latitude of point 1 (degrees)
 * @param lon1 longitude of point 1 (degrees)
 * @param lat2 latitude of point 2 (degrees)
 * @param lon2 longitude of point 2 (degrees)
 * @returns distance in kilometers, rounded to 2 decimal places
 */
export function calculateHaversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}
