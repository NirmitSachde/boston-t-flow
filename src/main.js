// Main entry. Real MBTA data, deck.gl animation, full interactivity.

import { loadAllMBTAData, loadLiveVehicles, loadAlerts, loadPredictions, LINES } from './mbta.js';
import { FlowAnimation } from './animation.js';
import { PHASES, MOMENTS, getPhase, findActiveMoment, formatClock } from './narrative.js';
import { loadWeather } from './weather.js';

const $ = (id) => document.getElementById(id);

// ---------- DOM refs ----------
const intro = $('intro');
const introStatus = $('introStatus');
const introProgress = $('introProgress');
const introTrain = $('introTrain');
const introTrail = $('introTrail');
const introError = $('introError');
const introErrorTitle = $('introErrorTitle');
const introErrorBody = $('introErrorBody');
const introErrorCountdown = $('introErrorCountdown');
const introErrorRetry = $('introErrorRetry');
const introStart = $('introStart');
const clockTime = $('clockTime');
const clockAmpm = $('clockAmpm');
const phaseEl = $('phase');
const statActive = $('statActive');
const statTrips = $('statTrips');
const statStops = $('statStops');
const narrativeEl = $('narrative');
const narrativeTime = $('narrativeTime');
const narrativeText = $('narrativeText');
const playBtn = $('playBtn');
const playIcon = $('playIcon');
const pauseIcon = $('pauseIcon');
const timelineTrack = $('timelineTrack');
const timelineFill = $('timelineFill');
const timelineThumb = $('timelineThumb');
const modeSchedule = $('modeSchedule');
const modeLive = $('modeLive');
const statsLive = $('statsLive');
const liveFresh = $('liveFresh');
const liveCountdown = $('liveCountdown');

// Mobile duplicates (in player footer, visible on small screens)
const modeScheduleMob = $('modeScheduleMob');
const modeLiveMob = $('modeLiveMob');
const statsLiveMob = $('statsLiveMob');
const liveFreshMob = $('liveFreshMob');
const alertBanner = $('alertBanner');
const alertText = $('alertText');
const alertCount = $('alertCount');
const stationPanel = $('stationPanel');
const stationName = $('stationName');
const stationLines = $('stationLines');
const stationArrivals = $('stationArrivals');
const stationClose = $('stationClose');
const stationTooltip = $('stationTooltip');
const searchBox = $('searchBox');
const searchResults = $('searchResults');
const sparkline = $('sparkline');
const weatherIcon = $('weatherIcon');
const weatherTemp = $('weatherTemp');
const weatherLabel = $('weatherLabel');
const sunriseTime = $('sunriseTime');
const sunsetTime = $('sunsetTime');
const timelineDaylight = $('timelineDaylight');

const LINE_COLORS = { Red: '#FF3B47', Orange: '#FFA033', Blue: '#3B7BFF', Green: '#2DD771' };

// ---------- Map ----------
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  center: [-71.075, 42.345],
  zoom: 11.6,
  pitch: 35,
  bearing: -15,
  interactive: false,
  attributionControl: false
});
map.on('error', (e) => console.warn('Map error:', e?.error?.message || e));

// ---------- Animation ----------
const canvas = $('deck-canvas');
const anim = new FlowAnimation(canvas, map);
window.__anim = anim;

// ---------- App data ----------
let stationsByName = new Map();
let stationsById = new Map();
let allAlerts = [];

