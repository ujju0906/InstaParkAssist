/**
 * In-process demo simulator: feeds driver requests into the batcher following
 * an arrival plan (random traffic or the scripted "rush" scenario). Started
 * from the "Live demo" tab via POST /api/simulate/start.
 *
 * Events:
 *   'status' { running, sent, total, scenario }
 */

import { EventEmitter } from 'node:events';
import { buildPlan, SCENARIOS } from './demoData.js';

export class Simulator extends EventEmitter {
  constructor(batcher) {
    super();
    this.batcher = batcher;
    this.running = false;
    this.timer = null;
    this.plan = [];
    this.sent = 0;
    this.scenario = 'random';
  }

  /** date: "YYYY-MM-DD" every simulated driver books for (validated by the caller). */
  start({ count = 16, speed = 'normal', scenario = 'random', date } = {}) {
    this.stop();
    this.scenario = SCENARIOS.includes(scenario) ? scenario : 'random';
    this.date = date || null;
    this.plan = buildPlan({
      scenario: this.scenario,
      count: Math.min(100, Math.max(1, Math.round(Number(count) || 16))),
      speed,
      date: this.date,
    });
    this.sent = 0;
    this.running = true;
    this.emitStatus();
    this.scheduleNext();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.running) {
      this.running = false;
      this.emitStatus();
    }
  }

  scheduleNext() {
    const step = this.plan[this.sent];
    this.timer = setTimeout(() => {
      if (!this.running) return;
      this.batcher.enqueue(step.request);
      this.sent += 1;
      if (this.sent >= this.plan.length) {
        // The batcher's open window closes on its own and solves the last batch.
        this.running = false;
      } else {
        this.scheduleNext();
      }
      this.emitStatus();
    }, step.delay);
  }

  status() {
    return {
      running: this.running,
      sent: this.sent,
      total: this.plan.length,
      scenario: this.scenario,
      date: this.date || null,
    };
  }

  emitStatus() {
    this.emit('status', this.status());
  }
}
