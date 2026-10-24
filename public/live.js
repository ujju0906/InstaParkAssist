/* Instant Park Assist: live batching demo.
 *
 * Listens to the server's event stream (/api/events) and animates each batch:
 *   1. Requests drop onto the map as pulsing pins and join the queue.
 *   2. A countdown bar shows the batch window filling up.
 *   3. When the batch closes, every driver→spot pair the solver considers is
 *      drawn as a thin straight "pairing" line (the cost matrix, whose values
 *      are walking distances along streets), then greedy's pairings (red),
 *      then the Hungarian optimum draws in along the real walking routes
 *      (green) and the spots are booked.
 *
 * Works the same whether requests come from the "Start simulation" button,
 * `npm run simulate`, or any client calling POST /api/requests.
 *
 * Relies on globals from app.js: map, liveLayer, esc, api, fmtMeters,
 * walkLabel, distanceNote, drawWalk, renderSpots, activateTab, mode, loadSpots.
 */

const live = {
  scenario: document.getElementById('live-scenario'),
  date: document.getElementById('live-date'),
  randomOpts: document.getElementById('live-random-opts'),
  count: document.getElementById('live-count'),
  speed: document.getElementById('live-speed'),
  clear: document.getElementById('live-clear'),
  start: document.getElementById('live-start'),
  stop: document.getElementById('live-stop'),
  fill: document.getElementById('live-window-fill'),
  windowText: document.getElementById('live-window-text'),
  queue: document.getElementById('live-queue'),
  phase: document.getElementById('live-phase'),
  matrix: document.getElementById('live-matrix'),
  log: document.getElementById('live-log'),
  stat: {
    received: document.getElementById('stat-received'),
    assigned: document.getElementById('stat-assigned'),
    batches: document.getElementById('stat-batches'),
    saved: document.getElementById('stat-saved'),
  },
};

const pendingPins = new Map(); // requestId -> marker
const queueItems = new Map(); // requestId -> <li>
let lastBatchLayer = null;
let animChain = Promise.resolve();
let windowTicker = null;
let generation = 0; // bumped on reset so in-flight animations stop drawing

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, reducedMotion ? Math.min(ms, 200) : ms));

// --- Rendering helpers -----------------------------------------------------