// ---------- Animated counter ----------
function animateCount(el, to, duration = 600) {
  const from = parseInt((el.textContent || '0').replace(/[^\d-]/g, ''), 10) || 0;
  if (from === to) { el.textContent = to.toLocaleString(); return; }
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const v = Math.round(from + (to - from) * eased);
    el.textContent = v.toLocaleString();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ---------- Boot ----------
async function boot() {
  try {
    const data = await loadAllMBTAData((frac, msg) => {
      introStatus.textContent = msg;
      const pct = Math.min(1, frac);
      if (introTrain) introTrain.style.left = `calc(${(pct * 100).toFixed(1)}% - ${pct * 34}px)`;
      if (introTrail) introTrail.style.width = `${(pct * 100).toFixed(1)}%`;
    });

    // Index stations
    for (const s of data.stations) {
      stationsByName.set(s.name.toLowerCase(), s);
      stationsById.set(s.id, s);
    }

    introStatus.textContent = `Loaded ${data.counts.trips.toLocaleString()} trips · ${data.counts.stations} stations`;
    if (introTrain) introTrain.style.left = `calc(100% - 34px)`;
    if (introTrail) introTrail.style.width = '100%';

    anim.setData(data);
    animateCount(statTrips, data.counts.trips, 1200);
    animateCount(statStops, data.counts.stations, 1200);
    introStart.disabled = false;

    // Sparkline: compute active-trains curve across 24h
    drawSparkline(data.trips);

    // Fetch alerts in background (non-blocking)
    refreshAlerts();
    setInterval(refreshAlerts, 60_000);

    // Fetch weather and draw the daylight band on the timeline
    refreshWeather();
    setInterval(refreshWeather, 10 * 60_000);
  } catch (err) {
    console.error(err);
    showLoadError(err);
  }
}

let retryTimer = null;
function showLoadError(err) {
  const msg = err?.message || String(err);
  const isRateLimit = /429/.test(msg);
  introStatus.textContent = isRateLimit ? 'MBTA rate limit hit' : 'Could not reach MBTA';
  introStatus.style.color = 'var(--error)';
  introErrorTitle.textContent = isRateLimit ? 'MBTA API is busy' : 'Could not reach MBTA';
  introErrorBody.textContent = isRateLimit
    ? 'The free MBTA endpoint allows 20 requests per minute. We will retry automatically.'
    : 'Check your connection. We will retry automatically.';
  introError.hidden = false;
  introStart.disabled = true;
  // Reset progress train
  if (introTrain) introTrain.style.left = '0%';
  if (introTrail) introTrail.style.width = '0%';

  // Auto-retry with countdown
  let secs = 12;
  introErrorCountdown.textContent = `Retrying in ${secs}s…`;
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = setInterval(() => {
    secs -= 1;
    if (secs <= 0) {
      clearInterval(retryTimer); retryTimer = null;
      retryBoot();
    } else {
      introErrorCountdown.textContent = `Retrying in ${secs}s…`;
    }
  }, 1000);
}
function retryBoot() {
  introError.hidden = true;
  introStatus.style.color = '';
  introStatus.textContent = 'Connecting to MBTA V3 API…';
  if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
  boot();
}
introErrorRetry.addEventListener('click', retryBoot);

introStart.addEventListener('click', () => {
  intro.classList.add('hidden');
  startLoop();
});

boot();

// ---------- Sparkline ----------
function drawSparkline(trips) {
  const buckets = new Array(96).fill(0); // 15-min buckets across 24h
  for (const trip of trips) {
    const start = trip.timestamps[0];
    const end = trip.timestamps[trip.timestamps.length - 1];
    const b0 = Math.floor(start / 900);
    const b1 = Math.floor(end / 900);
    for (let i = b0; i <= b1 && i < 96; i++) {
      if (i >= 0) buckets[i]++;
    }
  }
  const max = Math.max(...buckets, 1);
  const W = 480, H = 36;
  const dx = W / (buckets.length - 1);
  const points = buckets.map((v, i) => `${(i * dx).toFixed(1)},${(H - (v / max) * H * 0.95 - 1).toFixed(1)}`);
  const linePath = `M${points.join(' L')}`;
  const areaPath = `M0,${H} L${points.join(' L')} L${W},${H} Z`;

  sparkline.innerHTML = `
    <path d="${areaPath}" fill="rgba(0, 229, 255, 0.10)"/>
    <path d="${linePath}" fill="none" stroke="#00E5FF" stroke-width="1.5" stroke-linejoin="round"/>
    <line id="sparkCursor" x1="0" y1="0" x2="0" y2="${H}" stroke="#FFFFFF" stroke-width="1.2" opacity="0.7"/>
  `;
}

function updateSparklineCursor(t) {
  const cur = document.getElementById('sparkCursor');
  if (!cur) return;
  const x = (t / 86400) * 480;
  cur.setAttribute('x1', x);
  cur.setAttribute('x2', x);
}

// ---------- Weather ----------
function formatHm(secs) {
  if (secs == null) return '···';
  const h = Math.floor(secs / 3600) % 24;
  const m = Math.floor((secs % 3600) / 60);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}
async function refreshWeather() {
  try {
    const w = await loadWeather();
    weatherIcon.textContent = w.icon;
    weatherTemp.textContent = `${w.temperatureF}°F`;
    weatherLabel.textContent = `Boston · ${w.label}`;
    sunriseTime.textContent = formatHm(w.sunriseSec);
    sunsetTime.textContent = formatHm(w.sunsetSec);
    // Draw daylight band on timeline
    if (w.sunriseSec != null && w.sunsetSec != null) {
      const a = (w.sunriseSec / 86400) * 100;
      const b = (w.sunsetSec / 86400) * 100;
      timelineDaylight.style.left = `${a}%`;
      timelineDaylight.style.width = `${Math.max(0, b - a)}%`;
    }
  } catch (e) {
    console.warn('weather load failed', e);
  }
}

// ---------- Alerts ----------
async function refreshAlerts() {
  try {
    allAlerts = await loadAlerts();
    const n = allAlerts.length;
    if (n > 0) {
      alertCount.textContent = n.toString();
      const top = allAlerts[0];
      alertText.textContent = top.shortHeader || top.header || 'Service alert';
      alertBanner.classList.add('visible');
    } else {
      alertBanner.classList.remove('visible');
    }
  } catch (e) {
    console.warn('alerts refresh failed', e);
  }
}

let alertIndex = 0;
setInterval(() => {
  if (!allAlerts.length) return;
  alertIndex = (alertIndex + 1) % allAlerts.length;
  const a = allAlerts[alertIndex];
  alertText.textContent = a.shortHeader || a.header;
}, 6000);

alertBanner.addEventListener('click', () => {
  if (!allAlerts.length) return;
  const a = allAlerts[alertIndex];
  if (a.url) window.open(a.url, '_blank');
  else alert(a.header);
});

// ---------- Line toggles ----------
document.querySelectorAll('.line-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.classList.toggle('active');
    const active = new Set(
      Array.from(document.querySelectorAll('.line-toggle.active')).map(b => b.dataset.line)
    );
    anim.setLineFilter(active);
  });
});

