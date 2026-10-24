/**
 * Validation/normalization for incoming parking requests, bookings, and host
 * listings. Shared by the instant /api/assign route, /api/book, /api/spots,
 * and the live batching queue.
 */

import { randomUUID } from 'node:crypto';
import { toMinutes } from './store.js';
import { isValidDate, todayISO, addDays, MAX_DAYS_AHEAD } from './dates.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_TEXT = 80;

export class RequestError extends Error {}

function clip(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

/**
 * Validate the date + time window of a request or booking.
 * date: "YYYY-MM-DD", today up to MAX_DAYS_AHEAD days out (defaults to today).
 * Bookings are single-day: they must end by midnight.
 */
export function normalizeWindow(r = {}) {
  const today = todayISO();
  let date = today;
  if (r.date != null && r.date !== '') {
    if (!isValidDate(r.date)) throw new RequestError('date must be a real date in YYYY-MM-DD format');
    if (r.date < today) throw new RequestError('date is in the past');
    if (r.date > addDays(today, MAX_DAYS_AHEAD)) {
      throw new RequestError(`date can be at most ${MAX_DAYS_AHEAD} days ahead`);
    }
    date = r.date;
  }

  const startTime = TIME_RE.test(r.startTime) ? r.startTime : '09:00';
  const hours = Math.min(24, Math.max(0.5, Number(r.hours) || 1));
  const startMin = toMinutes(startTime);
  const endMin = startMin + Math.round(hours * 60);
  if (endMin > 24 * 60) throw new RequestError('booking must end by midnight on the same date');

  return { date, startTime, hours, startMin, endMin };
}

/**
 * @param {object} r raw request: { userName?, lat, lng, label?, date?, startTime?, hours? }
 * @param {number} i index, used for default names
 */
export function normalizeRequest(r = {}, i = 0) {
  const lat = Number(r.lat);
  const lng = Number(r.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new RequestError('each request needs valid numeric lat and lng');
  }

  return {
    id: r.id ? String(r.id).slice(0, 64) : randomUUID().slice(0, 8),
    userName: clip(r.userName) || `User ${i + 1}`,
    lat,
    lng,
    label: clip(r.label) || 'Destination',
    ...normalizeWindow(r),
  };
}

/**
 * Validate a host's new listing. Returns the cleaned fields for addSpot().
 * Date range is optional on both ends (blank = no limit).
 */
export function validateSpotInput(s = {}) {
  const lat = Number(s.lat);
  const lng = Number(s.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new RequestError('lat and lng are required numbers');
  }

  const availableFrom = s.availableFrom || '00:00';
  const availableUntil = s.availableUntil || '23:59';
  if (!TIME_RE.test(availableFrom) || !TIME_RE.test(availableUntil)) {
    throw new RequestError('daily hours must be HH:MM');
  }
  if (toMinutes(availableFrom) >= toMinutes(availableUntil)) {
    throw new RequestError('daily hours: "from" must be before "until"');
  }

  const fromDate = s.availableFromDate || null;
  const untilDate = s.availableUntilDate || null;
  for (const d of [fromDate, untilDate]) {
    if (d && !isValidDate(d)) throw new RequestError('available dates must be YYYY-MM-DD');
  }
  if (fromDate && untilDate && fromDate > untilDate) {
    throw new RequestError('available dates: start date must be on or before end date');
  }
  if (untilDate && untilDate < todayISO()) {
    throw new RequestError('available dates: end date is in the past');
  }

  // No price: every spot earns its host the same flat points (points.js).
  return {
    lat,
    lng,
    label: clip(s.label),
    hostName: clip(s.hostName),
    availableFrom,
    availableUntil,
    availableFromDate: fromDate,
    availableUntilDate: untilDate,
  };
}
