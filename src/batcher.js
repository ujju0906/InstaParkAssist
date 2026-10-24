/**
 * Live batching queue.
 *
 * Incoming parking requests are held for a short window (server default 5s). When the
 * window closes, or the batch reaches `maxBatch`, the whole batch is assigned at
 * once with the Hungarian algorithm and every match is booked.
 *
 * Batching is what makes Hungarian worthwhile: assigning requests one at a time
 * is just greedy. Waiting a few seconds lets the solver trade spots between
 * drivers so the batch's total walking distance is as small as possible.
 *
 * Solving is async (walking distances come from a router), so batches are
 * solved strictly one after another: a batch only sees spots after the previous
 * batch's bookings are written. Each spot is re-checked right before booking in
 * case it was booked through another path while the router was answering.
 *
 * Events:
 *   'request' { request, pending, stats }   a request joined the queue
 *   'window'  { remainingMs, windowMs }     a batch window opened
 *   'solving' { size }                      a batch closed; fetching walking routes
 *   'batch'   { ...full batch payload }     a batch was solved and booked
 */

import { EventEmitter } from 'node:events';
import { assignRequests } from './assign.js';
import { addBooking, isSpotAvailable } from './store.js';
import { normalizeRequest } from './requests.js';

function emptyStats() {
  return { received: 0, assigned: 0, unassigned: 0, batches: 0, metersSaved: 0 };
}

export class Batcher extends EventEmitter {
  constructor({ windowMs = 4000, maxBatch = 6 } = {}) {
    super();
    this.windowMs = windowMs;
    this.maxBatch = maxBatch;
    this.pending = [];
    this.timer = null;
    this.closesAt = null;
    this.stats = emptyStats();
    this.chain = Promise.resolve(); // serializes batch solving
    this.generation = 0; // bumped by clear() so in-flight batches are dropped
  }

  /** Validate and queue one raw request. Throws RequestError on bad input. */
  enqueue(raw) {
    const request = normalizeRequest(raw, this.stats.received);
    this.stats.received += 1;
    request.seq = this.stats.received; // display number (#1, #2, ...)
    this.pending.push(request);

    this.emit('request', { request, pending: this.pending.length, stats: { ...this.stats } });

    if (this.pending.length >= this.maxBatch) {
      this.flush();
    } else if (!this.timer) {
      this.closesAt = Date.now() + this.windowMs;
      this.timer = setTimeout(() => this.flush(), this.windowMs);
      this.emit('window', { remainingMs: this.windowMs, windowMs: this.windowMs });
    }
    return request;
  }

  /**
   * Close the current window and queue its requests for solving.
   * Returns a promise for the batch payload (null if empty or dropped).
   */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    this.closesAt = null;
    if (this.pending.length === 0) return Promise.resolve(null);

    const batch = this.pending.splice(0, this.pending.length);
    const gen = this.generation;
    this.emit('solving', { size: batch.length });

    const run = () => this.solve(batch, gen);
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  async solve(batch, gen) {
    try {
      const result = await assignRequests(batch);
      if (gen !== this.generation) return null; // reset while routing

      const unassigned = result.unassigned.map((u) => ({ requestId: u.id, reason: u.reason }));
      const assignments = [];

      for (const a of result.assignments) {
        if (!isSpotAvailable(a.spot, a.request.date, a.request.startMin, a.request.endMin)) {
          unassigned.push({ requestId: a.request.id, reason: 'spot was booked by someone else while solving' });
          continue;
        }
        const booking = addBooking({
          spotId: a.spot.id,
          userName: a.request.userName,
          destinationLabel: a.request.label,
          date: a.request.date,
          startTime: a.request.startTime,
          hours: a.request.hours,
          startMin: a.request.startMin,
          endMin: a.request.endMin,
          price: a.price,
          walkMeters: a.walkMeters,
          source: 'batch',
        });
        assignments.push({
          requestId: a.request.id,
          spotId: a.spot.id,
          walkMeters: a.walkMeters,
          walkMinutes: a.walkMinutes,
          price: a.price,
          route: a.route, // [[lat, lng], ...] along streets, or null
          bookingId: booking.id,
        });
      }

      this.stats.batches += 1;
      this.stats.assigned += assignments.length;
      this.stats.unassigned += unassigned.length;
      this.stats.metersSaved += result.comparison.savedMeters;

      const payload = {
        batchId: this.stats.batches,
        requests: batch,
        spots: result.candidateSpots.map(({ id, label, hostName, lat, lng, pricePerHour }) => ({
          id,
          label,
          hostName,
          lat,
          lng,
          pricePerHour,
        })),
        // Walking meters along streets; null = not available for that time window
        cost: result.cost.map((row) => row.map((c) => (Number.isFinite(c) ? Math.round(c) : null))),
        distanceSource: result.distanceSource,
        assignment: result.assignment,
        greedyAssignment: result.greedyAssignment,
        assignments,
        unassigned,
        comparison: result.comparison,
        solveMs: result.solveMs,
        pending: this.pending.length,
        stats: { ...this.stats },
      };

      this.emit('batch', payload);
      return payload;
    } catch (err) {
      console.error('Batch failed:', err);
      return null;
    }
  }

  /** Drop the queue and reset counters (used by reset / new simulation). */
  clear() {
    clearTimeout(this.timer);
    this.timer = null;
    this.closesAt = null;
    this.pending = [];
    this.stats = emptyStats();
    this.generation += 1;
  }

  snapshot() {
    return {
      windowMs: this.windowMs,
      maxBatch: this.maxBatch,
      pending: this.pending,
      remainingMs: this.closesAt ? Math.max(0, this.closesAt - Date.now()) : null,
      stats: { ...this.stats },
    };
  }
}
