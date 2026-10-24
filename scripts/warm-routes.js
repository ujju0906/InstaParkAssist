#!/usr/bin/env node
/**
 * Pre-fetch walking distances and route geometry for every demo building
 * entrance x every parking spot, into data/route-cache.json. Afterwards random
 * demo traffic is answered from cache: no waiting on the public router, and it
 * works offline.
 *
 * Usage: npm run warm-routes     (run once, and again after adding spots)
 *
 * Restart the server afterwards so it loads the new cache entries.
 */

import { ENTRANCES } from '../src/demoData.js';
import { getSpots } from '../src/store.js';

// Warming is a one-off bulk job; give the throttled public router plenty of time.
// routing.js reads env at import time, so set this before importing it.
process.env.OSRM_TIMEOUT_MS ??= '30000';
const { walkingMatrix, walkingRoutes, saveRouteCache, routingStatus } = await import('../src/routing.js');

const spots = getSpots(); // current spots, including host-added ones
const before = routingStatus();
console.log(
  `Warming ${ENTRANCES.length} entrances x ${spots.length} spots ` +
    `(${before.cachedPairs} distances, ${before.cachedRoutes} routes cached so far)…`
);

const { source } = await walkingMatrix(spots, ENTRANCES);
if (source !== 'routed') {
  console.error(`Router unavailable (${source} distances). Try again in a minute.`);
  saveRouteCache();
  process.exit(1);
}

const pairs = ENTRANCES.flatMap((to) => spots.map((from) => ({ from, to })));
const routes = await walkingRoutes(pairs);
saveRouteCache();

const after = routingStatus();
const got = routes.filter(Boolean).length;
console.log(`Distances: ${after.cachedPairs} cached. Routes: ${got}/${pairs.length} pairs ready.`);
if (got < pairs.length) {
  console.log(`Some routes are missing${after.lastError ? ` (${after.lastError})` : ''}. Run it again to fill the gaps.`);
  process.exit(1);
}
console.log('Done. Restart the server (npm start) to use the warmed cache.');
