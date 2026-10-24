/**
 * Community points: a non-profit time bank instead of prices.
 *
 * - No money changes hands, and points can't be bought or cashed out.
 * - Every member starts with the same WELCOME_POINTS.
 * - Parking costs a flat POINTS_PER_HOUR, the same for every spot. Hosts don't
 *   set prices, so no spot can be priced up and nobody profits from demand.
 * - The points a driver spends go to the spot's host, so sharing your spot is
 *   how you earn parking for yourself. Points are only moved, never created
 *   (apart from the one-time welcome grant) or destroyed.
 *
 * Pure: no I/O. The ledger itself lives in store.js.
 */

export const WELCOME_POINTS = 20;
export const POINTS_PER_HOUR = 2;

/** Points for a booking of `hours` (bookings are in half-hour steps, so this is a whole number). */
export function pointsFor(hours) {
  return Math.ceil(Number(hours) * POINTS_PER_HOUR);
}

/** Members are identified by name (no accounts yet); match case- and space-insensitively. */
export function memberKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}