// ---------- Speed ----------
document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    anim.setSpeed(parseInt(btn.dataset.speed, 10));
  });
});

// ---------- Play/pause ----------
playBtn.addEventListener('click', () => {
  anim.playing = !anim.playing;
  playIcon.style.display = anim.playing ? 'none' : '';
  pauseIcon.style.display = anim.playing ? '' : 'none';
});

// ---------- Timeline scrubbing ----------
let scrubbing = false;
function scrubTo(clientX) {
  const r = timelineTrack.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  anim.setTime(frac * 86400);
}
function startScrub(clientX) {
  scrubbing = true;
  anim.setPlaying(false);
  playIcon.style.display = '';
  pauseIcon.style.display = 'none';
  scrubTo(clientX);
}

// Mouse scrubbing
timelineTrack.addEventListener('mousedown', (e) => startScrub(e.clientX));
window.addEventListener('mousemove', (e) => { if (scrubbing) scrubTo(e.clientX); });
window.addEventListener('mouseup', () => { scrubbing = false; });

// Touch scrubbing
timelineTrack.addEventListener('touchstart', (e) => {
  startScrub(e.touches[0].clientX);
  e.preventDefault();
}, { passive: false });
window.addEventListener('touchmove', (e) => {
  if (scrubbing) {
    scrubTo(e.touches[0].clientX);
    e.preventDefault();
  }
}, { passive: false });
window.addEventListener('touchend', () => { scrubbing = false; });

