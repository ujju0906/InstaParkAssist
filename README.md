# Instant Park Assist

An "Airbnb for parking." Hosts list their parking spots; drivers enter where
they're going and for how long, and the app **auto-assigns the nearest available
spot**. When several drivers request parking at once, assignments are optimized
with the **Hungarian algorithm (Kuhn-Munkres)** to minimize the *total* walking
distance between every destination and its spot.

## Quick start

```bash
npm install
npm start
# open http://localhost:3000
```

Dev mode with auto-reload:

```bash
npm run dev
```

Run the solver tests:

```bash
npm test
```

## How it works

- **Find parking** — search an address or click the map to set your
  destination, pick a date, start time and number of hours, and get matched to
  the available spot with the shortest walk along streets. Book it in one
  click. Only spots within 2 km (straight line) of the destination are
  considered.
- **Host a spot** — search your spot's address (or click the map) to place it,
  set price/hour, the dates it's offered (end date optional) and its daily
  hours, and publish.
- **Hosts** — directory of every host with their spots, booking counts, and
  earnings. Pick a date to see which spots are offered that day, who's booked
  when, and that day's earnings. Click a spot to jump to it on the map.

### Availability rules

A spot can be booked for a date + time window only if:

1. the date is inside the spot's offered date range (no range = any date),
2. the time window fits inside the spot's daily hours, and
3. no existing booking for that spot on the **same date** overlaps it.

Bookings are single-day (they must end by midnight), can't be in the past, and
can be made up to 365 days ahead. Dates are `YYYY-MM-DD` in the server's local
time zone.
- **Batch optimize** — drop several destinations and watch the Hungarian
  algorithm assign them all at once, with a side-by-side comparison against
  naive greedy matching (and how many meters it saves).
- **Live demo** — watch requests stream in, collect in a batch window, and get
  assigned and booked automatically, with an animated solver view.

## Walking distance: along streets, not through buildings

Drivers walk from the spot to the building on streets and footpaths, so the
cost matrix uses **walking distances from the street network**, not straight
lines. On the demo data, real walks are a median 1.3× the straight line and up
to 13× (a spot in an alley reached from another street). Manhattan distance
isn't a fix either: SF's grid isn't aligned north–south, and in testing it
picked worse assignments than straight-line.

