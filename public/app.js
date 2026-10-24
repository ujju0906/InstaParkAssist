/* Instant Park Assist — frontend */

const SF = [37.7937, -122.3995];
let mode = 'find';

// --- Map setup -------------------------------------------------------------

const map = L.map('map').setView(SF, 15);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const spotLayer = L.layerGroup().addTo(map);
const destLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
// Live demo overlays (see live.js). Only on the map while the Live tab is open.
const liveLayer = L.layerGroup();

function spotIcon(selected) {
  return L.divIcon({
    className: 'pin',
    html: `<div style="
      width:26px;height:26px;border-radius:50% 50% 50% 0;
      transform:rotate(-45deg);
      background:${selected ? '#37d6a7' : '#5b8cff'};
      border:2px solid #0b0e1c;box-shadow:0 2px 6px rgba(0,0,0,.4);
      display:grid;place-items:center;">
      <span style="transform:rotate(45deg);font-size:12px;font-weight:800;color:#0b0e1c;">P</span>
    </div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
  });
}

function destIcon(label) {
  return L.divIcon({
    className: 'pin',
    html: `<div style="
      width:22px;height:22px;border-radius:50%;
      background:#ffb454;border:2px solid #0b0e1c;
      box-shadow:0 2px 6px rgba(0,0,0,.4);
      display:grid;place-items:center;font-size:11px;font-weight:800;color:#0b0e1c;">
      ${esc(label ?? '★')}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

// --- State -----------------------------------------------------------------

let spots = [];
const spotMarkers = new Map(); // spot id -> Leaflet marker
let findDest = null; // { lat, lng, label }
let hostSpot = null; // { lat, lng }
let batchDests = []; // [{ lat, lng, label }]
let batchArming = false;

// --- Helpers ---------------------------------------------------------------

/** Escape user-provided text before inserting it as HTML. */
function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

async function loadSpots() {
  spots = await api('/api/spots');
  renderSpots();
  renderHostList();
  if (mode === 'hosts') await loadHosts();
}

function renderSpots(selectedIds = new Set()) {
  spotLayer.clearLayers();
  spotMarkers.clear();
  spots.forEach((s) => {
    const m = L.marker([s.lat, s.lng], { icon: spotIcon(selectedIds.has(s.id)) });
    m.bindPopup(
      `<strong>${esc(s.label)}</strong><br>Host: ${esc(s.hostName)}<br>$${s.pricePerHour.toFixed(
        2
      )}/hr<br>${esc(fmtDateRange(s))}<br>Daily ${esc(s.availableFrom)}–${esc(s.availableUntil)}`
    );
    m.addTo(spotLayer);
    spotMarkers.set(s.id, m);
  });
}

function focusSpot(id) {
  const m = spotMarkers.get(id);
  if (!m) return;
  map.setView(m.getLatLng(), 17);
  m.openPopup();
}

function fmtMeters(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m} m`;
}

/**
 * Draw a walk from a spot to a destination. With route geometry from the
 * server it follows the streets; otherwise it's a dashed straight line, which
 * marks the distance as an estimate (the router was unavailable).
 */
function drawWalk(layer, route, spot, dest, opts = {}) {
  const routed = Array.isArray(route) && route.length > 1;
  return L.polyline(routed ? route : [[spot.lat, spot.lng], [dest.lat, dest.lng]], {
    color: '#37d6a7',
    weight: routed ? 4 : 3,
    opacity: 0.9,
    dashArray: routed ? null : '6 6',
    interactive: false,
    ...opts,
    className: routed ? opts.className || '' : '',
  }).addTo(layer);
}

/** Short label for where the walking distances came from. */
function distanceNote(source) {
  if (source === 'routed') return 'Walking distances follow streets and footpaths.';
  if (source === 'partial') return 'Some walking distances are estimates (route service partly unavailable).';
  return 'Walking distances are estimates (route service unavailable): straight line × 1.3.';
}

function walkLabel(meters, source) {
  return source === 'routed' ? fmtMeters(meters) : `≈${fmtMeters(meters)}`;
}

// --- Dates -----------------------------------------------------------------

/** Today as YYYY-MM-DD in the browser's local time zone. */
function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "2026-10-24" -> "Sat, Oct 24, 2026" (parsed as a local date, not UTC). */
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** The date range a spot is offered, for display. */
function fmtDateRange(s) {
  if (!s.availableFromDate && !s.availableUntilDate) return 'Any date';
  if (!s.availableUntilDate) return `From ${fmtDate(s.availableFromDate)}`;
  if (!s.availableFromDate) return `Until ${fmtDate(s.availableUntilDate)}`;
  return `${fmtDate(s.availableFromDate)} – ${fmtDate(s.availableUntilDate)}`;
}

/** Default date pickers to today and block past dates (the server enforces this too). */
function initDateInputs() {
  const today = todayISO();
  for (const id of ['find-date', 'batch-date', 'live-date', 'host-from-date']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.min = today;
    if (!el.value) el.value = today;
  }
  document.getElementById('host-until-date').min = today;
  // Until-date can't be before the from-date.
  const from = document.getElementById('host-from-date');
  from.addEventListener('change', () => {
    document.getElementById('host-until-date').min = from.value || today;
  });
}
initDateInputs();

// --- Geocoding / shared address search -------------------------------------

async function geocode(q) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`
    );
    const data = await res.json();
    if (data && data[0]) {
      const r = data[0];
      // Prefer a street address ("500 Pine Street") over a landmark/POI name.
      const a = r.address || {};
      const street = [a.house_number, a.road].filter(Boolean).join(' ');
      return { lat: +r.lat, lng: +r.lon, label: street || r.display_name.split(',')[0] };
    }
  } catch {
    /* geocoding is best-effort */
  }
  return null;
}

