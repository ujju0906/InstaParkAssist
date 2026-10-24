# Instant Park Assist

A non-profit, community "Airbnb for parking." No money changes hands: hosts
share their spots and earn community points, and drivers spend points to park
(see [Community points](#community-points)). Hosts list their parking spots; drivers enter where
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

On first start the server creates an `admin` account and prints its random
password to the console once. To pick the password yourself (and reset it
later), set `ADMIN_PASSWORD` (and optionally `ADMIN_USERNAME`) before
starting:

```powershell
$env:ADMIN_PASSWORD = "choose-a-long-password"; npm start
```

## Accounts and roles

Everyone signs in. Anyone can create a member account with "Create account";
admins can't sign up.

| Role              | Can use                                                        |
| ----------------- | -------------------------------------------------------------- |
| Member (`member`) | Find parking, book as themselves, and host: list spots and remove their own ("Find parking" and "Host a spot" tabs) |
| Admin (`admin`)   | Everything, plus Live demo, Batch optimize, the full Hosts directory and points table, listing spots under any host name, removing any spot, and resetting demo data |

Accounts created as "driver" or "host" by an earlier version become members
on the next server start.

The server enforces these rules on every API route; the UI just hides what a
role can't use. Bookings always charge the signed-in member, so nobody can
spend someone else's points. Display names must be unique, because points
and spots are kept under that name.

Sessions are signed, HttpOnly, `SameSite=Strict` cookies that last 7 days.
Passwords are hashed with scrypt. After 10 failed sign-ins for a username
from one IP, that pair is blocked for 15 minutes. Accounts are stored in
`data/db.json` and survive "Reset demo data".

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
  set the dates it's offered (end date optional) and its daily hours, and
  publish. There's no price to set.
- **Hosts** — directory of every host with their spots, booking counts, and
  points earned, plus a community points table (everyone's balance, points
  earned hosting, points spent parking). Pick a date to see which spots are
  offered that day, who's booked when, and that day's points. Click a spot to
  jump to it on the map.

### Community points

Parking runs on a points time bank instead of prices:

- Everyone starts with **20 points**, once, the first time they park or host.
- Parking costs a flat **2 points per hour** (1 per half hour) at every spot.
  Hosts don't set prices, so no spot can be priced up and nobody profits from
  demand.
- The points a driver spends go straight to the spot's host. Sharing your
  spot is how you earn parking for yourself.
- Points can't be bought or cashed out, and they're only moved between
  members, never created (apart from the welcome grant) or destroyed.
- A booking is refused if the driver doesn't have enough points. In a batch,
  unaffordable requests are left out before matching, so they never take a
  spot from someone else.

Balances are computed from a ledger (`welcome`, `parked`, `hosted` entries),
so they always add up. The rules live in `src/points.js`.

### Availability rules

A spot can be booked for a date + time window only if:

1. the date is inside the spot's offered date range (no range = any date),
2. the time window fits inside the spot's daily hours, and
3. no existing booking for that spot on the **same date** overlaps it.

Bookings are single-day (they must end by midnight), can't be in the past, and
can be made up to 365 days ahead. Dates are `YYYY-MM-DD` in the server's local
time zone.
- **Batch optimize** (admin only) — drop several destinations and watch the Hungarian
  algorithm assign them all at once, with a side-by-side comparison against
  naive greedy matching (and how many meters it saves).
- **Live demo** (admin only) — watch requests stream in, collect in a batch
  window, and get assigned and booked automatically, with an animated solver
  view.

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

The live demo is admin-only. Two ways to drive it (both animate the same way
in any browser signed in as an admin):

```bash
# Option A: in the app. Sign in as admin, open "Live demo", click Start simulation.

# Option B: from a terminal, like real client apps calling the API.
# The script signs in with ADMIN_USERNAME / ADMIN_PASSWORD (or --user / --password).
# Admin browsers jump to the Live demo tab when requests arrive.
npm run simulate                                    # scripted rush hour (recommended)
npm run simulate -- --random --count 30 --speed fast
npm run simulate -- --date 2026-10-25               # book for a specific date (default today)
npm run simulate -- --password "the-admin-password" # if ADMIN_PASSWORD isn't set
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

"Who" is the role needed. Without a session, protected routes return 401;
with the wrong role, 403.

| Method | Path               | Who          | Purpose                                   |
| ------ | ------------------ | ------------ | ----------------------------------------- |
| POST   | `/api/auth/register` | anyone     | Create a member account and sign in `{ username, password, displayName }` |
| POST   | `/api/auth/login`  | anyone       | Sign in `{ username, password }`          |
| POST   | `/api/auth/logout` | anyone       | Sign out                                  |
| GET    | `/api/auth/me`     | anyone       | The signed-in account, or `{ user: null }` |
| GET    | `/api/points`      | anyone       | Points rules (welcome grant, points per hour) |
| GET    | `/api/spots`       | signed in    | List spots (`?date=` only those offered that day) |
| POST   | `/api/spots`       | signed in    | Add a spot under your name: daily hours + optional date range |
| DELETE | `/api/spots/:id`   | owner, admin | Remove a spot                             |
| GET    | `/api/hosts`       | admin        | Hosts directory (`?date=` that day's bookings + points) |
| GET    | `/api/members`     | admin        | Every member's balance, earned, spent     |
| GET    | `/api/members/:name` | self, admin | One member's balance + recent history    |
| POST   | `/api/assign`      | signed in    | Instant assignment, nothing booked (batches: admin only) |
| POST   | `/api/book`        | signed in    | Book a date + time window as yourself (you pay the host in points) |
| GET    | `/api/bookings`    | signed in    | Bookings you can see: your own, on your spots, or all for admins (`?date=`, `?spotId=`) |
| DELETE | `/api/bookings`    | admin        | Clear all bookings and points (keeps spots) |
| POST   | `/api/reset`       | admin        | Reset demo data to the seed               |
| POST   | `/api/requests`    | admin        | Queue request(s) for batched assignment   |
| GET    | `/api/events`      | admin        | Server-Sent Events stream of the queue    |
| GET    | `/api/live`        | admin        | Queue, stats, and simulator snapshot      |
| POST   | `/api/simulate/start` | admin     | Start built-in simulator                  |
| POST   | `/api/simulate/stop`  | admin     | Stop the simulator                        |

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
  "availableFrom": "08:00", "availableUntil": "18:00",
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
- Points are still kept under display names (case-insensitive), not account
  ids. Sign-up refuses names already in use, but simulated drivers in the
  live demo (e.g. "Alex B.") are created as members without accounts.
- There are no cancellations yet, so points can't be refunded.
- Accounts can't be edited or deleted from the app, and there's no password
  reset except the admin's (via `ADMIN_PASSWORD`). Signing out clears the
  cookie but doesn't revoke a copied session token before it expires.
- Serve over HTTPS outside local demos. The session cookie is only marked
  `Secure` when Express sees an HTTPS request.
- Within a batch each spot goes to at most one driver, even if two drivers'
  time windows don't overlap.