- Distances come from an [OSRM](https://project-osrm.org/) router with a foot
  profile: one `table` call per batch for the matrix, one `route` call for the
  paths drawn on the map. The walk from the spot to the nearest footpath and
  from the footpath to the building is included.
- Default router: the public FOSSGIS server (`routing.openstreetmap.de`). It's
  meant for light, non-commercial use and allows at most
  [1 request per second](https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server);
  the app spaces requests accordingly. In testing it took ~7.5 s per distance
  matrix after the first call. **For production, self-host OSRM** with a
  regional OpenStreetMap extract and set `OSRM_URL`; replies then take
  milliseconds.
- Results are cached in `data/route-cache.json`. Run `npm run warm-routes`
  once (and again after adding spots) to pre-fetch every demo
  entrance × spot pair, so demos run from cache, even offline.
- If the router fails or times out, distances fall back to straight line × 1.3
  and the UI labels them as estimates (`≈`, dashed lines). `ROUTING=off`
  forces this mode.

## Running the live demo

Requests go into a queue. Every 5 seconds (or once 8 requests are waiting) the
server solves the whole batch with the Hungarian algorithm and books every
match. The browser animates each batch:

1. Requests drop onto the map as pulsing pins and join the queue.
2. A countdown bar shows the batch window closing.
3. Every possible driver→spot pair is drawn (the cost matrix, also shown as a
   heatmap), then greedy's picks in red, then the Hungarian optimum in green.

Two ways to drive it (both animate the same way in any open browser):

```bash
# Option A: in the app. Open the "Live demo" tab and click Start simulation.

# Option B: from a terminal, like real client apps calling the API.
# The browser jumps to the Live demo tab when requests arrive.
npm run simulate                                    # scripted rush hour (recommended)
npm run simulate -- --random --count 30 --speed fast
npm run simulate -- --date 2026-10-25               # book for a specific date (default today)
```

The **scripted rush hour** is a fixed set of 14 drivers in two waves, chosen
(by `npm run tune-rush`, on real walking distances) so greedy does badly
against the stock seed data: Hungarian walks 1,880 m vs greedy's 3,057 m in
batch 1, and 1,791 m vs 3,224 m in batch 2. Use it when presenting. **Random
traffic** gives realistic, smaller gains (a few percent less walking per
batch), and sometimes greedy would have left a driver with no spot at all.

Before presenting, run `npm run warm-routes` once and restart the server, so
no batch waits on the public router.

Tuning: `BATCH_WINDOW_MS` (default 5000) and `BATCH_MAX` (default 8) env vars.
The scripted scenario assumes the defaults and the seed spots; re-run
`npm run tune-rush` and paste its output into `src/demoData.js` if they change.

## Why the Hungarian algorithm?

Greedy "nearest spot" assigns each driver in turn, which can be globally poor —
an early driver may take a spot that would have spared a later driver a much
longer walk. The Hungarian algorithm solves the **assignment problem**
optimally: it finds the set of driver→spot pairings with the minimum possible
total walking distance.

Core pieces:

- `src/hungarian.js` — pure O(n³) Kuhn-Munkres solver (handles rectangular
  inputs by padding).
- `src/routing.js` — walking distances and paths along streets (OSRM), with
  caching and a straight-line fallback. These are the assignment costs.
- `src/assign.js` — builds the cost matrix from live data and runs the solver.

## API

| Method | Path               | Purpose                                   |
| ------ | ------------------ | ----------------------------------------- |
| GET    | `/api/spots`       | List spots (`?date=` only those offered that day) |
| POST   | `/api/spots`       | Add a spot (host): daily hours + optional date range |
| DELETE | `/api/spots/:id`   | Remove a spot                             |
| GET    | `/api/hosts`       | Hosts directory (`?date=` that day's bookings + earnings) |
| POST   | `/api/assign`      | Instant assignment, nothing booked        |
| POST   | `/api/book`        | Book a spot for a date + time window      |
| GET    | `/api/bookings`    | List bookings (`?date=`, `?spotId=`)      |
| DELETE | `/api/bookings`    | Clear all bookings (keeps spots)          |
| POST   | `/api/reset`       | Reset demo data to the seed               |
| POST   | `/api/requests`    | Queue request(s) for batched assignment   |
| GET    | `/api/events`      | Server-Sent Events stream of the queue    |
| GET    | `/api/live`        | Queue, stats, and simulator snapshot      |
| POST   | `/api/simulate/start` | Start built-in simulator              |
| POST   | `/api/simulate/stop`  | Stop the simulator                    |

Example assignment request:

```json
POST /api/assign
{
  "requests": [
    { "userName": "Alex", "lat": 37.7925, "lng": -122.3999, "date": "2026-10-25", "startTime": "09:00", "hours": 2 }
  ]
}
```

`date` defaults to today if omitted. Example host listing, offered every day
in November from 08:00 to 18:00:

```json
POST /api/spots
{
  "label": "Driveway on Clay St", "hostName": "Maria G.", "lat": 37.7946, "lng": -122.4006,
  "pricePerHour": 4.5, "availableFrom": "08:00", "availableUntil": "18:00",
  "availableFromDate": "2026-11-01", "availableUntilDate": "2026-11-30"
}
```

## Tech

Node + Express, vanilla JS + Leaflet (OpenStreetMap, no API key), JSON-file
persistence. No build step. See `.kiro/steering/` for product and architecture
notes.

## Notes / limitations

- Walking routes come from OpenStreetMap data via OSRM's foot profile. They
  don't know about building entrances, private gates, or elevation, and the
  public router is rate-limited (see above).
- Requested coordinates are sent to the configured router. With the default
  public server that's a third party; self-host OSRM to keep them in-house.
- Prices are computed for display; there's no real payment flow.
- No authentication; names are free-text labels. Anyone who can reach the
  server can queue requests, start/stop the simulator, or clear bookings.
- Within a batch each spot goes to at most one driver, even if two drivers'
  time windows don't overlap.