function requestIcon(seq, state) {
  return L.divIcon({
    className: 'pin',
    html: `<div class="req-pin ${state}">${esc(seq)}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

function setPhase(html) {
  live.phase.innerHTML = html;
}

function updateStats(stats) {
  if (!stats) return;
  live.stat.received.textContent = stats.received;
  live.stat.assigned.textContent = stats.assigned;
  live.stat.batches.textContent = stats.batches;
  live.stat.saved.textContent = fmtMeters(stats.metersSaved);
}

function updateSim(sim) {
  if (!sim) return;
  live.start.disabled = sim.running;
  live.start.textContent = sim.running ? `Running… ${sim.sent}/${sim.total}` : 'Start simulation';
}

function addPending(r) {
  if (pendingPins.has(r.id)) return;
  const marker = L.marker([r.lat, r.lng], { icon: requestIcon(r.seq, 'pending'), zIndexOffset: 1000 })
    .bindTooltip(`#${esc(r.seq)} ${esc(r.userName)} → ${esc(r.label)}`)
    .addTo(liveLayer);
  pendingPins.set(r.id, marker);

  const li = document.createElement('li');
  li.innerHTML = `<span>#${esc(r.seq)} ${esc(r.userName)} → ${esc(r.label)}</span>
    <span class="sub">${r.date && r.date !== todayISO() ? `${esc(fmtDate(r.date))} · ` : ''}${esc(r.startTime)} · ${esc(r.hours)}h</span>`;
  live.queue.prepend(li);
  queueItems.set(r.id, li);
}

function takeFromQueue(r) {
  const marker = pendingPins.get(r.id);
  if (marker) liveLayer.removeLayer(marker);
  pendingPins.delete(r.id);
  const li = queueItems.get(r.id);
  if (li) li.remove();
  queueItems.delete(r.id);
}

function startWindow(ms) {
  live.fill.style.transition = 'none';
  live.fill.style.width = '0%';
  void live.fill.offsetWidth; // restart the transition
  live.fill.style.transition = `width ${ms}ms linear`;
  live.fill.style.width = '100%';

  const end = performance.now() + ms;
  clearInterval(windowTicker);
  const tick = () => {
    const left = end - performance.now();
    if (left <= 0) {
      clearInterval(windowTicker);
      live.windowText.textContent = 'Batch window closed. Solving…';
      return;
    }
    live.windowText.textContent = `Collecting requests · batch closes in ${(left / 1000).toFixed(1)}s`;
  };
  tick();
  windowTicker = setInterval(tick, 100);
}

function resetWindow() {
  clearInterval(windowTicker);
  live.fill.style.transition = 'none';
  live.fill.style.width = '0%';
  live.windowText.textContent = 'Waiting for requests…';
}

/** Heatmap of the batch's cost matrix with Hungarian and greedy picks outlined. */
function renderMatrix(b) {
  const finite = b.cost.flat().filter((c) => c != null);
  const max = Math.max(1, ...finite);

  let html = `<table class="matrix">
    <caption class="sr-only">Walking distance from each driver (rows) to each spot (columns)</caption>
    <thead><tr><th></th>${b.spots
      .map((s, j) => `<th scope="col" title="${esc(s.label)}">S${j + 1}</th>`)
      .join('')}</tr></thead><tbody>`;

  b.requests.forEach((r, i) => {
    html += `<tr><th scope="row" title="${esc(r.userName)} → ${esc(r.label)}">#${esc(r.seq)}</th>`;
    b.cost[i].forEach((c, j) => {
      const cls = [];
      if (c == null) cls.push('na');
      if (b.assignment[i] === j) cls.push('pick');
      else if (b.greedyAssignment[i] === j) cls.push('greedy');
      const style = c == null ? '' : ` style="background:rgba(91,140,255,${(1 - (c / max) * 0.85).toFixed(2)})"`;
      const title = c == null ? 'Not available for this date and time' : `${walkLabel(c, b.distanceSource)} walk from ${b.spots[j].label}`;
      html += `<td class="${cls.join(' ')}"${style} title="${esc(title)}"></td>`;
    });
    html += '</tr>';
  });

  html += `</tbody></table>
    <p class="legend">Brighter = shorter walk
      <span class="k" style="outline:2px solid #37d6a7"></span>Hungarian
      <span class="k" style="outline:2px dashed #ff6b6b"></span>Greedy
      <span class="k" style="background:repeating-linear-gradient(45deg,#2a3053 0 3px,#1f2440 3px 6px)"></span>Unavailable</p>`;
  live.matrix.innerHTML = html;
}

function addLog(b) {
  const c = b.comparison;
  const reqById = new Map(b.requests.map((r) => [r.id, r]));
  const spotById = new Map(b.spots.map((s) => [s.id, s]));

  const lines = b.assignments
    .map((a) => {
      const r = reqById.get(a.requestId);
      const s = spotById.get(a.spotId);
      return `<li>#${esc(r.seq)} ${esc(r.userName)} → ${esc(s.label)} <span class="sub">${walkLabel(a.walkMeters, b.distanceSource)}</span></li>`;
    })
    .concat(
      b.unassigned.map((u) => {
        const r = reqById.get(u.requestId);
        return `<li class="fail">#${esc(r.seq)} ${esc(r.userName)}: ${esc(u.reason)}</li>`;
      })
    )
    .join('');

  let verdict;
  if (c.greedyAssigned < c.hungarianAssigned) {
    const n = c.hungarianAssigned - c.greedyAssigned;
    verdict = `Greedy would have left ${n} driver${n === 1 ? '' : 's'} without a spot`;
  } else if (c.savedMeters > 0) {
    verdict = `Saved ${fmtMeters(c.savedMeters)} of walking vs greedy`;
  } else {
    verdict = 'Greedy happened to match the optimum this batch';
  }

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="big">Batch #${esc(b.batchId)} <span class="badge">${b.assignments.length}/${b.requests.length} parked</span></div>
    <div class="meta">
      ${b.requests.length} drivers × ${b.spots.length} spots · solved in ${esc(b.solveMs)} ms<br>
      Hungarian ${walkLabel(c.hungarianTotalWalkMeters, b.distanceSource)} · greedy ${walkLabel(c.greedyTotalWalkMeters, b.distanceSource)} walking<br>
      <span class="ok">${verdict}</span>
    </div>
    <ul class="log-list">${lines}</ul>`;
  live.log.prepend(card);
  while (live.log.children.length > 8) live.log.lastChild.remove();
}

// --- Batch animation -------------------------------------------------------

async function animateBatch(b) {
  const gen = generation;
  const stale = () => gen !== generation;
  if (lastBatchLayer) liveLayer.removeLayer(lastBatchLayer);
  const layer = L.layerGroup().addTo(liveLayer);
  lastBatchLayer = layer;

  const reqs = b.requests;
  const cand = b.spots;
  const at = (p) => [p.lat, p.lng];

  // Pull this batch's requests out of the queue and mark them as solving.
  const markers = reqs.map((r) => {
    takeFromQueue(r);
    return L.marker(at(r), { icon: requestIcon(r.seq, 'solving'), zIndexOffset: 1000 })
      .bindTooltip(`#${esc(r.seq)} ${esc(r.userName)} → ${esc(r.label)}`)
      .addTo(layer);
  });

  // Keep the whole batch in view.
  const bounds = L.latLngBounds([...reqs.map(at), ...cand.map(at)]);
  if (bounds.isValid() && !map.getBounds().contains(bounds)) {
    map.fitBounds(bounds, { padding: [40, 40] });
  }

  // Phase 1: every allowed driver→spot pair (the cost matrix).
  const pairs = b.cost.flat().filter((c) => c != null).length;
  setPhase(
    `<strong>Batch #${esc(b.batchId)}</strong>: comparing ${reqs.length} drivers × ${cand.length} spots ` +
      `(${pairs} possible walks)…`
  );
  renderMatrix(b);
  const candLines = L.layerGroup().addTo(layer);
  b.cost.forEach((row, i) =>
    row.forEach((c, j) => {
      if (c == null) return;
      L.polyline([at(reqs[i]), at(cand[j])], {
        color: '#9aa0c0',
        weight: 1,
        opacity: 0.35,
        className: 'cand-line',
        interactive: false,
      }).addTo(candLines);
    })
  );
  await sleep(1300);
  if (stale()) return;

  // Phase 2: what first-come-first-served greedy would do (only if it differs).
  const differs = b.greedyAssignment.some((g, i) => g !== b.assignment[i]);
  const greedyLines = L.layerGroup().addTo(layer);
  if (differs) {
    setPhase(
      `<strong>Batch #${esc(b.batchId)}</strong>: greedy (first come, first served) would pick the ` +
        `<span style="color:#ff6b6b">red</span> pairings: ${walkLabel(b.comparison.greedyTotalWalkMeters, b.distanceSource)} total walking…`
    );
    b.greedyAssignment.forEach((j, i) => {
      if (j < 0) return;
      L.polyline([at(reqs[i]), at(cand[j])], {
        color: '#ff6b6b',
        weight: 2.5,
        opacity: 0.9,
        dashArray: '4 6',
        interactive: false,
      }).addTo(greedyLines);
    });
    await sleep(1500);
    if (stale()) return;
  }
  layer.removeLayer(candLines);
  greedyLines.eachLayer((l) => l.setStyle({ opacity: 0.25 }));

  // Phase 3: the Hungarian optimum draws in along the actual walking routes
  // (streets/footpaths), and spots are booked.
  const booked = new Map(b.assignments.map((a) => [a.requestId, a]));
  const spotById = new Map(cand.map((s) => [s.id, s]));
  reqs.forEach((r) => {
    const a = booked.get(r.id);
    if (a) drawWalk(layer, a.route, spotById.get(a.spotId), r, { className: 'route-draw' });
  });
  renderSpots(new Set(b.assignments.map((a) => a.spotId)));
  markers.forEach((m, i) => m.setIcon(requestIcon(reqs[i].seq, booked.has(reqs[i].id) ? 'done' : 'fail')));

  const c = b.comparison;
  const extra =
    c.greedyAssigned < c.hungarianAssigned
      ? `, and parked ${c.hungarianAssigned - c.greedyAssigned} more driver(s) than greedy`
      : c.savedMeters > 0
        ? `, ${fmtMeters(c.savedMeters)} less walking than greedy`
        : '';
  setPhase(
    `<strong>Batch #${esc(b.batchId)}</strong>: Hungarian optimum booked ${b.assignments.length}/${reqs.length} ` +
      `drivers, ${walkLabel(c.hungarianTotalWalkMeters, b.distanceSource)} total walk${extra}. ` +
      `Solved in ${esc(b.solveMs)} ms.<br><span class="sub">${distanceNote(b.distanceSource)}</span>`
  );
  addLog(b);
  updateStats(b.stats);

  await sleep(1200);

  // Un-highlight the booked spots once this batch is no longer the latest.
  setTimeout(() => {
    if (lastBatchLayer === layer) renderSpots();
  }, 4000);
}

