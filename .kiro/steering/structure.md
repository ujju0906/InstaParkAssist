# Project structure

```
ParkAssistKiro/
├── server.js              # Express app: API routes + static hosting
├── package.json
├── src/
│   ├── hungarian.js       # Hungarian/Kuhn-Munkres assignment solver (pure)
│   ├── distance.js        # Straight-line distance: pre-filter + fallback only (pure)
│   ├── routing.js         # Walking distances/paths along streets (OSRM) + cache
│   ├── assign.js          # Builds cost matrix, runs solver, greedy baseline
│   ├── requests.js        # Request validation/normalization (shared)
│   ├── batcher.js         # Live queue: batch window -> solve -> book -> events
│   ├── simulator.js       # In-process demo traffic driven by an arrival plan
│   ├── demoData.js        # Demo destinations, random + scripted "rush" plans (pure)
│   └── store.js           # JSON-file data store (spots, bookings)
├── scripts/
│   ├── simulate.js        # CLI traffic generator (npm run simulate)
│   ├── warm-routes.js     # Pre-fetch entrance x spot walking routes into the cache
│   └── tune-rush.js       # Re-tune the scripted rush scenario on walking distances
├── data/
│   ├── seed.json          # Starter parking spots (checked in)
│   └── db.json            # Live data, created at runtime (git-ignored)
├── public/                # Static web client (no build step)
│   ├── index.html         # Tabs: Find / Host / Batch optimize / Hosts / Live demo + map
│   ├── styles.css
│   ├── app.js             # Leaflet map, API calls, UI logic, shared helpers
│   └── live.js            # Live demo: SSE listener + batch animation
├── test/
│   └── hungarian.test.js  # Unit tests for the assignment solver
└── .kiro/
    └── steering/          # Product/tech/structure context for Kiro
```

## Responsibilities

- **server.js** — HTTP surface only. Validates input, delegates to `src/`.
- **src/hungarian.js** — the optimization core. Pure function, no I/O. The place
  to look when reasoning about assignment correctness.
- **src/assign.js** — glue between live data and the solver; also owns the
  greedy-vs-optimal comparison.
- **src/store.js** — the only module that touches the filesystem for app data.
- **public/app.js** — all client behavior; four tabs share one map instance
  and route map clicks based on the active tab. Address search is shared via
  `wireSearch()` (used by Find and Host). Any user-provided text inserted as
  HTML must go through `esc()`.
- **GET /api/hosts** — derived view, not stored: spots grouped by `hostName`
  with booking counts and earnings computed from bookings.
- **Live pipeline** — `POST /api/requests` and the simulator both call
  `batcher.enqueue()`. The batcher emits `request` / `window` / `batch` events;
  `server.js` relays them over SSE (`/api/events`) to `public/live.js`, which
  queues animations so batches play one at a time. `reset` events bump a
  generation counter so in-flight animations stop drawing.
- **public/live.js** is a classic script loaded after `app.js` and uses its
  top-level globals (`map`, `liveLayer`, `esc`, `api`, `renderSpots`,
  `activateTab`). Keep both as non-module scripts or convert them together.

## Data model

- **Spot**: `{ id, hostName, label, lat, lng, pricePerHour, availableFrom,
  availableUntil, availableFromDate, availableUntilDate }`. Times are daily
  hours; the dates are an optional inclusive range (`null` = no limit). Seed
  spots have no date range so demos work on any day.
- **Booking**: `{ id, spotId, userName, date, startTime, hours, startMin,
  endMin, price, destinationLabel }`. Overlap is only checked against bookings
  with the same `date`. Bookings saved before dates existed are migrated to
  the server's "today" on load.
- **Request** (transient, not stored): `{ userName, lat, lng, label, date,
  startTime, hours }` → normalized by `normalizeWindow()` in `requests.js`
  (date defaults to today; past, >365 days ahead, or past-midnight windows are
  rejected) and expanded with `startMin`/`endMin`.
- Availability lives in one place: `isSpotAvailable(spot, date, startMin,
  endMin)` in `store.js`. Every path (assign, batch re-check, /api/book) must
  go through it.
