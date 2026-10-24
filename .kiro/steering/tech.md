# Tech stack & conventions

## Stack

- **Runtime:** Node.js (ES modules, `"type": "module"`). Requires Node 18+.
- **Server:** Express 4. Single process, serves both the JSON API and the
  static client from `public/`.
- **Client:** Vanilla JavaScript + Leaflet (OpenStreetMap tiles). No build step,
  no framework, no API keys required. Leaflet is loaded from a CDN.
- **Persistence:** JSON file at `data/db.json`, seeded from `data/seed.json` on
  first run. No external database.
- **Geocoding:** Nominatim (OpenStreetMap) called directly from the browser,
  best-effort. Map-click is always available as a fallback.

## Key algorithm

- `src/hungarian.js` implements the Hungarian / Kuhn-Munkres assignment
  algorithm, O(n³), via the potentials method. It handles rectangular cost
  matrices by padding to a square:
  - dummy **rows** (spots > requests) cost 0 — they absorb leftover spots.
  - dummy **cols** (requests > spots) cost a large constant — so the solver
    fills every real spot first, then minimizes distance.
- **Assignment costs are walking distances along streets/footpaths**, from an
  OSRM router (foot profile) in `src/routing.js`: one `table` call per batch
  for the matrix, one chained `route` call for path geometry. Snap legs
  (spot → nearest way, way → destination) are added back. Never use
  straight-line or Manhattan distance as the cost: people can't walk through
  buildings, and SF's grid isn't axis-aligned.
- `src/distance.js` (Haversine) is only for pre-filtering spots beyond
  `MAX_STRAIGHT_LINE_M` (2 km) and the fallback estimate (straight line ×
  `CIRCUITY` 1.3) when the router is down. Fallback results are labeled
  `distanceSource: 'estimated' | 'partial'` and the UI shows them as `≈`.
- Routing results are cached in memory and in `data/route-cache.json`
  (git-ignored); writes merge with the file so scripts and the server don't
  clobber each other. The public FOSSGIS router allows 1 request/s and takes
  ~7.5 s per table after the first call; the client spaces calls, and the
  default timeout for it is 15 s.
- Batch solving is async and serialized (`Batcher.chain`); spots are
  re-checked before booking, and `clear()` bumps a generation counter so
  in-flight batches are dropped after a reset.
- `src/assign.js` builds the cost matrix from requests + spots, checking each
  request's own time window (unavailable pairs are `Infinity`, i.e. forbidden),
  runs the Hungarian solver, and runs greedy on the same matrix for comparison.
  `savedMeters` is only non-zero when both park the same number of drivers.
- Real-time updates use Server-Sent Events (`GET /api/events`), no WebSocket
  library. The CLI script reads the same stream with plain `fetch`.

## Commands

- `npm install` — install dependencies (Express).
- `npm start` — run the server on http://localhost:3000 (override with `PORT`).
- `npm run dev` — run with `--watch` for auto-reload during development.
- `npm test` — run the Node built-in test runner (`node --test`).
- `npm run simulate` — send demo traffic to a running server (scripted rush
  hour by default; `-- --random --count N --speed fast` for random traffic).
- `npm run warm-routes` — pre-fetch walking distances + routes for every demo
  entrance × spot into the cache (run before demos and after adding spots;
  restart the server afterwards).
- `npm run tune-rush` — re-tune the scripted rush scenario on real walking
  distances; prints `RUSH_BATCHES` to paste into `src/demoData.js`.
- Env: `PORT` (3000), `BATCH_WINDOW_MS` (5000), `BATCH_MAX` (8). The scripted
  rush scenario in `src/demoData.js` was tuned for the default batch size and
  the stock seed spots; re-tune it if either changes.
- Routing env: `OSRM_URL` (default public FOSSGIS foot server; self-host for
  production), `OSRM_PROFILE` (`foot`), `OSRM_TIMEOUT_MS`,
  `OSRM_MIN_INTERVAL_MS`, `ROUTING=off` (cache + estimates only).

## Conventions

- Keep the core algorithm (`src/hungarian.js`) pure and dependency-free so it
  stays unit-testable in isolation.
- Times are handled as "HH:MM" strings on the wire and converted to minutes
  (`toMinutes`) for overlap math.
- Dates are "YYYY-MM-DD" strings in the server's local time zone
  (`src/dates.js`), compared as plain strings. Validate with `isValidDate()`
  (rejects impossible dates like 2026-02-30). The browser defaults date
  pickers to its own local "today"; server and browser are assumed to share a
  time zone.
- Input validation for requests, bookings, and new spots lives in
  `src/requests.js` (`normalizeRequest`, `normalizeWindow`,
  `validateSpotInput`); routes turn `RequestError` into HTTP 400.
- Money/price is computed for display only; there is no payment integration.
- Prefer adding new API routes in `server.js` and keeping business logic in
  `src/`.
