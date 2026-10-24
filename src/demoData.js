/**
 * Demo scenario data: real San Francisco Financial District destinations and a
 * random request generator. Shared by the in-app simulator and the CLI script
 * (scripts/simulate.js). Pure: no I/O, no server imports.
 */

// Popular buildings get more weight, so drivers cluster and compete for the
// same nearby spots. That competition is where Hungarian beats greedy.
export const DESTINATIONS = [
  { label: 'Salesforce Tower', lat: 37.7898, lng: -122.3969, weight: 5 },
  { label: 'Transamerica Pyramid', lat: 37.7952, lng: -122.4028, weight: 4 },
  { label: 'Ferry Building', lat: 37.7955, lng: -122.3937, weight: 1 },
  { label: '101 California St', lat: 37.7929, lng: -122.398, weight: 5 },
  { label: 'Embarcadero Center', lat: 37.7948, lng: -122.3986, weight: 1 },
  { label: '555 California St', lat: 37.792, lng: -122.4037, weight: 1 },
  { label: 'Montgomery St BART', lat: 37.7894, lng: -122.4013, weight: 1 },
];

// Generic placeholder first names for simulated drivers.
const NAMES = [
  'Alex', 'Sam', 'Jordan', 'Taylor', 'Riley', 'Casey', 'Morgan', 'Jamie',
  'Avery', 'Quinn', 'Drew', 'Parker', 'Reese', 'Skyler', 'Rowan', 'Emerson',
];

// Morning-rush arrivals, so time windows overlap and spots run out late in the demo.
const START_TIMES = ['08:00', '08:30', '09:00', '09:30', '10:00', '10:30'];
const DURATIONS = [1, 1.5, 2, 2.5, 3];

/** Delay range (ms) between simulated arrivals, by speed. */
export const SPEEDS = {
  slow: [1500, 2500],
  normal: [700, 1400],
  fast: [200, 500],
};

export function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function pickWeighted(list) {
  const total = list.reduce((sum, d) => sum + d.weight, 0);
  let r = Math.random() * total;
  for (const item of list) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return list[list.length - 1];
}

/** Small seeded PRNG (mulberry32), so generated entrances are identical on every run. */
function seeded(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Offset a point by up to `meters` in a random direction. */
function jitter(lat, lng, meters, rand = Math.random) {
  const dLat = ((rand() * 2 - 1) * meters) / 111320;
  const dLng = ((rand() * 2 - 1) * meters) / (111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: +(lat + dLat).toFixed(6), lng: +(lng + dLng).toFixed(6) };
}

/**
 * Each building has a few fixed entrances that random drivers arrive at.
 * Realistic, and it keeps the set of destination points small and stable, so
 * every entrance -> spot walking distance and route can be fetched once
 * (`npm run warm-routes`) and served from cache. Random demos then don't wait
 * on the public router, which throttles to ~7.5 s per distance matrix.
 */
const ENTRANCES_PER_BUILDING = 4;
export const ENTRANCES = DESTINATIONS.flatMap((d, k) => {
  const rand = seeded(1000 + k);
  return Array.from({ length: ENTRANCES_PER_BUILDING }, () => ({
    label: d.label,
    ...jitter(d.lat, d.lng, 40, rand),
  }));
});

/**
 * Scripted "rush hour": two batches found by `npm run tune-rush`, which
 * searches for request sets where first-come-first-served greedy does badly
 * on the seed spots, using real walking distances along streets. Against the
 * stock seed data with no bookings, Hungarian saves ~1,180 m in batch 1
 * (1,880 m vs 3,057 m) and ~1,430 m in batch 2 (1,791 m vs 3,224 m).
 * Arrival order matters (greedy goes in order), so keep it.
 */
const RUSH = { startTime: '09:30', hours: 2 };
const RUSH_BATCHES = [
  [
    ['Transamerica Pyramid', 37.794857, -122.402992],
    ['555 California St', 37.792264, -122.40385],
    ['101 California St', 37.793227, -122.398247],
    ['101 California St', 37.792598, -122.398179],
    ['555 California St', 37.792035, -122.403415],
    ['Montgomery St BART', 37.789602, -122.401606],
    ['555 California St', 37.791768, -122.403913],
    ['Montgomery St BART', 37.789534, -122.401742],
  ],
  [
    ['101 California St', 37.793059, -122.39783],
    ['Transamerica Pyramid', 37.795106, -122.403033],
    ['Embarcadero Center', 37.794444, -122.398433],
    ['Embarcadero Center', 37.794758, -122.39845],
    ['Embarcadero Center', 37.795081, -122.398485],
    ['Transamerica Pyramid', 37.795343, -122.40294],
  ],
];

export const SCENARIOS = ['random', 'rush'];

/**
 * Build an arrival plan: [{ delay, request }], where delay is ms to wait
 * before sending that request. Shared by the in-app simulator and the CLI.
 */
export function buildPlan({ scenario = 'random', count = 16, speed = 'normal', date } = {}) {
  const plan = buildArrivals({ scenario, count, speed });
  // All simulated drivers book for the same date (server defaults to today).
  if (date) plan.forEach((step) => (step.request.date = date));
  return plan;
}

function buildArrivals({ scenario, count, speed }) {
  if (scenario === 'rush') {
    const plan = [];
    let n = 0;
    RUSH_BATCHES.forEach((batch, b) => {
      batch.forEach(([label, lat, lng], i) => {
        // Arrivals inside a batch are quick; the pause between batches lets the
        // first batch's animation finish before the second wave arrives.
        const delay = i > 0 ? 450 : b > 0 ? 5000 : 0;
        plan.push({
          delay,
          request: { userName: `${NAMES[n % NAMES.length]} ${String.fromCharCode(65 + (n % 26))}.`, label, lat, lng, ...RUSH },
        });
        n += 1;
      });
    });
    return plan;
  }

  const [min, max] = SPEEDS[speed] || SPEEDS.normal;
  return Array.from({ length: count }, (_, i) => ({
    delay: i === 0 ? 0 : randomBetween(min, max),
    request: makeRandomRequest(i),
  }));
}

/** A random driver request heading to an entrance of one of the demo buildings. */
export function makeRandomRequest(n = 0) {
  const dest = pickWeighted(DESTINATIONS);
  const { lat, lng } = pick(ENTRANCES.filter((e) => e.label === dest.label));
  return {
    userName: `${pick(NAMES)} ${String.fromCharCode(65 + (n % 26))}.`,
    label: dest.label,
    lat,
    lng,
    startTime: pick(START_TIMES),
    hours: pick(DURATIONS),
  };
}
