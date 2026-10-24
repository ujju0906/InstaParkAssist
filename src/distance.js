/**
 * Geographic distance helpers.
 *
 * Straight-line (great-circle) distance. NOT the assignment cost: people walk
 * along streets, so real walking distances come from routing.js. This is used
 * to pre-filter far-away spots (a walk is never shorter than the straight
 * line) and as the fallback estimate when no router is reachable.
 */

const EARTH_RADIUS_M = 6371000; // meters

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Great-circle distance between two lat/lng points, in meters.
 */
export function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Rough walking time in minutes at an average pace of 1.4 m/s (~5 km/h).
 */
export function walkMinutes(meters) {
  return meters / 1.4 / 60;
}