// ---------- Mode toggle (desktop + mobile) ----------
modeSchedule.addEventListener('click', () => {
  if (!modeSchedule.classList.contains('active')) toggleMode(false);
});
modeLive.addEventListener('click', () => {
  if (!modeLive.classList.contains('active')) toggleMode(true);
});
// Mobile buttons (in player footer)
modeScheduleMob.addEventListener('click', () => {
  if (!modeScheduleMob.classList.contains('active')) toggleMode(false);
});
modeLiveMob.addEventListener('click', () => {
  if (!modeLiveMob.classList.contains('active')) toggleMode(true);
});

const LIVE_REFRESH_MS = 15000;
let liveInterval = null;
let liveCountdownInterval = null;
let liveLastFetch = 0;
let liveLastError = null;

function formatAgo(ms) {
  if (ms < 1500) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}
function updateLiveStatus() {
  if (!anim.liveMode) return;
  const elapsed = Date.now() - liveLastFetch;
  const agoText = liveLastError ? 'refresh failed' : formatAgo(elapsed);
  liveFresh.textContent = agoText;
  liveFreshMob.textContent = agoText;
  const remaining = Math.max(0, LIVE_REFRESH_MS - elapsed);
  liveCountdown.textContent = `next in ${Math.ceil(remaining / 1000)}s`;
}
async function refreshLiveOnce() {
  try {
    const v = await loadLiveVehicles();
    anim.setLiveVehicles(v);
    animateCount(statActive, v.length);
    liveLastFetch = Date.now();
    liveLastError = null;
  } catch (e) {
    liveLastError = e;
    console.warn('live refresh failed:', e);
  }
  updateLiveStatus();
}

async function toggleMode(live) {
  if (live) {
    // Desktop buttons
    modeLive.classList.add('active'); modeSchedule.classList.remove('active');
    // Mobile buttons
    modeLiveMob.classList.add('active'); modeScheduleMob.classList.remove('active');

    anim.setLiveMode(true);
    statsLive.hidden = false;
    statsLiveMob.hidden = false;
    liveFresh.textContent = 'fetching…';
    liveFreshMob.textContent = 'fetching…';
    liveCountdown.textContent = '';
    await refreshLiveOnce();
    liveInterval = setInterval(refreshLiveOnce, LIVE_REFRESH_MS);
    liveCountdownInterval = setInterval(updateLiveStatus, 1000);
  } else {
    // Desktop buttons
    modeSchedule.classList.add('active'); modeLive.classList.remove('active');
    // Mobile buttons
    modeScheduleMob.classList.add('active'); modeLiveMob.classList.remove('active');

    anim.setLiveMode(false);
    statsLive.hidden = true;
    statsLiveMob.hidden = true;
    if (liveInterval) { clearInterval(liveInterval); liveInterval = null; }
    if (liveCountdownInterval) { clearInterval(liveCountdownInterval); liveCountdownInterval = null; }
  }
}

// ---------- Station hover ----------
anim.onStationHover = (info) => {
  if (info?.object && info.layer?.id === 'stations') {
    const s = info.object;
    stationTooltip.textContent = s.name;
    stationTooltip.style.left = `${info.x + 14}px`;
    stationTooltip.style.top = `${info.y + 14}px`;
    stationTooltip.classList.add('visible');
    canvas.style.cursor = 'pointer';
  } else {
    stationTooltip.classList.remove('visible');
    canvas.style.cursor = 'grab';
  }
};

// ---------- Station click → details panel ----------
anim.onStationClick = (station) => {
  openStation(station);
};