function clearLive() {
  pendingPins.forEach((m) => liveLayer.removeLayer(m));
  pendingPins.clear();
  queueItems.clear();
  live.queue.innerHTML = '';
  if (lastBatchLayer) liveLayer.removeLayer(lastBatchLayer);
  lastBatchLayer = null;
  live.matrix.innerHTML = '';
  live.log.innerHTML = '';
  setPhase('Idle. Start a simulation or run <code>npm run simulate</code>.');
  updateStats({ received: 0, assigned: 0, batches: 0, metersSaved: 0 });
  resetWindow();
  renderSpots();
}

// --- Event stream ----------------------------------------------------------

const stream = new EventSource('/api/events');
const on = (type, fn) => stream.addEventListener(type, (e) => fn(JSON.parse(e.data)));

on('hello', (s) => {
  updateStats(s.stats);
  updateSim(s.sim);
  s.pending.forEach(addPending);
  if (s.remainingMs) startWindow(s.remainingMs);
});

on('request', (d) => {
  if (mode !== 'live') activateTab('live');
  addPending(d.request);
  live.stat.received.textContent = d.stats.received;
});

on('window', (d) => startWindow(d.remainingMs));

on('solving', (d) => {
  clearInterval(windowTicker);
  live.fill.style.transition = 'none';
  live.fill.style.width = '100%';
  live.windowText.textContent = `Batch of ${d.size} closed. Getting walking routes along streets…`;
});

