/**
 * Walking distances along the real street/footpath network.
 *
 * People can't walk through buildings, so straight-line distance understates
 * real walks (measured on the demo data: median 1.27x, worst case 13x, e.g. a
 * spot in an alley reached from a different street). This module asks an OSRM
 * router with a foot profile for:
 *
 *   - walkingMatrix(): spot -> destination walking meters for a whole batch in
 *     one `table` call. This is the Hungarian cost matrix.
 *   - walkingRoutes(): the actual path geometry for the chosen pairs, in one
 *     chained `route` call, so the map shows routes along streets.
 *
 * OSRM measures between the points it snaps onto the walkable network, so the
 * snap legs (car spot -> nearest footpath, footpath -> building) are added back.
 *
 * Reliability, for live demos:
 *   - Results are cached in memory and on disk (data/route-cache.json), so a
 *     scenario that ran once replays without the network.
 *   - Requests are spaced out (the public FOSSGIS server allows 1 request/s).
 *   - If the router fails or times out, distances fall back to straight-line
 *     x CIRCUITY and are labeled "estimated"; the router is retried after a
 *     cooldown.
 *
 * Config (env):
 *   ROUTING=off                 never call a router (cache + estimates only)
 *   OSRM_URL                    router base URL (default: public FOSSGIS foot server)
 *   OSRM_PROFILE                profile segment in the URL (default: foot)
 *   OSRM_MIN_INTERVAL_MS        spacing between requests (default 1100 for the
 *                               public server, 0 otherwise)
 *   OSRM_TIMEOUT_MS             per-request timeout (default 15000 for the
 *                               public server, 6000 otherwise)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversineMeters } from './distance.js';

const DEFAULT_URL = 'https://routing.openstreetmap.de/routed-foot';
const BASE_URL = (process.env.OSRM_URL || DEFAULT_URL).replace(/\/$/, '');
const PROFILE = process.env.OSRM_PROFILE || 'foot';
const ENABLED = process.env.ROUTING !== 'off';
const MIN_INTERVAL_MS =
  process.env.OSRM_MIN_INTERVAL_MS != null
    ? Number(process.env.OSRM_MIN_INTERVAL_MS)
    : BASE_URL === DEFAULT_URL
      ? 1100
      : 0;
// The public server throttles the table service (measured: ~7.5 s per batch
// after the first call), so give it room. A self-hosted OSRM answers in ms.
const TIMEOUT_MS = Number(process.env.OSRM_TIMEOUT_MS) || (BASE_URL === DEFAULT_URL ? 15000 : 6000);
const COOLDOWN_MS = 15000;
const MAX_TABLE_COORDS = 100; // OSRM's default table size limit
const MAX_ROUTE_PAIRS = 40;
const USER_AGENT = 'InstantParkAssist/1.0 (demo app)';

/**
 * Fallback multiplier for straight-line distance when no router is reachable.
 * Real walks in the demo area measured ~1.27x straight-line (median).
 */
export const CIRCUITY = 1.3;

// --- Cache -----------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, '..', 'data', 'route-cache.json');
const MAX_PAIRS = 50000;
const MAX_ROUTES = 2000;

const pairCache = new Map(); // key -> meters, or null if no walking route exists
const routeCache = new Map(); // key -> [[lat, lng], ...]

try {
  if (existsSync(CACHE_PATH)) {
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    for (const [k, v] of Object.entries(raw.pairs || {})) pairCache.set(k, v);
    for (const [k, v] of Object.entries(raw.routes || {})) routeCache.set(k, v);
  }
} catch (err) {
  console.warn(`[routing] ignoring unreadable cache: ${err.message}`);
}

function trim(map, max) {
  // Maps iterate in insertion order, so this drops the oldest entries.
  for (const k of map.keys()) {
    if (map.size <= max) break;
    map.delete(k);
  }
}

let saveTimer = null;

export function saveRouteCache() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    // Merge with what's on disk, so the server and scripts (e.g. tune-rush)
    // don't overwrite each other's entries.
    if (existsSync(CACHE_PATH)) {
      const disk = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
      for (const [k, v] of Object.entries(disk.pairs || {})) if (!pairCache.has(k)) pairCache.set(k, v);
      for (const [k, v] of Object.entries(disk.routes || {})) if (!routeCache.has(k)) routeCache.set(k, v);
    }
  } catch {
    /* unreadable cache file: overwrite it */
  }
  trim(pairCache, MAX_PAIRS);
  trim(routeCache, MAX_ROUTES);
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({ pairs: Object.fromEntries(pairCache), routes: Object.fromEntries(routeCache) })
    );
  } catch (err) {
    console.warn(`[routing] could not save cache: ${err.message}`);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveRouteCache, 1000);
}

/** Cache key for walking from a parking spot to a destination (~1 m precision). */
function key(from, to) {
  return `${from.lat.toFixed(5)},${from.lng.toFixed(5)}>${to.lat.toFixed(5)},${to.lng.toFixed(5)}`;
}

// --- Router client ---------------------------------------------------------

let nextSlot = 0;
let downUntil = 0;
let lastError = null;

class RouterError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function routerAvailable() {
  return ENABLED && Date.now() >= downUntil;
}

