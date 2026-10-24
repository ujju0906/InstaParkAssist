/**
 * Instant Park Assist — Express server.
 *
 * Serves the web client and a small JSON API. Every /api route except auth
 * and the points rules needs a signed-in account. Roles are "member" (parks
 * and hosts) and "admin". Who can call each route:
 *
 * Accounts (public):
 *   POST   /api/auth/register    create a member account, signs in
 *   POST   /api/auth/login       sign in { username, password }
 *   POST   /api/auth/logout      sign out
 *   GET    /api/auth/me          the signed-in account (or { user: null })
 *   GET    /api/points           points rules (welcome grant, points per hour)
 *
 *   GET    /api/spots            any role    list spots (?date= only those offered that day)
 *   POST   /api/spots            any role    add a spot (daily hours + optional date range)
 *   DELETE /api/spots/:id        owner/admin remove a spot
 *   GET    /api/hosts            admin       hosts directory with every host's bookings and points
 *   GET    /api/members          admin       every member's points balance
 *   GET    /api/members/:name    self/admin  one member's balance + history
 *   POST   /api/assign           any role    instant assignment, nothing booked (admins: batches)
 *   POST   /api/book             any role    book a date + time window as yourself
 *   GET    /api/bookings         any role    list bookings you can see (?date=, ?spotId=)
 *   DELETE /api/bookings         admin       clear all bookings and points (keeps spots)
 *   POST   /api/reset            admin       reset data back to the seed
 *
 * Live batching (demo), admin only:
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
  getSessionSecret,
  getUserById,
  getUserByUsername,
  hasAdmin,
  isNameTaken,
  createUser,
  updateUser,
} from './src/store.js';
import {
  AuthError,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  Throttle,
  createSessionToken,
  generatePassword,
  hashPassword,
  normalizeUsername,
  parseCookies,
  publicUser,
  readSessionToken,
  validatePassword,
  validateSignup,
  verifyPassword,
} from './src/auth.js';
import { assignRequests } from './src/assign.js';
import { normalizeRequest, normalizeWindow, validateSpotInput, RequestError } from './src/requests.js';
import { isValidDate } from './src/dates.js';
import { WELCOME_POINTS, POINTS_PER_HOUR, memberKey } from './src/points.js';

const minutesToTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
import { Batcher } from './src/batcher.js';
import { Simulator } from './src/simulator.js';
import { routingStatus, saveRouteCache } from './src/routing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// --- Accounts & sessions ---------------------------------------------------

const sessionSecret = getSessionSecret();

/** Attach the signed-in account (if any) as req.user. */
app.use((req, _res, next) => {
  const uid = readSessionToken(parseCookies(req.headers.cookie)[SESSION_COOKIE], sessionSecret);
  req.user = uid ? getUserById(uid) || null : null;
  next();
});