async function openStation(station) {
  stationName.textContent = station.name;
  stationLines.innerHTML = '';
  for (const lineId of station.lines || []) {
    const chip = document.createElement('span');
    chip.className = 'station-line';
    chip.style.setProperty('--line-color', LINE_COLORS[lineId] || '#888');
    chip.textContent = lineId;
    stationLines.appendChild(chip);
  }
  stationArrivals.innerHTML = `
    <div class="station-loading">
      <span class="train-mini">
        <span class="train-track"></span>
        <span class="train-car"><span class="train-light"></span></span>
      </span>
      <span>Pulling live arrivals…</span>
    </div>`;
  stationPanel.classList.add('visible');
  anim.setHighlightStation(station.id);

  try {
    const preds = await loadPredictions(station.id);
    if (preds.length === 0) {
      stationArrivals.innerHTML = '<div class="station-empty">No predictions in the next hour.</div>';
      return;
    }
    stationArrivals.innerHTML = '';
    for (const p of preds.slice(0, 8)) {
      const el = document.createElement('div');
      el.className = 'arrival';
      el.style.setProperty('--line-color', p.lineColor);
      const mins = p.minutesAway;
      const timeStr = mins === 0 ? 'Now' : `${mins} min`;
      el.innerHTML = `
        <span class="arrival-line">${p.lineId || p.routeId}</span>
        <span class="arrival-headsign">${escapeHtml(p.headsign || '')}</span>
        <span class="arrival-time ${mins <= 2 ? 'imminent' : ''}">${timeStr}</span>
      `;
      stationArrivals.appendChild(el);
    }
  } catch (e) {
    stationArrivals.innerHTML = `<div class="station-empty">Could not load predictions.</div>`;
    console.warn(e);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

stationClose.addEventListener('click', () => {
  stationPanel.classList.remove('visible');
  anim.setHighlightStation(null);
});

// ---------- Search ----------
let searchTimer = null;
searchBox.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderSearchResults(searchBox.value.trim()), 80);
});
searchBox.addEventListener('focus', () => {
  if (searchBox.value.trim()) renderSearchResults(searchBox.value.trim());
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) searchResults.classList.remove('visible');
});

function renderSearchResults(q) {
  if (!q || q.length < 1) {
    searchResults.classList.remove('visible');
    return;
  }
  const ql = q.toLowerCase();
  const matches = [];
  for (const s of stationsByName.values()) {
    if (s.name.toLowerCase().includes(ql)) matches.push(s);
    if (matches.length >= 8) break;
  }
  if (!matches.length) {
    searchResults.innerHTML = '<div class="search-result" style="color:var(--fg-dim);cursor:default;">No matches</div>';
    searchResults.classList.add('visible');
    return;
  }
  searchResults.innerHTML = '';
  for (const m of matches) {
    const el = document.createElement('div');
    el.className = 'search-result';
    const dots = (m.lines || []).map(l => `<span class="search-result-dot" style="background:${LINE_COLORS[l]}"></span>`).join('');
    el.innerHTML = `${dots}<span>${escapeHtml(m.name)}</span>`;
    el.addEventListener('click', () => {
      searchBox.value = m.name;
      searchResults.classList.remove('visible');
      anim.flyTo(m.lng, m.lat, 14);
      openStation(m);
    });
    searchResults.appendChild(el);
  }
  searchResults.classList.add('visible');
}

// ---------- Narrative ----------
let lastT = anim.currentTime;
let activeMomentUntil = 0;
function updateNarrative(now) {
  const moment = findActiveMoment(anim.currentTime, lastT);
  if (moment) {
    narrativeTime.textContent = moment.time;
    narrativeText.textContent = moment.text;
    narrativeEl.classList.add('visible');
    activeMomentUntil = now + 7000;
  } else if (now > activeMomentUntil) {
    narrativeEl.classList.remove('visible');
  }
  lastT = anim.currentTime;
}

// ---------- Render loop ----------
let last = performance.now();
let activeSmoothed = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  anim.tick(dt);

  const c = formatClock(anim.currentTime);
  clockTime.textContent = c.time;
  clockAmpm.textContent = c.ampm;
  phaseEl.textContent = getPhase(anim.currentTime);

  if (!anim.liveMode) {
    const target = anim.countActiveTrains();
    activeSmoothed += (target - activeSmoothed) * 0.18;
    statActive.textContent = Math.round(activeSmoothed).toLocaleString();
  }

  const frac = anim.currentTime / 86400;
  timelineFill.style.width = `${frac * 100}%`;
  timelineThumb.style.left = `${frac * 100}%`;
  updateSparklineCursor(anim.currentTime);

  updateNarrative(now);
  requestAnimationFrame(frame);
}

function startLoop() {
  last = performance.now();
  requestAnimationFrame(frame);
}