/**
 * Wire an address search box (input + button + status line) to the geocoder.
 * Used by both "Find parking" and "Host a spot".
 */
function wireSearch(inputId, buttonId, statusId, onFound) {
  const input = document.getElementById(inputId);
  const status = document.getElementById(statusId);

  const run = async () => {
    const q = input.value.trim();
    if (!q) return;
    status.textContent = 'Searching…';
    const coords = await geocode(q);
    if (coords) {
      map.setView([coords.lat, coords.lng], 17);
      onFound(coords, q);
    } else {
      status.textContent = 'No match found. Try a fuller address or click the map.';
    }
  };

  document.getElementById(buttonId).addEventListener('click', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run();
  });
}

// --- Tabs ------------------------------------------------------------------

function activateTab(name) {
  if (name === mode && document.getElementById(`pane-${name}`).classList.contains('active')) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.pane').forEach((p) => p.classList.remove('active'));
  mode = name;
  document.getElementById(`pane-${mode}`).classList.add('active');
  // Clear transient overlays when switching modes.
  routeLayer.clearLayers();
  // The live demo has its own overlays; keep them (and their state) separate.
  if (mode === 'live') {
    map.removeLayer(destLayer);
    map.addLayer(liveLayer);
  } else {
    map.removeLayer(liveLayer);
    map.addLayer(destLayer);
  }
  if (mode === 'hosts') loadHosts();
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
});

// --- Map click routing -----------------------------------------------------

map.on('click', (e) => {
  const { lat, lng } = e.latlng;
  if (mode === 'find') {
    setFindDest(lat, lng, 'Destination');
  } else if (mode === 'host') {
    setHostSpot(lat, lng);
  } else if (mode === 'batch' && batchArming) {
    const label = document.getElementById('batch-name').value.trim() || `D${batchDests.length + 1}`;
    batchDests.push({ lat, lng, label });
    batchArming = false;
    document.getElementById('batch-name').value = '';
    document.getElementById('batch-help').textContent =
      'Added. Click "Add destination" to place another.';
    renderBatchDests();
  }
});

// --- FIND flow -------------------------------------------------------------

