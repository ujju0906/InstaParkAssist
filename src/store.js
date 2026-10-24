/**
 * Tiny JSON-file-backed data store.
 *
 * Keeps the demo dependency-free (no database needed). Data persists to
 * data/db.json between restarts. If that file is missing, it's seeded from
 * data/seed.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { todayISO } from './dates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'db.json');
const SEED_PATH = join(DATA_DIR, 'seed.json');

function load() {
  if (existsSync(DB_PATH)) {
    return JSON.parse(readFileSync(DB_PATH, 'utf8'));
  }
  if (existsSync(SEED_PATH)) {
    const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
    return { spots: seed.spots ?? [], bookings: [] };
  }
  return { spots: [], bookings: [] };
}

let db = load();

// Bookings made before dates existed: pin them to today so they still block
// their time slot instead of silently blocking every day.
{
  const today = todayISO();
  let migrated = 0;
  for (const b of db.bookings) {
    if (!b.date) {
      b.date = today;
      migrated += 1;
    }
  }
  if (migrated) persist();
}

function persist() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// --- Spots -----------------------------------------------------------------

export function getSpots() {
  return db.spots;
}

export function getSpot(id) {
  return db.spots.find((s) => s.id === id);
}

/** Expects input already validated by validateSpotInput() (requests.js). */
export function addSpot(spot) {
  const record = {
    id: randomUUID(),
    hostName: spot.hostName?.trim() || 'Anonymous host',
    label: spot.label?.trim() || 'Parking spot',
    lat: Number(spot.lat),
    lng: Number(spot.lng),
    pricePerHour: Number(spot.pricePerHour) || 0,
    // Daily availability window as "HH:MM" strings (local), inclusive start, exclusive end.
    availableFrom: spot.availableFrom || '00:00',
    availableUntil: spot.availableUntil || '23:59',
    // Date range the spot is offered, "YYYY-MM-DD", inclusive. null = no limit.
    availableFromDate: spot.availableFromDate || null,
    availableUntilDate: spot.availableUntilDate || null,
    createdAt: new Date().toISOString(),
  };
  db.spots.push(record);
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

// --- Bookings --------------------------------------------------------------

export function getBookings() {
  return db.bookings;
}

export function addBooking(booking) {
  const record = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...booking,
  };
  db.bookings.push(record);
  persist();
  return record;
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

/** Remove all bookings but keep spots (including host-added ones). */
export function clearBookings() {
  db.bookings = [];
  persist();
}

export function resetToSeed() {
  if (existsSync(SEED_PATH)) {
    const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
    db = { spots: seed.spots ?? [], bookings: [] };
  } else {
    db = { spots: [], bookings: [] };
  }
  persist();
  return db;
}
