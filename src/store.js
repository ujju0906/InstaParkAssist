/**
 * Tiny JSON-file-backed data store.
 *
 * Keeps the demo dependency-free (no database needed). Data persists to
 * data/db.json between restarts. If that file is missing, it's seeded from
 * data/seed.json.
 *
 * Holds spots, bookings, the community points ledger (see points.js), and
 * login accounts (see auth.js). Balances are never stored; they're the sum
 * of a member's ledger entries, so the books always balance.
 *
 * Accounts and the session-signing secret survive "reset demo data" and
 * "clear bookings", so resetting never locks anyone out.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { todayISO } from './dates.js';
import { WELCOME_POINTS, pointsFor, memberKey } from './points.js';
import { generateSecret } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'db.json');
const SEED_PATH = join(DATA_DIR, 'seed.json');

function emptyDb(spots = [], users = [], sessionSecret = null) {
  return { spots, bookings: [], members: {}, ledger: [], users, sessionSecret };
}

function seedSpots() {
  return existsSync(SEED_PATH) ? JSON.parse(readFileSync(SEED_PATH, 'utf8')).spots ?? [] : [];
}

function load() {
  if (existsSync(DB_PATH)) return JSON.parse(readFileSync(DB_PATH, 'utf8'));
  return emptyDb(seedSpots());
}

function persist() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

let db = load();

// Migrate data saved by older versions.
{
  const today = todayISO();
  let changed = false;
  db.members ??= {};
  db.ledger ??= [];
  db.users ??= [];
  db.sessionSecret ??= null;
  for (const u of db.users) {
    // Driver ("user") and "host" accounts merged into one "member" role.
    if (u.role === 'user' || u.role === 'host') {
      u.role = 'member';
      changed = true;
    }
  }
  for (const s of db.spots) {
    // Spots no longer have prices: parking costs the same flat points everywhere.
    if ('pricePerHour' in s) {
      delete s.pricePerHour;
      changed = true;
    }
  }
  for (const b of db.bookings) {
    // Bookings made before dates existed: pin them to today so they still
    // block their time slot instead of silently blocking every day.
    if (!b.date) {
      b.date = today;
      changed = true;
    }
    // Bookings made with money: drop the price and record what it would cost
    // in points (no ledger entries are back-filled for them).
    if ('price' in b || b.points == null) {
      delete b.price;
      b.points ??= pointsFor(b.hours);
      changed = true;
    }
  }
  if (changed) persist();
}

// --- Spots -----------------------------------------------------------------

export function getSpots() {
  return db.spots;
}

export function getSpot(id) {
  return db.spots.find((s) => s.id === id);
}

/**
 * Expects input already validated by validateSpotInput() (requests.js).
 * ownerId is the account that may manage the spot (null for seed spots,
 * which only admins can remove).
 */
export function addSpot(spot, ownerId = null) {
  const record = {
    id: randomUUID(),
    ownerId,
    hostName: spot.hostName?.trim() || 'Anonymous host',
    label: spot.label?.trim() || 'Parking spot',
    lat: Number(spot.lat),
    lng: Number(spot.lng),
    // Daily availability window as "HH:MM" strings (local), inclusive start, exclusive end.
    availableFrom: spot.availableFrom || '00:00',
    availableUntil: spot.availableUntil || '23:59',
    // Date range the spot is offered, "YYYY-MM-DD", inclusive. null = no limit.
    availableFromDate: spot.availableFromDate || null,
    availableUntilDate: spot.availableUntilDate || null,
    createdAt: new Date().toISOString(),
  };
  db.spots.push(record);
  ensureMember(record.hostName);
  persist();
  return record;
}

export function removeSpot(id) {
  const before = db.spots.length;
  db.spots = db.spots.filter((s) => s.id !== id);
  const changed = db.spots.length !== before;
  if (changed) persist();
  return changed;
}

// --- Members & points ------------------------------------------------------

/** Create the member on first use, with the one-time welcome grant. Does not persist. */
function ensureMember(name) {
  const key = memberKey(name);
  if (!db.members[key]) {
    db.members[key] = { name: String(name).trim(), joinedAt: new Date().toISOString() };
    db.ledger.push({
      id: randomUUID(),
      member: key,
      delta: WELCOME_POINTS,
      reason: 'welcome',
      at: new Date().toISOString(),
    });
  }
  return key;
}

function entriesFor(key) {
  return db.ledger.filter((e) => e.member === key);
}

/** Current balance. Unknown names report the welcome balance they'd start with. */
export function getBalance(name) {
  const key = memberKey(name);
  if (!db.members[key]) return WELCOME_POINTS;
  return entriesFor(key).reduce((sum, e) => sum + e.delta, 0);
}