function setFindDest(lat, lng, label) {
  findDest = { lat, lng, label };
  destLayer.clearLayers();
  L.marker([lat, lng], { icon: destIcon('★') }).addTo(destLayer).bindPopup(esc(label));
  document.getElementById('find-coords').textContent = `${label}: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

wireSearch('find-search', 'find-search-btn', 'find-coords', (c, q) =>
  setFindDest(c.lat, c.lng, c.label || q)
);

document.getElementById('find-assign').addEventListener('click', async () => {
  const resultEl = document.getElementById('find-result');
  if (!findDest) {
    resultEl.innerHTML = `<p class="err">Set a destination first (search or click the map).</p>`;
    return;
  }
  const hours = +document.getElementById('find-hours').value || 1;
  const date = document.getElementById('find-date').value || todayISO();
  const startTime = document.getElementById('find-start').value || '09:00';
  const userName = document.getElementById('find-name').value.trim() || 'You';

  resultEl.innerHTML = `<p class="hint">Finding the best spot by walking distance…</p>`;
  try {
    const data = await api('/api/assign', {
      method: 'POST',
      body: JSON.stringify({
        requests: [{ userName, lat: findDest.lat, lng: findDest.lng, label: findDest.label, date, startTime, hours }],
      }),
    });

    if (!data.assignments.length) {
      const reason = data.unassigned[0]?.reason || 'no spots available';
      resultEl.innerHTML = `<p class="err">No spot for ${esc(fmtDate(date))} at ${esc(startTime)} for ${hours}h:
        ${esc(reason)}. Try a different date or time.</p>`;
      return;
    }

    const a = data.assignments[0];
    renderSpots(new Set([a.spot.id]));
    routeLayer.clearLayers();
    const line = drawWalk(routeLayer, a.route, a.spot, findDest);
    map.fitBounds(line.getBounds(), { padding: [60, 60] });

    resultEl.innerHTML = `
      <div class="card">
        <div class="big">${esc(a.spot.label)} <span class="badge">matched</span></div>
        <div class="meta">
          Host: ${esc(a.spot.hostName)}<br>
          Walk: <strong class="ok">${walkLabel(a.walkMeters, data.distanceSource)}</strong> (~${a.walkMinutes} min)<br>
          <span class="sub">${distanceNote(data.distanceSource)}</span><br>
          Price: $${a.price.toFixed(2)} for ${hours}h ($${a.spot.pricePerHour.toFixed(2)}/hr)<br>
          When: ${esc(fmtDate(date))}, ${esc(startTime)} for ${hours}h
        </div>
        <div class="btn-row">
          <button class="primary" id="book-btn">Book this spot</button>
        </div>
      </div>`;

    document.getElementById('book-btn').addEventListener('click', async () => {
      try {
        await api('/api/book', {
          method: 'POST',
          body: JSON.stringify({
            spotId: a.spot.id,
            userName,
            date,
            startTime,
            hours,
            destinationLabel: findDest.label,
          }),
        });
        resultEl.innerHTML = `<div class="card"><div class="big ok">Booked ✓</div>
          <div class="meta">${esc(a.spot.label)} is reserved on ${esc(fmtDate(date))},
          ${esc(startTime)} for ${hours}h.</div></div>`;
        await loadSpots();
      } catch (err) {
        resultEl.insertAdjacentHTML('beforeend', `<p class="err">${esc(err.message)}</p>`);
      }
    });
  } catch (err) {
    resultEl.innerHTML = `<p class="err">${esc(err.message)}</p>`;
  }
});

// --- HOST flow -------------------------------------------------------------

function setHostSpot(lat, lng) {
  hostSpot = { lat, lng };
  destLayer.clearLayers();
  L.marker([lat, lng], { icon: destIcon('+') }).addTo(destLayer);
  document.getElementById('host-coords').textContent = `Spot: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

wireSearch('host-search', 'host-search-btn', 'host-coords', (c, q) => {
  setHostSpot(c.lat, c.lng);
  // Prefill the spot name from the address if the host hasn't typed one.
  const labelInput = document.getElementById('host-label');
  if (!labelInput.value.trim()) labelInput.value = c.label || q;
});

document.getElementById('host-add').addEventListener('click', async () => {
  const errorEl = document.getElementById('host-error');
  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  };
  if (!hostSpot) {
    showError('Search an address or click the map to set the spot location first.');
    return;
  }
  const payload = {
    label: document.getElementById('host-label').value.trim(),
    hostName: document.getElementById('host-name').value.trim(),
    lat: hostSpot.lat,
    lng: hostSpot.lng,
    pricePerHour: +document.getElementById('host-price').value || 0,
    availableFrom: document.getElementById('host-from').value || '00:00',
    availableUntil: document.getElementById('host-until').value || '23:59',
    availableFromDate: document.getElementById('host-from-date').value || null,
    availableUntilDate: document.getElementById('host-until-date').value || null,
  };
  try {
    await api('/api/spots', { method: 'POST', body: JSON.stringify(payload) });
    showError('');
    hostSpot = null;
    destLayer.clearLayers();
    document.getElementById('host-coords').textContent =
      'Search an address or click the map to set location';
    document.getElementById('host-search').value = '';
    document.getElementById('host-label').value = '';
    await loadSpots();
  } catch (err) {
    showError(err.message);
  }
});