function markDown(err) {
  downUntil = Date.now() + COOLDOWN_MS;
  lastError = err.message;
  console.warn(`[routing] ${err.message}; using estimates for ${COOLDOWN_MS / 1000}s`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;

async function routerFetch(path) {
  // Reserve the next slot so concurrent callers are spaced out too.
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait) await sleep(wait);

  let res;
  let text;
  try {
    // The timeout covers the whole exchange, including reading the body.
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    const why = err.name === 'TimeoutError' ? `timeout after ${TIMEOUT_MS} ms` : err.message;
    throw new RouterError(`router unreachable (${why})`, 'Network');
  }
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON: reported below */
  }
  if (!res.ok || !body || body.code !== 'Ok') {
    const code = body?.code || `HTTP ${res.status}`;
    const detail = body?.message || (body ? '' : `non-JSON reply: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    throw new RouterError(`router error: ${code}${detail ? ` (${detail})` : ''}`, code);
  }
  lastError = null;
  return body;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Fetch spot -> destination walking distances into the cache. */
async function fetchTable(spots, dests) {
  for (const dc of chunk(dests, MAX_TABLE_COORDS / 2)) {
    for (const sc of chunk(spots, MAX_TABLE_COORDS - dc.length)) {
      const coords = [...sc, ...dc].map(fmt).join(';');
      const sources = sc.map((_, a) => a).join(';');
      const destinations = dc.map((_, b) => sc.length + b).join(';');
      const body = await routerFetch(
        `/table/v1/${PROFILE}/${coords}?sources=${sources}&destinations=${destinations}&annotations=distance`
      );
      sc.forEach((s, a) =>
        dc.forEach((d, b) => {
          const core = body.distances?.[a]?.[b];
          // Add the snap legs: spot -> nearest walkable way, and way -> destination.
          const meters =
            core == null ? null : Math.round(core + (body.sources[a].distance || 0) + (body.destinations[b].distance || 0));
          pairCache.set(key(s, d), meters);
        })
      );
    }
  }
  scheduleSave();
}

// --- Public API ------------------------------------------------------------

/**
 * Walking meters from every spot to every destination.
 *
 * @returns {{ matrix: number[][], source: 'routed'|'partial'|'estimated' }}
 *   matrix[i][j] = meters walking from spots[j] to dests[i]; Infinity if the
 *   router says no walking route exists.
 */
export async function walkingMatrix(spots, dests) {
  const lookup = () => {
    const missing = { spots: new Set(), dests: new Set() };
    const matrix = dests.map((d, i) =>
      spots.map((s, j) => {
        const v = pairCache.get(key(s, d));
        if (v === undefined) {
          missing.spots.add(j);
          missing.dests.add(i);
          return undefined;
        }
        return v === null ? Infinity : v;
      })
    );
    return { matrix, missing };
  };

  let { matrix, missing } = lookup();

  if (missing.spots.size > 0 && routerAvailable()) {
    try {
      await fetchTable(
        [...missing.spots].map((j) => spots[j]),
        [...missing.dests].map((i) => dests[i])
      );
      ({ matrix } = lookup());
    } catch (err) {
      markDown(err);
    }
  }

  let estimated = 0;
  dests.forEach((d, i) =>
    spots.forEach((s, j) => {
      if (matrix[i][j] === undefined) {
        matrix[i][j] = haversineMeters(s, d) * CIRCUITY;
        estimated += 1;
      }
    })
  );

  const total = spots.length * dests.length;
  const source = estimated === 0 ? 'routed' : estimated === total ? 'estimated' : 'partial';
  return { matrix, source };
}

/**
 * Walking path geometry for each { from: spot, to: destination } pair.
 * Returns an array of [[lat, lng], ...] paths, or null where unavailable
 * (callers draw a straight dashed line instead).
 *
 * All missing pairs go in ONE chained route request (spot1, dest1, spot2,
 * dest2, ...): legs 0, 2, 4, ... are the walks we want; the connecting legs are
 * ignored. That keeps it to a single request per batch.
 *
 * To keep the reply small (turn-by-turn steps made it ~75 KB per batch), we
 * ask only for the full overview line plus per-segment distances, and split
 * the line by leg: leg k has annotation.distance.length segments, and
 * consecutive legs share their joining coordinate.
 */
function splitOverviewByLeg(route) {
  const coords = route.geometry.coordinates;
  const legs = [];
  let start = 0;
  for (const leg of route.legs) {
    const segments = leg.annotation.distance.length;
    legs.push(coords.slice(start, start + segments + 1));
    start += segments;
  }
  return legs;
}

export async function walkingRoutes(pairs) {
  const out = pairs.map((p) => routeCache.get(key(p.from, p.to)) || null);
  const missing = pairs.map((_, k) => k).filter((k) => !out[k]);

  if (missing.length > 0 && routerAvailable()) {
    try {
      for (const group of chunk(missing, MAX_ROUTE_PAIRS)) {
        const pts = group.flatMap((k) => [pairs[k].from, pairs[k].to]);
        const body = await routerFetch(
          `/route/v1/${PROFILE}/${pts.map(fmt).join(';')}` +
            '?overview=full&geometries=geojson&annotations=distance&steps=false&continue_straight=false'
        );
        const legs = splitOverviewByLeg(body.routes[0]);
        group.forEach((k, g) => {
          const { from, to } = pairs[k];
          const line = legs[2 * g].map(([lng, lat]) => [+lat.toFixed(6), +lng.toFixed(6)]);
          const path = [[from.lat, from.lng], ...line, [to.lat, to.lng]];
          routeCache.set(key(from, to), path);
          out[k] = path;
        });
      }
      scheduleSave();
    } catch (err) {
      // "NoRoute" is about these points, not the router's health.
      if (err.code !== 'NoRoute') markDown(err);
    }
  }
  return out;
}

export function routingStatus() {
  return {
    enabled: ENABLED,
    url: BASE_URL,
    profile: PROFILE,
    available: routerAvailable(),
    lastError,
    cachedPairs: pairCache.size,
    cachedRoutes: routeCache.size,
  };
}
