/**
 * Instant Park Assist — Express server.
 *
 * Serves the web client and a small JSON API:
 *   GET    /api/spots            list spots (?date= only those offered that day)
 *   POST   /api/spots            host adds a spot (daily hours + optional date range)
 *   DELETE /api/spots/:id        host removes a spot
 *   GET    /api/hosts            hosts directory (?date= that day's bookings/points)
 *   GET    /api/points           points rules (welcome grant, points per hour)
 *   GET    /api/members          every member's points balance
 *   GET    /api/members/:name    one member's balance + history
 *   POST   /api/assign           instant assignment, nothing booked (Hungarian)
 *   POST   /api/book             book a date + time window (driver pays host in points)
 *   GET    /api/bookings         list bookings (?date=, ?spotId=)
 *   DELETE /api/bookings         clear all bookings and points (keeps spots)
 *   POST   /api/reset            reset data back to the seed
 *
 * Live batching (demo):
 *   POST   /api/requests         queue request(s); solved + booked in batches
 *   GET    /api/events           Server-Sent Events stream of queue activity
 *   GET    /api/live             snapshot of queue, stats, simulator
 *   POST   /api/simulate/start   start the built-in simulator { scenario, date, count, speed, clearBookings }
 *   POST   /api/simulate/stop    stop the simulator
 */

import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getSpots,
  getSpot,
  addSpot,
  removeSpot,
  createBooking,
  getBookings,
  getBalance,
  getMember,
  getMembers,
  clearBookings,
  isSpotAvailable,
  isSpotOpenOnDate,
  resetToSeed,
} from './src/store.js';
import { assignRequests } from './src/assign.js';
import { normalizeRequest, normalizeWindow, validateSpotInput, RequestError } from './src/requests.js';
import { isValidDate } from './src/dates.js';
import { WELCOME_POINTS, POINTS_PER_HOUR } from './src/points.js';

const minutesToTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
import { Batcher } from './src/batcher.js';
import { Simulator } from './src/simulator.js';
import { routingStatus, saveRouteCache } from './src/routing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// --- Live batching + event stream ------------------------------------------

const batcher = new Batcher({
  windowMs: Number(process.env.BATCH_WINDOW_MS) || 5000,
  maxBatch: Number(process.env.BATCH_MAX) || 8,
});
const simulator = new Simulator(batcher);

const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

batcher.on('request', (d) => broadcast('request', d));
batcher.on('window', (d) => broadcast('window', d));
batcher.on('solving', (d) => broadcast('solving', d));
batcher.on('batch', (d) => broadcast('batch', d));
simulator.on('status', (d) => broadcast('sim', d));

// Keep idle connections open through proxies.
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 15000).unref();

function liveSnapshot() {
  return { ...batcher.snapshot(), sim: simulator.status(), routing: routingStatus() };
}

/** Stop the simulator, drop the queue, and tell every browser to clear its view. */
function resetLive() {
  simulator.stop();
  batcher.clear();
  broadcast('reset', {});
}

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify(liveSnapshot())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/api/live', (_req, res) => {
  res.json(liveSnapshot());
});