on('batch', (b) => {
  resetWindow();
  const gen = generation;
  animChain = animChain
    .then(() => (gen === generation ? animateBatch(b) : null))
    .catch((err) => console.error(err));
});

on('sim', updateSim);

on('reset', () => {
  // Abandon queued/in-flight animations and start from a clean slate.
  generation += 1;
  animChain = Promise.resolve();
  clearLive();
  loadSpots().catch(console.error);
});

// --- Controls --------------------------------------------------------------

live.start.addEventListener('click', async () => {
  try {
    await api('/api/simulate/start', {
      method: 'POST',
      body: JSON.stringify({
        scenario: live.scenario.value,
        date: live.date.value || todayISO(),
        count: +live.count.value || 16,
        speed: live.speed.value,
        clearBookings: live.clear.checked,
      }),
    });
  } catch (err) {
    setPhase(`<span class="err">${esc(err.message)}</span>`);
  }
});

// Driver count and speed only apply to random traffic; the rush scenario is
// scripted and always clears bookings.
function syncScenarioControls() {
  const random = live.scenario.value === 'random';
  live.randomOpts.hidden = !random;
  live.clear.disabled = !random;
  if (!random) live.clear.checked = true;
}
live.scenario.addEventListener('change', syncScenarioControls);
syncScenarioControls();

live.stop.addEventListener('click', () => {
  api('/api/simulate/stop', { method: 'POST' }).catch(console.error);
});