/** Summary for one member: balance, points given (hosting) and spent (parking), history. */
export function getMember(name) {
  const key = memberKey(name);
  const member = db.members[key];
  if (!member) {
    return { name: String(name).trim(), isNew: true, balance: WELCOME_POINTS, earned: 0, spent: 0, history: [] };
  }
  const entries = entriesFor(key);
  return {
    name: member.name,
    isNew: false,
    joinedAt: member.joinedAt,
    balance: entries.reduce((sum, e) => sum + e.delta, 0),
    earned: entries.filter((e) => e.reason === 'hosted').reduce((sum, e) => sum + e.delta, 0),
    spent: -entries.filter((e) => e.reason === 'parked').reduce((sum, e) => sum + e.delta, 0),
    history: entries.slice(-20).reverse(),
  };
}

export function getMembers() {
  return Object.keys(db.members).map((key) => {
    const { history, ...summary } = getMember(db.members[key].name);
    return summary;
  });
}

// --- Bookings --------------------------------------------------------------

export function getBookings() {
  return db.bookings;
}

/**
 * Book a spot and move the points from driver to host in one step, so a
 * booking can never exist without its payment (or vice versa).
 * Callers check availability first with isSpotAvailable().
 *
 * @returns {{ booking } | { error: string }}
 */
export function createBooking(spot, booking) {
  const points = pointsFor(booking.hours);
  const driver = ensureMember(booking.userName);
  const host = ensureMember(spot.hostName);
  const balance = getBalance(booking.userName);
  if (balance < points) {
    persist(); // keep the new member + welcome grant
    return { error: `not enough points (needs ${points}, has ${balance})` };
  }

  const record = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...booking,
    spotId: spot.id,
    hostName: spot.hostName,
    points,
  };
  db.bookings.push(record);

  const at = record.createdAt;
  db.ledger.push(
    { id: randomUUID(), member: driver, delta: -points, reason: 'parked', bookingId: record.id, at },
    { id: randomUUID(), member: host, delta: points, reason: 'hosted', bookingId: record.id, at }
  );
  persist();
  return { booking: record };
}

/** Is the spot offered at all on this date (ignores time of day and bookings)? */
export function isSpotOpenOnDate(spot, date) {
  if (spot.availableFromDate && date < spot.availableFromDate) return false;
  if (spot.availableUntilDate && date > spot.availableUntilDate) return false;
  return true;
}

/**
 * A spot is bookable for a requested date + time window if:
 *   - the date is inside the spot's offered date range,
 *   - the time window fits inside the spot's daily hours, and
 *   - no existing booking on the SAME date overlaps the time window.
 * Bookings are single-day (they can't run past the spot's closing time).
 */
export function isSpotAvailable(spot, date, startMin, endMin) {
  if (!isSpotOpenOnDate(spot, date)) return false;

  const from = toMinutes(spot.availableFrom);
  const until = toMinutes(spot.availableUntil);
  if (startMin < from || endMin > until) return false;

  const overlap = db.bookings.some(
    (b) =>
      b.spotId === spot.id &&
      b.date === date &&
      startMin < b.endMin &&
      endMin > b.startMin
  );
  return !overlap;
}

export function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Remove all bookings and reset everyone's points (keeps spots, including
 * host-added ones). Points only exist because of bookings, so both go together.
 */
export function clearBookings() {
  db.bookings = [];
  db.members = {};
  db.ledger = [];
  persist();
}

/** Back to the seed spots, keeping accounts and the session secret. */
export function resetToSeed() {
  db = emptyDb(seedSpots(), db.users, db.sessionSecret);
  persist();
  return db;
}

// --- Accounts --------------------------------------------------------------

/** HMAC secret for session cookies. SESSION_SECRET env wins; else generated once and kept in db.json. */
export function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!db.sessionSecret) {
    db.sessionSecret = generateSecret();
    persist();
  }
  return db.sessionSecret;
}

export function getUserById(id) {
  return db.users.find((u) => u.id === id);
}

export function getUserByUsername(username) {
  return db.users.find((u) => u.username === username);
}

export function hasAdmin() {
  return db.users.some((u) => u.role === 'admin');
}

/**
 * Is this display name already someone's identity? Points and spots are
 * keyed by name, so a new account must not take over an existing member,
 * host, or account name.
 */
export function isNameTaken(displayName) {
  const key = memberKey(displayName);
  return (
    db.users.some((u) => memberKey(u.displayName) === key) ||
    Boolean(db.members[key]) ||
    db.spots.some((s) => memberKey(s.hostName) === key)
  );
}

/** Expects input already validated (auth.js) and a hashed password. */
export function createUser({ username, displayName, role, salt, hash }) {
  const user = {
    id: randomUUID(),
    username,
    displayName,
    role,
    salt,
    hash,
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  persist();
  return user;
}

export function updateUser(id, changes) {
  const user = getUserById(id);
  if (!user) return null;
  Object.assign(user, changes);
  persist();
  return user;
}