function renderHostList() {
  const ul = document.getElementById('host-list');
  ul.innerHTML = '';
  spots.forEach((s) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${esc(s.label)} · $${s.pricePerHour.toFixed(2)}/hr<br>
      <span class="sub">${esc(fmtDateRange(s))} · ${esc(s.availableFrom)}–${esc(s.availableUntil)}</span></span>`;
    const del = document.createElement('button');
    del.className = 'x';
    del.textContent = '×';
    del.title = 'Remove spot';
    del.setAttribute('aria-label', `Remove ${s.label}`);
    del.addEventListener('click', async () => {
      await api(`/api/spots/${s.id}`, { method: 'DELETE' });
      await loadSpots();
    });
    li.appendChild(del);
    li.addEventListener('mouseenter', () => map.setView([s.lat, s.lng], 16));
    ul.appendChild(li);
  });
}

// --- HOSTS directory -------------------------------------------------------

/** One spot row in the hosts directory. With a date filter, shows that day's status and bookings. */
function hostSpotRow(s, date) {
  const booked = `${s.bookingCount} booking${s.bookingCount === 1 ? '' : 's'}${date ? ' this day' : ''}`;
  let dayInfo = '';
  if (date && !s.openOnDate) {
    dayInfo = `<span class="sub fail">Not offered on this date</span>`;
  } else if (date && s.bookings.length) {
    dayInfo = `<ul class="day-bookings">${s.bookings
      .map(
        (b) =>
          `<li>${esc(b.startTime)}–${esc(b.endTime)} · ${esc(b.userName)}${
            b.destinationLabel ? ` → ${esc(b.destinationLabel)}` : ''
          } · $${Number(b.price || 0).toFixed(2)}</li>`
      )
      .join('')}</ul>`;
  } else if (date) {
    dayInfo = `<span class="sub ok">Free all day (${esc(s.availableFrom)}–${esc(s.availableUntil)})</span>`;
  }

  return `
    <li data-spot-id="${esc(s.id)}" tabindex="0" role="button"
        aria-label="Show ${esc(s.label)} on map" class="${date && !s.openOnDate ? 'closed' : ''}">
      <span>${esc(s.label)}</span>
      <span class="sub">$${s.pricePerHour.toFixed(2)}/hr · ${esc(fmtDateRange(s))} ·
        ${esc(s.availableFrom)}–${esc(s.availableUntil)} · ${booked}</span>
      ${dayInfo}
    </li>`;
}

async function loadHosts() {
  const el = document.getElementById('hosts-list');
  const date = document.getElementById('hosts-date').value;
  document.getElementById('hosts-date-note').textContent = date
    ? `Showing bookings and earnings for ${fmtDate(date)}.`
    : 'Showing all dates.';
  try {
    const hosts = await api(date ? `/api/hosts?date=${encodeURIComponent(date)}` : '/api/hosts');
    if (!hosts.length) {
      el.innerHTML = `<p class="hint">No hosts yet. List a spot in "Host a spot".</p>`;
      return;
    }

    el.innerHTML = hosts
      .map((h) => {
        const open = date ? h.spots.filter((s) => s.openOnDate).length : h.spots.length;
        return `
        <div class="card">
          <div class="big">${esc(h.hostName)}
            <span class="badge">${date ? `${open}/${h.spots.length} open` : `${h.spots.length} spot${h.spots.length === 1 ? '' : 's'}`}</span>
          </div>
          <div class="meta">
            ${h.bookingCount} booking${h.bookingCount === 1 ? '' : 's'} ·
            $${h.earnings.toFixed(2)} earned${date ? ' this day' : ''}
          </div>
          <ul class="spot-list host-spots">
            ${h.spots.map((s) => hostSpotRow(s, date)).join('')}
          </ul>
        </div>`;
      })
      .join('');

    el.querySelectorAll('[data-spot-id]').forEach((li) => {
      const show = () => focusSpot(li.dataset.spotId);
      li.addEventListener('click', show);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          show();
        }
      });
    });
  } catch (err) {
    el.innerHTML = `<p class="err">${esc(err.message)}</p>`;
  }
}

document.getElementById('hosts-date').addEventListener('change', () => loadHosts());
document.getElementById('hosts-date-clear').addEventListener('click', () => {
  document.getElementById('hosts-date').value = '';
  loadHosts();
});

// --- BATCH flow ------------------------------------------------------------

document.getElementById('batch-add').addEventListener('click', () => {
  batchArming = true;
  document.getElementById('batch-help').textContent = 'Now click the map to drop this destination.';
});

document.getElementById('batch-clear').addEventListener('click', () => {
  batchDests = [];
  batchArming = false;
  renderBatchDests();
  routeLayer.clearLayers();
  document.getElementById('batch-result').innerHTML = '';
});

function renderBatchDests() {
  destLayer.clearLayers();
  batchDests.forEach((d, i) => {
    L.marker([d.lat, d.lng], { icon: destIcon(i + 1) }).addTo(destLayer).bindPopup(esc(d.label));
  });
  const ul = document.getElementById('batch-list');
  ul.innerHTML = '';
  batchDests.forEach((d, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${i + 1}. ${esc(d.label)}</span>`;
    ul.appendChild(li);
  });
}

