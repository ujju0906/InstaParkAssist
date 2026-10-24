#!/usr/bin/env node
/**
 * Re-tune the scripted "rush hour" demo scenario against the seed spots using
 * real walking distances (street network), then warm the route cache so the
 * demo can replay without the network.
 *
 * Builds a pool of candidate driver locations around the demo buildings,
 * fetches the pool x spots walking matrix (a couple of router calls), then
 * searches offline for two waves where first-come-first-served greedy does
 * badly compared to the Hungarian optimum.
 *
 * Usage: npm run tune-rush        (paste the printed RUSH_BATCHES into src/demoData.js)
 * Run it again whenever the seed spots or BATCH_MAX change.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESTINATIONS } from '../src/demoData.js';
import { hungarian } from '../src/hungarian.js';

// The pool matrix is much bigger than a live batch, and the public router can
// take >6s (the app's default timeout) to answer it. routing.js reads env at
// import time, so set this before importing it.
process.env.OSRM_TIMEOUT_MS ??= '30000';
const { walkingMatrix, walkingRoutes, saveRouteCache } = await import('../src/routing.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spots = JSON.parse(readFileSync(join(root, 'data', 'seed.json'), 'utf8')).spots;
const WAVES = [8, 6]; // drivers per wave; wave size should be <= BATCH_MAX (default 8)
const POINTS_PER_BUILDING = 8;
const TRIALS = 40000;

function jitter(p, meters) {
  const dLat = ((Math.random() * 2 - 1) * meters) / 111320;
  const dLng = ((Math.random() * 2 - 1) * meters) / (111320 * Math.cos((p.lat * Math.PI) / 180));
  return { label: p.label, lat: +(p.lat + dLat).toFixed(6), lng: +(p.lng + dLng).toFixed(6) };
}

function greedyTotal(cost) {
  const taken = new Set();
  let total = 0;
  for (const row of cost) {
    let best = -1;
    let bestD = Infinity;
    row.forEach((d, j) => {
      if (!taken.has(j) && d < bestD) {
        bestD = d;
        best = j;
      }
    });
    if (best < 0) return Infinity; // greedy strands someone; skip these for a clean demo
    taken.add(best);
    total += bestD;
  }
  return total;
}

function sample(n, size) {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, size);
}

/** Find the ordered subset of pool points (rows) with the biggest greedy-vs-Hungarian gap. */
function searchWave(matrix, rowPool, cols, size) {
  let best = null;
  for (let t = 0; t < TRIALS; t++) {
    const rows = sample(rowPool.length, size).map((k) => rowPool[k]);
    const cost = rows.map((i) => cols.map((j) => matrix[i][j]));
    const h = hungarian(cost);
    const g = greedyTotal(cost);
    if (!Number.isFinite(g)) continue;
    const gap = g - h.totalCost;
    if (!best || gap > best.gap) best = { gap, rows, h, g };
  }
  return best;
}

async function main() {
  const pool = DESTINATIONS.flatMap((d) => Array.from({ length: POINTS_PER_BUILDING }, () => jitter(d, 40)));
  console.log(`Fetching walking distances: ${pool.length} driver points x ${spots.length} spots…`);
  const { matrix, source } = await walkingMatrix(spots, pool);
  if (source !== 'routed') {
    console.error(`Router unavailable (${source}); can't tune on real walking distances. Try again later.`);
    process.exit(1);
  }

  let rowPool = pool.map((_, i) => i);
  let cols = spots.map((_, j) => j);
  const waves = [];

  for (const size of WAVES) {
    const best = searchWave(matrix, rowPool, cols, size);
    const usedSpots = new Set(best.h.assignment.map((c) => cols[c]));
    waves.push({ ...best, cols });
    console.log(
      `Wave ${waves.length}: Hungarian ${Math.round(best.h.totalCost)} m vs greedy ${Math.round(best.g)} m ` +
        `(saves ${Math.round(best.gap)} m)`
    );
    // Next wave: remaining driver points, and only spots this wave didn't book.
    rowPool = rowPool.filter((i) => !best.rows.includes(i));
    cols = cols.filter((j) => !usedSpots.has(j));
  }

  // Warm the route geometry cache for every pair the demo will draw.
  const pairs = waves.flatMap((w) => w.rows.map((i, r) => ({ from: spots[w.cols[w.h.assignment[r]]], to: pool[i] })));
  const routes = await walkingRoutes(pairs);
  console.log(`Cached ${routes.filter(Boolean).length}/${pairs.length} route geometries.`);
  saveRouteCache();

  console.log('\nPaste into src/demoData.js:\n');
  console.log('const RUSH_BATCHES = [');
  for (const w of waves) {
    console.log('  [');
    for (const i of w.rows) console.log(`    [${JSON.stringify(pool[i].label)}, ${pool[i].lat}, ${pool[i].lng}],`);
    console.log('  ],');
  }
  console.log('];');
}

main();