/** Allow the route only for signed-in accounts with one of these roles (any role if none given). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'sign in first' });
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'your account does not have access to this' });
    }
    next();
  };
}
const signedIn = requireRole();
const adminOnly = requireRole('admin');
const isAdmin = (req) => req.user?.role === 'admin';

function setSessionCookie(req, res, user) {
  res.cookie(SESSION_COOKIE, createSessionToken(user.id, sessionSecret), {
    httpOnly: true,
    // Strict: the browser never sends the cookie on cross-site requests, so
    // other sites can't trigger bookings or resets as the signed-in user.
    sameSite: 'strict',
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function sendAuthError(res, err) {
  if (err instanceof AuthError) return res.status(err.status).json({ error: err.message });
  throw err;
}

// 10 failed logins per username+IP per 15 min; 20 sign-ups per IP per hour.
const loginThrottle = new Throttle({ limit: 10, windowMs: 15 * 60 * 1000 });
const signupThrottle = new Throttle({ limit: 20, windowMs: 60 * 60 * 1000 });

app.post('/api/auth/register', async (req, res) => {
  try {
    if (signupThrottle.isBlocked(req.ip)) throw new AuthError('too many sign-ups, try again later', 429);
    const input = validateSignup(req.body);
    if (getUserByUsername(input.username)) throw new AuthError('that username is taken', 409);
    if (isNameTaken(input.displayName)) {
      throw new AuthError('that display name is already used by another member, pick another', 409);
    }
    signupThrottle.hit(req.ip);
    const { salt, hash } = await hashPassword(input.password);
    // Re-check after the async hash, in case of a concurrent sign-up.
    if (getUserByUsername(input.username)) throw new AuthError('that username is taken', 409);
    if (isNameTaken(input.displayName)) {
      throw new AuthError('that display name is already used by another member, pick another', 409);
    }
    const user = createUser({ ...input, salt, hash });
    setSessionCookie(req, res, user);
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    sendAuthError(res, err);
  }
});

app.post('/api/auth/login', async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const key = `${req.ip}|${username}`;
  if (loginThrottle.isBlocked(key)) {
    return res.status(429).json({ error: 'too many failed sign-ins, try again in 15 minutes' });
  }
  const user = getUserByUsername(username);
  // Hash even for unknown usernames so response time doesn't reveal which exist.
  const ok = await verifyPassword(String(req.body?.password ?? ''), user?.salt || 'x', user?.hash || '00');
  if (!user || !ok) {
    loginThrottle.hit(key);
    return res.status(401).json({ error: 'wrong username or password' });
  }
  loginThrottle.reset(key);
  setSessionCookie(req, res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
  res.status(204).end();
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: publicUser(req.user) });
});

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

app.get('/api/events', adminOnly, (req, res) => {
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

app.get('/api/live', adminOnly, (_req, res) => {
  res.json(liveSnapshot());
});

/** Body: a single request object, or { requests: [...] } (max 50). */
app.post('/api/requests', adminOnly, (req, res) => {
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

app.post('/api/simulate/start', adminOnly, (req, res) => {
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

app.post('/api/simulate/stop', adminOnly, (_req, res) => {
  simulator.stop();
  res.json(simulator.status());
});

// --- Spots -----------------------------------------------------------------

const ownsSpot = (user, spot) => Boolean(user && spot.ownerId && spot.ownerId === user.id);

app.get('/api/spots', signedIn, (req, res) => {
  const date = req.query.date;
  if (date === undefined) return res.json(getSpots());
  if (!isValidDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  res.json(getSpots().filter((s) => isSpotOpenOnDate(s, date)));
});

/** Members always list under their own name; admins may list on behalf of any host name. */
app.post('/api/spots', signedIn, (req, res) => {
  try {
    const input = validateSpotInput(req.body);
    if (!isAdmin(req) || !input.hostName) input.hostName = req.user.displayName;
    res.status(201).json(addSpot(input, req.user.id));
  } catch (err) {
    if (err instanceof RequestError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

app.delete('/api/spots/:id', signedIn, (req, res) => {
  const spot = getSpot(req.params.id);
  if (!spot) return res.status(404).json({ error: 'spot not found' });
  if (!isAdmin(req) && !ownsSpot(req.user, spot)) {
    return res.status(403).json({ error: 'you can only remove your own spots' });
  }
  removeSpot(spot.id);
  res.status(204).end();
});

// --- Hosts -----------------------------------------------------------------

/**
 * Hosts directory: spots grouped by host name, with booking counts and the
 * community points each host has earned from them. Admin only.
 *
 * ?date=YYYY-MM-DD narrows bookings/points to that date, marks whether each
 * spot is offered that day, and lists that day's bookings per spot.
 */
app.get('/api/hosts', adminOnly, (req, res) => {
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
app.get('/api/members', adminOnly, (_req, res) => {
  res.json(getMembers().sort((a, b) => a.name.localeCompare(b.name)));
});

/** One member's balance and recent history: your own, or anyone's for admins. */
app.get('/api/members/:name', signedIn, (req, res) => {
  const name = String(req.params.name).trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!isAdmin(req) && memberKey(name) !== memberKey(req.user.displayName)) {
    return res.status(403).json({ error: 'you can only see your own points' });
  }
  res.json(getMember(name));
});

// --- Instant assignment ----------------------------------------------------

/**
 * Body: { requests: [{ userName?, lat, lng, label?, date?, startTime, hours }] }
 * date is "YYYY-MM-DD" (default today); startTime is "HH:MM"; hours is a
 * number. Returns the optimal assignment
 * (by walking distance along streets, with route geometry) without booking.
 *
 * Members send one request, always as themselves. Admins can send
 * batches with any names (the Batch optimize tool).
 */
app.post('/api/assign', signedIn, async (req, res) => {
  const rawRequests = (req.body && req.body.requests) || [];
  if (!Array.isArray(rawRequests) || rawRequests.length === 0) {
    return res.status(400).json({ error: 'requests array is required' });
  }
  if (rawRequests.length > 50) return res.status(400).json({ error: 'send at most 50 requests' });
  if (!isAdmin(req) && rawRequests.length !== 1) {
    return res.status(403).json({ error: 'only admins can optimize batches' });
  }

  let requests;
  try {
    requests = rawRequests.map((r, i) => {
      const n = normalizeRequest(r, i);
      if (!isAdmin(req) || !r.userName) n.userName = req.user.displayName;
      return n;
    });
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

/** Body: { spotId, date?, startTime, hours, destinationLabel? }. Always books as the signed-in account. */
app.post('/api/book', signedIn, (req, res) => {
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

  // Points are spent from the signed-in member, never a name from the request body.
  const userName = req.user.displayName;
  const { booking, error } = createBooking(spot, {
    userName,
    destinationLabel: typeof body.destinationLabel === 'string' ? body.destinationLabel.slice(0, 80) : '',
    ...win,
  });
  if (error) return res.status(409).json({ error });

  res.status(201).json({ ...booking, balance: getBalance(userName) });
});

/**
 * ?date=YYYY-MM-DD and/or ?spotId=... to filter. Admins see every booking;
 * others see their own bookings plus bookings on spots they host.
 */
app.get('/api/bookings', signedIn, (req, res) => {
  const { date, spotId } = req.query;
  if (date !== undefined && !isValidDate(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  const me = memberKey(req.user.displayName);
  const canSee = (b) => {
    if (isAdmin(req) || memberKey(b.userName) === me) return true;
    const spot = getSpot(b.spotId);
    return Boolean(spot && ownsSpot(req.user, spot));
  };
  res.json(
    getBookings().filter((b) => (!date || b.date === date) && (!spotId || b.spotId === spotId) && canSee(b))
  );
});

app.delete('/api/bookings', adminOnly, (_req, res) => {
  resetLive();
  clearBookings();
  res.status(204).end();
});

app.post('/api/reset', adminOnly, (_req, res) => {
  resetLive();
  const db = resetToSeed();
  res.json({ ok: true, spots: db.spots.length });
});

/**
 * Make sure an admin account exists. Admins can't sign up through the app.
 * - ADMIN_PASSWORD set: the ADMIN_USERNAME account (default "admin") is
 *   created, or its password reset, with that password.
 * - Otherwise, if there's no admin yet, "admin" is created with a random
 *   password that's printed once to this console.
 */
async function ensureAdmin() {
  const username = normalizeUsername(process.env.ADMIN_USERNAME || 'admin');
  const envPassword = process.env.ADMIN_PASSWORD;
  if (!envPassword && hasAdmin()) return;

  const password = envPassword ? validatePassword(envPassword) : generatePassword();
  const { salt, hash } = await hashPassword(password);
  const existing = getUserByUsername(username);
  if (existing) {
    updateUser(existing.id, { role: 'admin', salt, hash });
    console.log(`Admin account "${username}": password set from ADMIN_PASSWORD.`);
  } else {
    createUser({ username, displayName: 'Admin', role: 'admin', salt, hash });
    console.log(
      envPassword
        ? `Created admin account "${username}" with the password from ADMIN_PASSWORD.`
        : `Created admin account "${username}" with password: ${password}\n` +
            '  (shown once; set ADMIN_PASSWORD and restart to change it)'
    );
  }
}

try {
  await ensureAdmin();
} catch (err) {
  console.error(`Could not set up the admin account: ${err.message}`);
  process.exit(1);
}

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
