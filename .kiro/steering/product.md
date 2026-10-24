# Product: Instant Park Assist

Instant Park Assist is a non-profit, community "Airbnb for parking," run on
points instead of money. It connects people who have an
empty parking spot (hosts) with drivers who need one near a specific
destination (users).

## Who it's for

- **Hosts** — anyone with a driveway, garage, or private stall who's willing to
  share it during set hours, earning community points they can spend on
  parking themselves.
- **Users** — drivers heading to a specific building/address who want the
  closest available spot for a chosen number of hours, without manually
  comparing listings.
- **Admins** — run the demo: Live demo, Batch optimize, the full Hosts
  directory and points table, and data resets.

## Accounts and roles

Everyone signs in. There are two roles: `member` and `admin`. Every member
can both park and host (one person is often both, which is the point of the
points system). Sign-ups are always members; admins are created by the
server (`ADMIN_PASSWORD` / printed random password), never through sign-up.
Members get exactly three things: find parking, book it, and host spots
(they see and remove only their own). Everything else (Live demo, Batch
optimize, Hosts directory, points table, resets) is admin-only. Bookings always charge the signed-in
member. The server enforces every rule; hiding UI is only cosmetic.

## Host experience

- Hosts place a spot by searching its address (same geocoder as the driver
  search) or by clicking the map, then set availability (no price).
- The **Hosts** tab (admin only) is a directory of every host, their spots,
  booking counts, and points earned, plus every member's points balance.
  Members manage their own spots from the list on "Host a spot".

## Non-profit: community points, not money

The app is deliberately non-profit. There are no prices and no payments:

- Every member gets a one-time welcome grant (20 points).
- Parking costs the same flat rate everywhere (2 points/hour). Hosts can't set
  prices, so there's no surge pricing and no profit motive.
- The driver's points go to the host. Points move between members; they're
  never bought, cashed out, created (except the welcome grant) or destroyed.
- Don't reintroduce prices, per-spot rates, fees, or anything that converts
  points to money without an explicit product decision.

## Core experience

1. A user enters where they're going (address search or a map click) and how
   long they'll stay (start time + hours).
2. The app automatically assigns the nearest available spot — the user does not
   browse listings; the match is made for them.
3. The user books the assigned spot for that time window.

## Walking distance means walking on streets

"Nearest spot" means the shortest **walk** along streets and footpaths from
the spot to the destination, never straight-line distance. People can't walk
through buildings, and a spot that's close as the crow flies can be a long way
around the block. Distances and the routes drawn on the map come from a
routing engine; if it's unavailable, the app shows clearly labeled estimates.

## The matching rule (why this app is different)

The headline feature is **optimal assignment**, not greedy "closest spot."
When multiple users request parking at the same time, the app assigns all of
them at once using the **Hungarian algorithm (Kuhn-Munkres)** to minimize the
**total walking distance** between every user's destination and their assigned
spot.

Greedy "nearest spot" can be globally bad: the first user grabs a spot that
would have saved a later user a long walk. The Hungarian algorithm guarantees
the globally optimal set of assignments. The "Batch optimize" view surfaces this
by comparing the Hungarian total against naive greedy and showing the distance
saved.

## Live batching

Production-style flow: requests are held in a short batch window (default 5s or
8 requests), then solved and booked together. Batching is what gives the
Hungarian algorithm room to beat greedy; one-at-a-time assignment is just
greedy. The **Live demo** tab visualizes this for presentations, driven by the
in-app simulator or `npm run simulate`.

## Spot availability

- Each spot has daily hours (e.g. 08:00–20:00) and an
  optional date range it's offered (start and/or end date; none = any date).
- Drivers always book a **date + time window**. A spot can only be matched or
  booked if the date is in its range, the window fits its daily hours, and no
  booking for that spot on the same date overlaps.
- Bookings are single-day (end by midnight), never in the past, and at most
  365 days ahead.
- The search only considers spots within 2 km straight-line of the
  destination; within that, the shortest walk along streets wins.
- The Hosts directory can be filtered by date to show which spots are offered
  that day, that day's bookings (time, driver, destination), and points.
- A driver must have enough points for the booking; otherwise it's refused.

## Non-goals (current version)

- Money of any kind: no prices, payments, payouts, or buying points.
- Cancellations/refunds (not built yet).
- Account management: editing or deleting accounts, password reset (except
  the admin via `ADMIN_PASSWORD`), OAuth/SSO.
- Walking routes don't model building entrances, private gates, elevation, or
  accessibility needs (e.g. step-free routes); they come from OpenStreetMap's
  walkable network as-is.
