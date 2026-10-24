#!/usr/bin/env node
/**
 * Demo traffic generator: fires simulated parking requests at a running
 * Instant Park Assist server, the same way real client apps would. Any open
 * browser jumps to the "Live demo" tab and animates each batch as it's solved.
 *
 * Usage:
 *   npm run simulate                          # scripted rush hour (best for demos)
 *   npm run simulate -- --random              # random traffic, 16 drivers
 *   npm run simulate -- --random --count 30 --speed fast
 *   npm run simulate -- --clear               # clear existing bookings first
 *   npm run simulate -- --url http://localhost:4000
 *
 * The live API is admin-only, so the script signs in first. Credentials come
 * from --user/--password, or the ADMIN_USERNAME (default "admin") and
 * ADMIN_PASSWORD env vars the server uses.
 */

import { buildPlan, SPEEDS } from '../src/demoData.js';
import { isValidDate, todayISO } from '../src/dates.js';

const USAGE =
  'Usage: npm run simulate -- [--random] [--date YYYY-MM-DD] [--count N] [--speed slow|normal|fast] [--clear] [--url URL]\n' +
  '                           [--user ADMIN_USERNAME] [--password ADMIN_PASSWORD]';

function parseArgs(argv) {
  const args = {
    scenario: 'rush',
    count: 16,
    speed: 'normal',
    url: 'http://localhost:3000',
    clear: false,
    date: undefined,
    user: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--random') args.scenario = 'random';
    else if (key === '--date') args.date = argv[++i]; // validated by the server
    else if (key.startsWith('--date=')) args.date = key.slice(7);
    else if (key === '--rush') args.scenario = 'rush';
    else if (key === '--count') args.count = Math.max(1, parseInt(argv[++i], 10) || 16);
    else if (key === '--speed') args.speed = SPEEDS[argv[++i]] ? argv[i] : 'normal';
    else if (key === '--url') args.url = String(argv[++i] || '').replace(/\/$/, '');
    else if (key === '--clear') args.clear = true;
    else if (key === '--user') args.user = argv[++i];
    else if (key === '--password') args.password = argv[++i];
    else if (key === '--help' || key === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`Unknown option: ${key}\n${USAGE}`);
      process.exit(1);
    }
  }
  // Check the date before doing anything destructive (rush clears bookings).
  // The server re-validates, including the max-days-ahead limit.
  if (args.date !== undefined && (!isValidDate(args.date) || args.date < todayISO())) {
    console.error(`--date must be today or later, as YYYY-MM-DD (got "${args.date}")`);
    process.exit(1);
  }
  if (!args.password) {
    console.error('The live demo is admin-only. Set ADMIN_PASSWORD or pass --password (and --user if not "admin").');
    process.exit(1);
  }
  // The scripted scenario is tuned for an empty booking table.
  if (args.scenario === 'rush') args.clear = true;
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Session cookie from signIn(), sent on every request. */
let cookie = '';
const authed = (opts = {}) => ({ ...opts, headers: { ...opts.headers, Cookie: cookie } });

/** Sign in as admin. Returns false if the server can't be reached. */
async function signIn(base, user, password) {
  let res;
  try {
    res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password }),
    });
  } catch {
    return false;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Sign-in as "${user}" failed: ${body.error || res.status}`);
    process.exit(1);
  }
  if (body.user?.role !== 'admin') {
    console.error(`"${user}" is not an admin account; the live demo needs one.`);
    process.exit(1);
  }
  const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  cookie = setCookie.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  return true;
}

/** Minimal Server-Sent Events reader on top of fetch (no dependencies). */
async function listen(url, onEvent, signal) {
  const res = await fetch(url, authed({ signal }));
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.url;

  const reachable = await signIn(base, args.user, args.password);
  const live = reachable
    ? await fetch(`${base}/api/live`, authed())
        .then((r) => r.json())
        .catch(() => null)
    : null;
  if (!live) {
    console.error(`Can't reach ${base}. Start the server first with: npm start`);
    process.exit(1);
  }

  if (args.clear) {
    await fetch(`${base}/api/bookings`, authed({ method: 'DELETE' }));
    console.log('Cleared existing bookings.');
  }

  const plan = buildPlan(args);
  const what =
    (args.scenario === 'rush' ? 'scripted rush hour' : `random traffic, ${args.speed}`) +
    `, booking for ${args.date || 'today'}`;
  console.log(
    `Sending ${plan.length} drivers (${what}) to ${base}. ` +
      `Batch window ${live.windowMs / 1000}s, max ${live.maxBatch} per batch.\n`
  );

  // Print batch results as the server solves them.
  const controller = new AbortController();
  let lastPending = 0;
  let doneSending = false;
  let resolveDone;
  const allSolved = new Promise((r) => (resolveDone = r));

  listen(
    `${base}/api/events`,
    (event, d) => {
      if (event !== 'batch') return;
      const c = d.comparison;
      const byReq = new Map(d.requests.map((r) => [r.id, r]));
      const bySpot = new Map(d.spots.map((s) => [s.id, s]));
      console.log(
        `\n  ▶ Batch #${d.batchId}: ${d.requests.length} drivers × ${d.spots.length} spots, solved in ${d.solveMs} ms ` +
          `(${d.distanceSource === 'routed' ? 'walking distances along streets' : `${d.distanceSource} distances`})`
      );
      for (const a of d.assignments) {
        const r = byReq.get(a.requestId);
        console.log(`     #${r.seq} ${r.userName} → ${bySpot.get(a.spotId).label} (${a.walkMeters} m walk)`);
      }
      for (const u of d.unassigned) {
        const r = byReq.get(u.requestId);
        console.log(`     #${r.seq} ${r.userName} → no spot (${u.reason})`);
      }
      const verdict =
        c.greedyAssigned < c.hungarianAssigned
          ? `greedy would have stranded ${c.hungarianAssigned - c.greedyAssigned} driver(s)`
          : `${c.savedMeters} m less walking than greedy`;
      console.log(`     Hungarian ${c.hungarianTotalWalkMeters} m vs greedy ${c.greedyTotalWalkMeters} m: ${verdict}\n`);
      lastPending = d.pending;
      if (doneSending && lastPending === 0) resolveDone();
    },
    controller.signal
  ).catch((err) => {
    if (err.name !== 'AbortError') console.error('Event stream error:', err.message);
  });

  await sleep(300); // let the stream connect

  for (const { delay, request: req } of plan) {
    await sleep(delay);
    const res = await fetch(
      `${base}/api/requests`,
      authed({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      })
    );
    const body = await res.json();
    if (!res.ok) {
      // Same validation error (e.g. a bad --date) would hit every request; stop early.
      console.error(`Request rejected: ${body.error}`);
      controller.abort();
      process.exit(1);
    } else {
      const seq = body.queued[0].seq;
      console.log(
        `  → #${seq} ${req.userName} heading to ${req.label}, ${req.date ? `${req.date} ` : ''}${req.startTime} for ${req.hours}h`
      );
    }
  }

  doneSending = true;
  // Wait for the final batch: its window has to close, then walking routes may
  // need fetching from the router (slow when uncached). Give up after a safety timeout.
  await Promise.race([allSolved, sleep(live.windowMs + 35000)]);
  controller.abort();

  const stats = (await fetch(`${base}/api/live`, authed()).then((r) => r.json())).stats;
  console.log(
    `Done. ${stats.received} requests, ${stats.assigned} parked, ${stats.unassigned} without a spot, ` +
      `${stats.batches} batches, ${stats.metersSaved} m walking saved vs greedy.`
  );
}

main();
