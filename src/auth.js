/**
 * Accounts and sessions, with no dependencies beyond node:crypto.
 *
 * - Passwords are hashed with scrypt and a per-user random salt.
 * - Sessions are stateless signed cookies: base64url(JSON { uid, exp }) + "." +
 *   HMAC-SHA256 signature. The user is looked up on every request, so a
 *   deleted account loses access immediately.
 * - Roles: "member" (parks and hosts spots) and "admin" (everything,
 *   including the live demo and data resets). Sign-ups are always members;
 *   admins are created at server start (see ensureAdmin in server.js).
 *
 * No file I/O here: accounts and the signing secret live in store.js.
 */

import { scrypt, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export const ROLES = ['member', 'admin'];
/** The role every sign-up gets. */
export const SIGNUP_ROLE = 'member';

export const SESSION_COOKIE = 'ipa_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const MAX_DISPLAY_NAME = 40;
const KEY_LEN = 64;

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// --- Validation ------------------------------------------------------------

export function normalizeUsername(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** Validate sign-up input. Returns cleaned { username, password, displayName, role }. */
export function validateSignup(body = {}) {
  const username = normalizeUsername(body.username);
  if (!USERNAME_RE.test(username)) {
    throw new AuthError('username must be 3-32 characters: letters, numbers, ".", "_" or "-"');
  }
  const password = validatePassword(body.password);
  const displayName = String(body.displayName ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_DISPLAY_NAME) || username;
  // Any role in the body is ignored: sign-ups are always members.
  return { username, password, displayName, role: SIGNUP_ROLE };
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new AuthError(`password must be at least ${MIN_PASSWORD} characters`);
  }
  if (password.length > MAX_PASSWORD) throw new AuthError('password is too long');
  return password;
}

// --- Passwords -------------------------------------------------------------

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, KEY_LEN)).toString('hex');
  return { salt, hash };
}

export async function verifyPassword(password, salt, hash) {
  if (typeof password !== 'string' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = await scryptAsync(password, salt, KEY_LEN);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Random password for the bootstrap admin account. */
export function generatePassword() {
  return randomBytes(12).toString('base64url');
}

export function generateSecret() {
  return randomBytes(32).toString('hex');
}

// --- Session tokens --------------------------------------------------------

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createSessionToken(userId, secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: now + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns the user id from a valid, unexpired token, else null. */
export function readSessionToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof uid !== 'string' || typeof exp !== 'number' || exp < now) return null;
    return uid;
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie values */
    }
  }
  return out;
}

// --- Brute-force throttle --------------------------------------------------

/**
 * Fixed-window counter: allow `limit` hits per key per `windowMs`.
 * In memory, so it resets when the server restarts.
 */
export class Throttle {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  #entry(key, now) {
    let e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, e);
    }
    return e;
  }

  isBlocked(key, now = Date.now()) {
    return this.#entry(key, now).count >= this.limit;
  }

  hit(key, now = Date.now()) {
    this.#entry(key, now).count += 1;
    // Keep the map from growing without bound.
    if (this.hits.size > 10000) {
      for (const [k, e] of this.hits) if (e.resetAt <= now) this.hits.delete(k);
    }
  }

  reset(key) {
    this.hits.delete(key);
  }
}

/** The account fields that are safe to send to the browser. */
export function publicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role };
}
