/**
 * Assignment engine.
 *
 * Turns a set of parking requests (each with a destination + time window) and
 * the pool of spots into an optimal assignment that minimizes total walking
 * distance, using the Hungarian algorithm.
 *
 * Costs are WALKING distances along the street/footpath network (see
 * routing.js), not straight lines, because people can't walk through
 * buildings. Availability is checked per request: if a spot can't serve a
 * driver's date + time window, that cell of the cost matrix is Infinity
 * (forbidden).
 */

import { hungarian } from './hungarian.js';
import { haversineMeters, walkMinutes } from './distance.js';
import { getSpots, isSpotAvailable } from './store.js';
import { walkingMatrix, walkingRoutes } from './routing.js';

/**
 * Spots farther than this in a straight line are never considered. A walk is
 * always at least the straight-line distance, so this safely trims the router
 * query without changing any sensible assignment.
 */
export const MAX_STRAIGHT_LINE_M = 2000;

/**
 * Build the cost matrix. Rows = requests, cols = spots usable by at least one
 * request. cost[i][j] = walking meters, or Infinity if spot j can't serve i.
 */
export async function buildProblem(requests) {
  const usable = (r, s) =>
    isSpotAvailable(s, r.date, r.startMin, r.endMin) && haversineMeters(r, s) <= MAX_STRAIGHT_LINE_M;

  const candidateSpots = getSpots().filter((s) => requests.some((r) => usable(r, s)));
  if (candidateSpots.length === 0) {
    return { candidateSpots, cost: requests.map(() => []), distanceSource: 'routed' };
  }

  const { matrix, source } = await walkingMatrix(candidateSpots, requests);
  const cost = requests.map((r, i) =>
    candidateSpots.map((s, j) => (usable(r, s) ? matrix[i][j] : Infinity))
  );
  return { candidateSpots, cost, distanceSource: source };
}

/**
 * Greedy baseline: requests in arrival order each take their closest
 * still-free allowed spot. Used to show what Hungarian improves on.
 */
export function greedyAssign(cost) {
  const taken = new Set();
  let totalCost = 0;
  const assignment = cost.map((row) => {
    let best = -1;
    let bestD = Infinity;
    row.forEach((d, j) => {
      if (!taken.has(j) && d < bestD) {
        bestD = d;
        best = j;
      }
    });
    if (best >= 0) {
      taken.add(best);
      totalCost += bestD;
    }
    return best;
  });
  return { assignment, totalCost };
}

function emptyResult() {
  return {
    assignments: [],
    unassigned: [],
    totalWalkMeters: 0,
    candidateSpots: [],
    cost: [],
    assignment: [],
    greedyAssignment: [],
    distanceSource: 'routed',
    solveMs: 0,
    comparison: {
      hungarianTotalWalkMeters: 0,
      greedyTotalWalkMeters: 0,
      hungarianAssigned: 0,
      greedyAssigned: 0,
      savedMeters: 0,
    },
  };
}

/**
 * @param {Array<{id:string,userName:string,lat:number,lng:number,label:string,startMin:number,endMin:number}>} requests
 * @param {{ withRoutes?: boolean }} [opts] withRoutes: attach walking path geometry to each assignment
 */
export async function assignRequests(requests, { withRoutes = true } = {}) {
  if (!Array.isArray(requests) || requests.length === 0) return emptyResult();

  const { candidateSpots, cost, distanceSource } = await buildProblem(requests);

  const t0 = performance.now();
  const { assignment } = hungarian(cost);
  const solveMs = +(performance.now() - t0).toFixed(3);

  const greedy = greedyAssign(cost);

  const assignments = [];
  const unassigned = [];
  let totalWalkMeters = 0;

  requests.forEach((req, i) => {
    const col = assignment[i];
    if (col >= 0) {
      const spot = candidateSpots[col];
      const meters = cost[i][col];
      totalWalkMeters += meters;
      assignments.push({
        request: req,
        spot,
        walkMeters: Math.round(meters),
        walkMinutes: Math.max(1, Math.round(walkMinutes(meters))),
        price: +(spot.pricePerHour * ((req.endMin - req.startMin) / 60)).toFixed(2),
        route: null,
      });
    } else {
      unassigned.push({
        ...req,
        reason:
          candidateSpots.length === 0
            ? 'no spots within 2 km are free on that date and time'
            : 'no free spot left for that date and time',
      });
    }
  });

  if (withRoutes && assignments.length > 0) {
    const routes = await walkingRoutes(assignments.map((a) => ({ from: a.spot, to: a.request })));
    assignments.forEach((a, k) => (a.route = routes[k]));
  }

  const hungarianAssigned = assignments.length;
  const greedyAssigned = greedy.assignment.filter((j) => j >= 0).length;
  const hungarianTotal = Math.round(totalWalkMeters);
  const greedyTotal = Math.round(greedy.totalCost);

  return {
    assignments,
    unassigned,
    totalWalkMeters: hungarianTotal,
    candidateSpots,
    cost,
    assignment,
    greedyAssignment: greedy.assignment,
    distanceSource,
    solveMs,
    comparison: {
      hungarianTotalWalkMeters: hungarianTotal,
      greedyTotalWalkMeters: greedyTotal,
      hungarianAssigned,
      greedyAssigned,
      // Distance savings are only comparable when both park the same number of drivers.
      savedMeters: greedyAssigned === hungarianAssigned ? Math.max(0, greedyTotal - hungarianTotal) : 0,
    },
  };
}