document.getElementById('batch-run').addEventListener('click', async () => {
  const resultEl = document.getElementById('batch-result');
  if (batchDests.length === 0) {
    resultEl.innerHTML = `<p class="err">Add at least one destination.</p>`;
    return;
  }
  const hours = +document.getElementById('batch-hours').value || 1;
  const date = document.getElementById('batch-date').value || todayISO();
  const startTime = document.getElementById('batch-start').value || '09:00';

  resultEl.innerHTML = `<p class="hint">Getting walking distances and optimizing…</p>`;
  try {
    const data = await api('/api/assign', {
      method: 'POST',
      body: JSON.stringify({
        requests: batchDests.map((d, i) => ({
          userName: `User ${i + 1}`,
          lat: d.lat,
          lng: d.lng,
          label: d.label,
          date,
          startTime,
          hours,
        })),
      }),
    });

    routeLayer.clearLayers();
    const selected = new Set();
    data.assignments.forEach((a) => {
      selected.add(a.spot.id);
      drawWalk(routeLayer, a.route, a.spot, a.request);
    });
    renderSpots(selected);

    const src = data.distanceSource;
    const c = data.comparison;
    const rows = data.assignments
      .map(
        (a) => `<div class="card"><div class="big">${esc(a.request.label)} → ${esc(a.spot.label)}</div>
          <div class="meta">Walk ${walkLabel(a.walkMeters, src)} (~${a.walkMinutes} min) · $${a.price.toFixed(2)}</div></div>`
      )
      .join('');

    const unassigned = data.unassigned.length
      ? `<p class="err">${data.unassigned.length} request(s) unassigned: no free spot on ${esc(fmtDate(date))} at that time.</p>`
      : '';

    const verdict =
      c.greedyAssigned < c.hungarianAssigned
        ? `Greedy would have left ${c.hungarianAssigned - c.greedyAssigned} driver(s) without a spot`
        : `Saved ${fmtMeters(c.savedMeters)} of walking vs greedy`;

    resultEl.innerHTML = `
      <div class="compare">
        <div><strong>Hungarian total walk:</strong> ${walkLabel(c.hungarianTotalWalkMeters, src)}</div>
        <div>Naive greedy total walk: ${walkLabel(c.greedyTotalWalkMeters, src)}</div>
        <div class="ok">${verdict}</div>
        <div class="sub">${distanceNote(src)}</div>
      </div>
      ${rows}${unassigned}`;
  } catch (err) {
    resultEl.innerHTML = `<p class="err">${esc(err.message)}</p>`;
  }
});

// --- Reset -----------------------------------------------------------------

document.getElementById('reset-btn').addEventListener('click', async () => {
  await api('/api/reset', { method: 'POST' });
  findDest = null;
  batchDests = [];
  destLayer.clearLayers();
  routeLayer.clearLayers();
  document.getElementById('find-result').innerHTML = '';
  document.getElementById('batch-result').innerHTML = '';
  await loadSpots();
});

// --- Boot ------------------------------------------------------------------

loadSpots().catch((err) => {
  console.error(err);
  alert('Could not load spots: ' + err.message);
});
