import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hungarian } from '../src/hungarian.js';

test('empty matrix', () => {
  const { assignment, totalCost } = hungarian([]);
  assert.deepEqual(assignment, []);
  assert.equal(totalCost, 0);
});

test('1x1', () => {
  const { assignment, totalCost } = hungarian([[42]]);
  assert.deepEqual(assignment, [0]);
  assert.equal(totalCost, 42);
});

test('classic 3x3 optimum', () => {
  // Known optimal assignment: rows->cols [1,0,2], cost 5.
  const cost = [
    [4, 1, 3],
    [2, 0, 5],
    [3, 2, 2],
  ];
  const { assignment, totalCost } = hungarian(cost);
  assert.equal(totalCost, 5);
  // Each column used exactly once.
  assert.equal(new Set(assignment).size, 3);
});

test('beats greedy — avoids the greedy trap', () => {
  // Greedy by row would take row0->col0 (1), forcing row1->col1 (100): total 101.
  // Optimal: row0->col1 (2), row1->col0 (2): total 4.
  const cost = [
    [1, 2],
    [2, 100],
  ];
  const { assignment, totalCost } = hungarian(cost);
  assert.equal(totalCost, 4);
  assert.deepEqual(assignment, [1, 0]);
});

test('more requests than spots parks as many as possible', () => {
  // 3 requests, 2 spots. One request must go unassigned (-1).
  const cost = [
    [10, 20],
    [30, 5],
    [8, 40],
  ];
  const { assignment } = hungarian(cost);
  const assigned = assignment.filter((c) => c >= 0);
  assert.equal(assigned.length, 2); // both spots used
  assert.equal(new Set(assigned).size, 2); // distinct spots
  assert.equal(assignment.filter((c) => c === -1).length, 1); // one unparked
});

test('more spots than requests leaves spare spots', () => {
  const cost = [[5, 9, 7]];
  const { assignment, totalCost } = hungarian(cost);
  assert.equal(assignment[0], 0); // picks the cheapest spot
  assert.equal(totalCost, 5);
});

test('symmetric optimum found regardless of ordering', () => {
  const cost = [
    [90, 75, 75, 80],
    [35, 85, 55, 65],
    [125, 95, 90, 105],
    [45, 110, 95, 115],
  ];
  const { totalCost } = hungarian(cost);
  assert.equal(totalCost, 275); // known optimum for this standard instance
});

test('Infinity marks a forbidden pair (row left unassigned)', () => {
  const cost = [
    [1, Infinity],
    [Infinity, Infinity],
  ];
  const { assignment, totalCost } = hungarian(cost);
  assert.deepEqual(assignment, [0, -1]);
  assert.equal(totalCost, 1);
});

test('forbidden pair steers the optimum to the allowed option', () => {
  // Row 1 can only use col 1, so row 0 must take col 0 even though both are cheap.
  const cost = [
    [1, 2],
    [Infinity, 5],
  ];
  const { assignment, totalCost } = hungarian(cost);
  assert.deepEqual(assignment, [0, 1]);
  assert.equal(totalCost, 6);
});

test('maximizes allowed assignments before minimizing distance', () => {
  // Cheapest single choice is row0->col0 (1), but that strands row1.
  // Optimal parks both: row0->col1 (50), row1->col0 (60).
  const cost = [
    [1, 50],
    [60, Infinity],
  ];
  const { assignment } = hungarian(cost);
  assert.deepEqual(assignment, [1, 0]);
});