/** Body: a single request object, or { requests: [...] } (max 50). */
app.post('/api/requests', (req, res) => {
  const body = req.body || {};
  const raw = Array.isArray(body.requests) ? body.requests : [body];
  if (raw.length === 0 || raw.length > 50) {
    return res.status(400).json({ error: 'send between 1 and 50 requests' });
  }
  try {
    // Validate everything before queueing anything.
    raw.forEach((r, i) => normalizeRequest(r, i));
    const queued = raw.map((r) => batcher.enqueue(r));
    res.status(202).json({ queued: queued.map((q) => ({ id: q.id, seq: q.seq })), pending: batcher.pending.length });
  } catch (err) {
    if (err instanceof RequestError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

app.post('/api/simulate/start', (req, res) => {
  const { count, speed, scenario, clearBookings: clear } = req.body || {};
  let date;
  try {
    ({ date } = normalizeWindow({ date: req.body?.date })); // validates; defaults to today
  } catch (err) {
    if (err instanceof RequestError) return res.status(400).json({ error: err.message });
    throw err;
  }
  resetLive();
  // The scripted scenario is tuned for an empty booking table.
  if (clear || scenario === 'rush') clearBookings();
  simulator.start({ count, speed, scenario, date });
  res.json(simulator.status());
});

app.post('/api/simulate/stop', (_req, res) => {
  simulator.stop();
  res.json(simulator.status());
});

// --- Spots -----------------------------------------------------------------

app.get('/api/spots', (req, res) => {
  const date = req.query.date;
  if (date === undefined) return res.json(getSpots());
  if (!isValidDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  res.json(getSpots().filter((s) => isSpotOpenOnDate(s, date)));
});

app.post('/api/spots', (req, res) => {
  try {
    res.status(201).json(addSpot(validateSpotInput(req.body)));
  } catch (err) {
    if (err instanceof RequestError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

app.delete('/api/spots/:id', (req, res) => {
  const ok = removeSpot(req.params.id);
  if (!ok) return res.status(404).json({ error: 'spot not found' });
  res.status(204).end();
});

// --- Hosts -----------------------------------------------------------------

/**
 * Hosts directory: spots grouped by host name, with booking counts and the
 * community points each host has earned from them. Hosts are identified by
 * name since there are no accounts yet.
 *
 * ?date=YYYY-MM-DD narrows bookings/points to that date, marks whether each
 * spot is offered that day, and lists that day's bookings per spot.
 */
app.get('/api/hosts', (req, res) => {
  const date = req.query.date;
  if (date !== undefined && !isValidDate(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  const bookings = getBookings();
  const hosts = new Map();

  for (const spot of getSpots()) {
    if (!hosts.has(spot.hostName)) {
      hosts.set(spot.hostName, {
        hostName: spot.hostName,
        spots: [],
        bookingCount: 0,
        pointsEarned: 0,
        balance: getBalance(spot.hostName),
      });
    }
    const host = hosts.get(spot.hostName);
    const spotBookings = bookings.filter((b) => b.spotId === spot.id && (!date || b.date === date));
    const entry = { ...spot, bookingCount: spotBookings.length };
    if (date) {
      entry.openOnDate = isSpotOpenOnDate(spot, date);
      entry.bookings = spotBookings
        .map(({ id, userName, destinationLabel, startTime, startMin, endMin, hours, points }) => ({
          id,
          userName,
          destinationLabel,
          startTime,
          endTime: minutesToTime(endMin),
          startMin,
          hours,
          points,
        }))
        .sort((a, b) => a.startMin - b.startMin);
    }
    host.spots.push(entry);
    host.bookingCount += spotBookings.length;
    host.pointsEarned += spotBookings.reduce((sum, b) => sum + (b.points || 0), 0);
  }

  res.json([...hosts.values()].sort((a, b) => a.hostName.localeCompare(b.hostName)));
});

// --- Community points ------------------------------------------------------

/** The rules, so clients don't hard-code them. */
app.get('/api/points', (_req, res) => {
  res.json({ welcomePoints: WELCOME_POINTS, pointsPerHour: POINTS_PER_HOUR });
});

/** Every member with their balance, points earned by hosting, and points spent parking. */
app.get('/api/members', (_req, res) => {
  res.json(getMembers().sort((a, b) => a.name.localeCompare(b.name)));
});

/** One member's balance and recent history. Unknown names show the welcome balance. */
app.get('/api/members/:name', (req, res) => {
  const name = String(req.params.name).trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'name is required' });
  res.json(getMember(name));
});

// --- Instant assignment ----------------------------------------------------

/**
 * Body: { requests: [{ userName?, lat, lng, label?, date?, startTime, hours }] }
 * date is "YYYY-MM-DD" (default today); startTime is "HH:MM"; hours is a
 * number. Returns the optimal assignment
 * (by walking distance along streets, with route geometry) without booking.
 */
app.post('/api/assign', async (req, res) => {
  const rawRequests = (req.body && req.body.requests) || [];
  if (!Array.isArray(rawRequests) || rawRequests.length === 0) {
    return res.status(400).json({ error: 'requests array is required' });
  }

  let requests;
  try {
    requests = rawRequests.map((r, i) => normalizeRequest(r, i));
  } catch (err) {
    if (err instanceof RequestError) return res.status(400).json({ error: err.message });
    throw err;
  }

  try {
    const result = await assignRequests(requests);
    // Each driver's current points, so the UI can show "20 → 16" before booking.
    const balances = Object.fromEntries(requests.map((r) => [r.userName, getBalance(r.userName)]));
    res.json({ ...result, points: { perHour: POINTS_PER_HOUR, balances } });
  } catch (err) {
    console.error('Assignment failed:', err);
    res.status(500).json({ error: 'assignment failed' });
  }
});

// --- Booking ---------------------------------------------------------------

/** Body: { spotId, date?, startTime, hours, userName?, destinationLabel? } */
app.post('/api/book', (req, res) => {
  const body = req.body || {};
  const spot = getSpot(body.spotId);
  if (!spot) return res.status(404).json({ error: 'spot not found' });

  let win;
  try {
    win = normalizeWindow(body);
  } catch (err) {
    if (err instanceof RequestError) return res.status(400).json({ error: err.message });
    throw err;
  }

  if (!isSpotAvailable(spot, win.date, win.startMin, win.endMin)) {
    return res.status(409).json({ error: 'spot is not available for that date and time' });
  }

  const userName =
    typeof body.userName === 'string' && body.userName.trim() ? body.userName.trim().slice(0, 80) : 'Anonymous';
  const { booking, error } = createBooking(spot, {
    userName,
    destinationLabel: typeof body.destinationLabel === 'string' ? body.destinationLabel.slice(0, 80) : '',
    ...win,
  });
  if (error) return res.status(409).json({ error });

  res.status(201).json({ ...booking, balance: getBalance(userName) });
});

/** ?date=YYYY-MM-DD and/or ?spotId=... to filter. */
app.get('/api/bookings', (req, res) => {
  const { date, spotId } = req.query;
  if (date !== undefined && !isValidDate(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  res.json(getBookings().filter((b) => (!date || b.date === date) && (!spotId || b.spotId === spotId)));
});

app.delete('/api/bookings', (_req, res) => {
  resetLive();
  clearBookings();
  res.status(204).end();
});

app.post('/api/reset', (_req, res) => {
  resetLive();
  const db = resetToSeed();
  res.json({ ok: true, spots: db.spots.length });
});

app.listen(PORT, () => {
  const r = routingStatus();
  console.log(`Instant Park Assist running at http://localhost:${PORT}`);
  console.log(
    r.enabled
      ? `Walking distances: ${r.url} (${r.profile}), ${r.cachedPairs} cached pairs`
      : `Walking distances: routing off, cache + straight-line estimates only`
  );
});

// Persist routed distances so demos can replay without the network.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    saveRouteCache();
    process.exit(0);
  });
}
