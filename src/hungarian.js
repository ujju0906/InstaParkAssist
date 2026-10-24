/**
 * Hungarian algorithm (Kuhn-Munkres) for the rectangular assignment problem.
 *
 * Given a cost matrix where cost[i][j] is the cost of assigning row i
 * (e.g. a parking request) to column j (e.g. a parking spot), this finds the
 * assignment that minimizes the TOTAL cost across all rows.
 *
 * This is the key difference from a greedy "nearest spot" approach: greedy can
 * make globally poor choices (an early user grabs a spot that would have been
 * far better for someone else). The Hungarian algorithm guarantees the optimal
 * global assignment, which here means minimum total walking distance.
 *
 * The core solver (`solveSquare`) is the classic O(n^3) potentials
 * implementation for an n x n matrix. `hungarian` handles non-square inputs by
 * padding to a square matrix:
 *   - dummy ROWS (when spots > requests) cost 0 -> they soak up leftover spots.
 *   - dummy COLS (when requests > spots) cost BIG -> the solver fills every real
 *     spot first (parks as many people as possible), then minimizes distance.
 *
 * Forbidden pairs (e.g. a spot that isn't available for that driver's time
 * window) are passed as Infinity. Internally they cost the same as "no spot",
 * so the solver still maximizes the number of allowed assignments first, and
 * any row that lands on a forbidden cell is reported as unassigned (-1).
 */

const INF = Infinity;

/**
 * Solve the assignment problem for a square n x n cost matrix.
 * Returns an array `assignment` where assignment[row] = column.
 */
function solveSquare(cost) {
  const n = cost.length;
  if (n === 0) return [];

  // 1-indexed working arrays (e-maxx style potentials method).
  const u = new Array(n + 1).fill(0); // row potentials
  const v = new Array(n + 1).fill(0); // column potentials
  const p = new Array(n + 1).fill(0); // p[j] = row matched to column j
  const way = new Array(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;

      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
      }

      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    // Augment along the found path.
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignment = new Array(n).fill(-1);
  for (let j = 1; j <= n; j++) {
    if (p[j] > 0) assignment[p[j] - 1] = j - 1;
  }
  return assignment;
}

/**
 * Solve a (possibly rectangular) assignment problem.
 *
 * @param {number[][]} cost - cost[i][j], i in [0,rows), j in [0,cols)
 * @returns {{ assignment: number[], totalCost: number }}
 *   assignment[i] = assigned column for row i, or -1 if row got no real column.
 *   totalCost = sum of real cost[i][assignment[i]] over assigned rows.
 */
export function hungarian(cost) {
  const rows = cost.length;
  if (rows === 0) return { assignment: [], totalCost: 0 };
  const cols = cost[0].length;
  if (cols === 0) return { assignment: new Array(rows).fill(-1), totalCost: 0 };

  const size = Math.max(rows, cols);

  // A value guaranteed larger than any full real assignment, used so the solver
  // prefers real spots over "no spot" dummy columns.
  let maxReal = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const c = cost[i][j];
      if (Number.isFinite(c) && c > maxReal) maxReal = c;
    }
  }
  const BIG = maxReal * size + 1;

  const padded = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => {
      if (i < rows && j < cols) return Number.isFinite(cost[i][j]) ? cost[i][j] : BIG; // real or forbidden
      if (i < rows && j >= cols) return BIG; // real request -> no spot
      return 0; // dummy row absorbs leftover spot for free
    })
  );

  const squareAssignment = solveSquare(padded);

  const assignment = new Array(rows).fill(-1);
  let totalCost = 0;
  for (let i = 0; i < rows; i++) {
    const j = squareAssignment[i];
    if (j >= 0 && j < cols && Number.isFinite(cost[i][j])) {
      assignment[i] = j;
      totalCost += cost[i][j];
    }
  }
  return { assignment, totalCost };
}
