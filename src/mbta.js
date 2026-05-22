// MBTA V3 API data loader . batched, rate-limited, cached.
// Loads real route geometry, stops, and a day of schedules,
// then builds animated trip paths for Deck.gl TripsLayer.

import { decodePolyline, nearestIndex, interpolateAlong } from './polyline.js';

const API = 'https://api-v3.mbta.com';
const ROUTES_CSV = 'Red,Orange,Blue,Green-B,Green-C,Green-D,Green-E';

export const LINES = [
  { id: 'Red',    route_ids: ['Red'],    color: [218, 41, 28],  rgb: '#DA291C', label: 'Red Line' },
  { id: 'Orange', route_ids: ['Orange'], color: [237, 139, 0],  rgb: '#ED8B00', label: 'Orange Line' },
  { id: 'Blue',   route_ids: ['Blue'],   color: [0, 102, 220],  rgb: '#0066DC', label: 'Blue Line' },
  { id: 'Green',  route_ids: ['Green-B','Green-C','Green-D','Green-E'],
    color: [0, 165, 76],  rgb: '#00A54C', label: 'Green Line' }
];

const ROUTE_TO_LINE = {};
for (const L of LINES) for (const r of L.route_ids) ROUTE_TO_LINE[r] = L;

// ----- Rate-limited fetch queue -----
let queue = Promise.resolve();
let lastReqEnd = 0;
const MIN_GAP_MS = 250;

function withRateLimit(fn) {
  const p = queue.then(async () => {
    const gap = Date.now() - lastReqEnd;
    if (gap < MIN_GAP_MS) await new Promise(r => setTimeout(r, MIN_GAP_MS - gap));
    try { return await fn(); } finally { lastReqEnd = Date.now(); }
  });
  queue = p.catch(() => {}); // keep the chain alive on errors
  return p;
}

async function fetchWithRetry(url, attempt = 0) {
  let r;
  try {
    r = await fetch(url, { headers: { 'Accept': 'application/vnd.api+json' } });
  } catch (e) {
    if (attempt < 3) {
      await new Promise(res => setTimeout(res, 800 * (attempt + 1)));
      return fetchWithRetry(url, attempt + 1);
    }
    throw e;
  }
  if (r.status === 429 && attempt < 5) {
    const retryAfter = parseInt(r.headers.get('Retry-After') || '0', 10);
    const wait = retryAfter ? retryAfter * 1000 : Math.min(8000, (1 << attempt) * 1000) + Math.random() * 500;
    await new Promise(res => setTimeout(res, wait));
    return fetchWithRetry(url, attempt + 1);
  }
  if (!r.ok) throw new Error(`MBTA API ${r.status} on ${url}`);
  return r.json();
}

const CACHE_PREFIX = 'mbta:v2:';
async function api(path) {
  const cacheKey = CACHE_PREFIX + path;
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (_) {}
  const data = await withRateLimit(() => fetchWithRetry(`${API}${path}`));
  try { sessionStorage.setItem(cacheKey, JSON.stringify(data)); } catch (_) {}
  return data;
}

// ----- Helpers -----
function serviceDateString(d = new Date()) {
  // Boston is UTC-4 (EDT) in May. Service date can start at 03:00 local.
  const boston = new Date(d.getTime() - 4 * 3600 * 1000);
  return boston.toISOString().slice(0, 10);
}

function parseTimeToSeconds(iso) {
  if (!iso) return null;
  const m = iso.match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

// =====================================================================
// Step 1: All canonical patterns across all routes (1 call)
//   Plus the included representative_trip records (with shape ids)
// =====================================================================
async function loadAllPatterns() {
  const json = await api(
    `/route_patterns?filter%5Broute%5D=${ROUTES_CSV}` +
    `&filter%5Bcanonical%5D=true` +
    `&include=representative_trip`
  );
  // Build map: routeId+dir → { tripId, shapeId }
  const byRouteDir = {};
  const tripsById = {};
  for (const inc of (json.included || [])) {
    if (inc.type === 'trip') tripsById[inc.id] = inc;
  }
  for (const p of json.data) {
    if (p.id.startsWith('Shuttle')) continue;
    const routeId = p.relationships?.route?.data?.id;
    const dir = p.attributes.direction_id;
    const tripId = p.relationships?.representative_trip?.data?.id;
    const trip = tripsById[tripId];
    const shapeId = trip?.relationships?.shape?.data?.id;
    const key = `${routeId}:${dir}`;
    if (!shapeId) continue;
    // Prefer first (canonical) match; if multiple, keep the first one
    if (!byRouteDir[key]) byRouteDir[key] = { routeId, dir, tripId, shapeId };
  }
  return byRouteDir;
}

// =====================================================================
// Step 2: Fetch all shapes for the listed shape IDs.
//   /shapes does not support filter[id], so we fetch per-route (7 calls)
//   and keep only the IDs we want.
// =====================================================================
async function loadShapesByRoute(wantedIds) {
  const want = new Set(wantedIds);
  const out = {};
  const routes = ROUTES_CSV.split(',');
  for (const r of routes) {
    const j = await api(`/shapes?filter%5Broute%5D=${r}`);
    for (const s of j.data) {
      if (want.has(s.id)) out[s.id] = decodePolyline(s.attributes.polyline);
    }
  }
  // For any still missing, fetch individually
  for (const id of wantedIds) {
    if (out[id]) continue;
    try {
      const j = await api(`/shapes/${encodeURIComponent(id)}`);
      if (j?.data?.attributes?.polyline) out[id] = decodePolyline(j.data.attributes.polyline);
    } catch (e) { /* swallow per-id failures */ }
  }
  return out;
}

// =====================================================================
// Step 3: All stops across all routes (1 call)
//   Also fetch PARENT stations separately so we have stable place-* IDs
//   for predictions.
// =====================================================================
async function loadAllStops() {
  const [childJson, parentJson] = await Promise.all([
    api(`/stops?filter%5Broute%5D=${ROUTES_CSV}`),
    api(`/stops?filter%5Broute%5D=${ROUTES_CSV}&filter%5Blocation_type%5D=1`)
  ]);
  const stops = {};
  const parents = {};
  for (const s of childJson.data) {
    stops[s.id] = {
      id: s.id,
      name: s.attributes.name,
      lng: s.attributes.longitude,
      lat: s.attributes.latitude,
      parentId: s.relationships?.parent_station?.data?.id || null
    };
  }
  for (const s of parentJson.data) {
    parents[s.id] = {
      id: s.id,
      name: s.attributes.name,
      lng: s.attributes.longitude,
      lat: s.attributes.latitude,
      isParent: true
    };
  }
  return { stops, parents };
}

async function resolveMissingStops(missingIds, stops) {
  if (missingIds.size === 0) return;
  const ids = Array.from(missingIds);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).join(',');
    const json = await api(`/stops?filter%5Bid%5D=${encodeURIComponent(chunk)}`);
    for (const s of json.data) {
      stops[s.id] = {
        id: s.id, name: s.attributes.name,
        lng: s.attributes.longitude, lat: s.attributes.latitude
      };
    }
  }
}

// =====================================================================
// Step 4: Schedules . batched across all routes, sampled across time-of-day
//   We pull multiple time windows so we get diverse trip coverage.
// =====================================================================
async function loadSchedulesAll(date) {
  // Time windows tuned to maximize trip diversity at low call count
  const windows = [
    { min: '05:00', max: '08:30' },
    { min: '08:30', max: '12:00' },
    { min: '12:00', max: '15:30' },
    { min: '15:30', max: '19:00' },
    { min: '19:00', max: '23:00' },
    { min: '23:00', max: '27:00' }
  ];

  const byTrip = new Map();

  for (const w of windows) {
    const url =
      `/schedules?filter%5Broute%5D=${ROUTES_CSV}` +
      `&filter%5Bdate%5D=${date}` +
      `&filter%5Bmin_time%5D=${w.min}` +
      `&filter%5Bmax_time%5D=${w.max}` +
      `&page%5Blimit%5D=2000`;
    const json = await api(url);
    for (const s of (json.data || [])) {
      const tripId = s.relationships?.trip?.data?.id;
      const stopId = s.relationships?.stop?.data?.id;
      if (!tripId || !stopId) continue;
      const time = parseTimeToSeconds(s.attributes.departure_time || s.attributes.arrival_time);
      if (time == null) continue;
      if (!byTrip.has(tripId)) {
        byTrip.set(tripId, {
          tripId,
          direction: s.attributes.direction_id,
          stops: []
        });
      }
      byTrip.get(tripId).stops.push({
        stopId,
        sequence: s.attributes.stop_sequence,
        time
      });
    }
  }

  for (const t of byTrip.values()) {
    t.stops.sort((a, b) => a.sequence - b.sequence);
  }
  return Array.from(byTrip.values());
}

// =====================================================================
// Step 5: Bind each trip to its route. We don't get route directly from
//   schedules in our fast batch . but we can use stop_id presence.
//   Easier: fetch trips metadata in bulk (1 call).
// =====================================================================
async function loadTripRoutes(tripIds) {
  // /trips endpoint with filter[id] . supports up to 500 ids per request
  const out = {};
  const ids = Array.from(tripIds);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200).join(',');
    const json = await api(`/trips?filter%5Bid%5D=${encodeURIComponent(chunk)}`);
    for (const t of (json.data || [])) {
      const routeId = t.relationships?.route?.data?.id;
      const shapeId = t.relationships?.shape?.data?.id;
      out[t.id] = { routeId, shapeId, direction: t.attributes.direction_id };
    }
  }
  return out;
}

// =====================================================================
// Step 6: Build animated trip paths
// =====================================================================
function buildTripPaths(trips, tripRoutes, shapesByRouteDir, allShapes, stops) {
  const out = [];
  for (const trip of trips) {
    const meta = tripRoutes[trip.tripId];
    if (!meta) continue;
    const routeId = meta.routeId;
    const line = ROUTE_TO_LINE[routeId];
    if (!line) continue;

    // Prefer the trip's own shape if we have it; else fall back to canonical
    let coords = meta.shapeId && allShapes[meta.shapeId];
    if (!coords) {
      const c = shapesByRouteDir[`${routeId}:${trip.direction}`];
      coords = c?.coords;
    }
    if (!coords || coords.length < 2) continue;

    // Map stops → polyline indices
    const hits = [];
    for (const st of trip.stops) {
      const stop = stops[st.stopId];
      if (!stop) continue;
      const idx = nearestIndex(coords, [stop.lng, stop.lat]);
      hits.push({ idx, time: st.time });
    }
    if (hits.length < 2) continue;

    // Build path with interpolation along polyline between scheduled stops
    const path = [];
    const timestamps = [];
    for (let i = 0; i < hits.length - 1; i++) {
      const a = hits[i], b = hits[i + 1];
      const seg = interpolateAlong(coords, a.idx, b.idx, 6);
      const dt = b.time - a.time;
      if (dt <= 0) continue;
      for (let k = 0; k < seg.length - 1; k++) {
        path.push(seg[k]);
        timestamps.push(a.time + (k / (seg.length - 1)) * dt);
      }
    }
    const last = hits[hits.length - 1];
    path.push(coords[last.idx]);
    timestamps.push(last.time);
    if (path.length < 2) continue;

    out.push({
      path,
      timestamps,
      color: line.color,
      lineId: line.id,
      routeId,
      direction: trip.direction
    });
  }
  return out;
}

// =====================================================================
// Master loader
// =====================================================================
export async function loadAllMBTAData(progressCb = () => {}) {
  const date = serviceDateString();
  const STEPS = 6;
  let step = 0;
  const tick = (msg) => progressCb(++step / STEPS, msg);

  tick('Fetching canonical route patterns…');
  const patternsByRouteDir = await loadAllPatterns();
  const canonicalShapeIds = Array.from(new Set(Object.values(patternsByRouteDir).map(p => p.shapeId)));

  tick('Fetching route geometry…');
  const canonicalShapes = await loadShapesByRoute(canonicalShapeIds);

  // Index by route:dir for fallback
  const shapesByRouteDir = {};
  for (const key of Object.keys(patternsByRouteDir)) {
    const p = patternsByRouteDir[key];
    const coords = canonicalShapes[p.shapeId];
    if (coords) shapesByRouteDir[key] = { coords, shapeId: p.shapeId };
  }

  tick('Fetching stations…');
  const { stops, parents: parentStops } = await loadAllStops();

  tick('Fetching schedules for today…');
  const trips = await loadSchedulesAll(date);

  tick('Resolving trip metadata…');
  const tripIds = trips.map(t => t.tripId);
  const tripRoutes = await loadTripRoutes(tripIds);

  // Resolve any platform-level stops missing from our stops cache
  const missing = new Set();
  for (const t of trips) for (const st of t.stops) if (!stops[st.stopId]) missing.add(st.stopId);
  if (missing.size > 0) await resolveMissingStops(missing, stops);

  tick('Building animated trips…');
  // Fetch trip-specific shapes that aren't in canonical set
  const extraShapeIds = new Set();
  for (const t of trips) {
    const m = tripRoutes[t.tripId];
    if (m?.shapeId && !canonicalShapes[m.shapeId]) extraShapeIds.add(m.shapeId);
  }
  let extraShapes = {};
  if (extraShapeIds.size > 0 && extraShapeIds.size <= 50) {
    extraShapes = await loadShapesByRoute(Array.from(extraShapeIds));
  }
  const allShapes = { ...canonicalShapes, ...extraShapes };

  const tripPaths = buildTripPaths(trips, tripRoutes, shapesByRouteDir, allShapes, stops);

  // Reference paths: one polyline per route per direction (the dim track)
  const referencePaths = [];
  for (const key of Object.keys(shapesByRouteDir)) {
    const [routeId, dir] = key.split(':');
    const line = ROUTE_TO_LINE[routeId];
    if (!line) continue;
    referencePaths.push({
      path: shapesByRouteDir[key].coords,
      color: line.color,
      lineId: line.id,
      routeId,
      direction: +dir
    });
  }

  // Build station list . prefer parent stations (place-*) since they have stable
  // IDs we can use for predictions queries. Track which lines serve each station.
  const stationMap = new Map();
  // First pass: seed with parent stations
  for (const s of Object.values(parentStops)) {
    if (!s.lng || !s.lat) continue;
    stationMap.set(s.name, { id: s.id, name: s.name, lng: s.lng, lat: s.lat, lines: new Set() });
  }
  // For any station name only appearing in child stops, add it
  for (const s of Object.values(stops)) {
    if (!s.lng || !s.lat) continue;
    if (!stationMap.has(s.name)) {
      stationMap.set(s.name, { id: s.parentId || s.id, name: s.name, lng: s.lng, lat: s.lat, lines: new Set() });
    }
  }
  // Tag stations with the lines they serve, by proximity to reference paths.
  // For each station, walk every reference polyline and find the closest point;
  // if it's within ~120m, the station serves that line.
  for (const station of stationMap.values()) {
    for (const ref of referencePaths) {
      const idx = nearestIndex(ref.path, [station.lng, station.lat]);
      const p = ref.path[idx];
      const d = Math.hypot((p[0] - station.lng) * 85000, (p[1] - station.lat) * 111000);
      if (d < 140) station.lines.add(ref.lineId);
    }
  }
  for (const s of stationMap.values()) s.lines = Array.from(s.lines);

  return {
    date,
    trips: tripPaths,
    referencePaths,
    stations: Array.from(stationMap.values()),
    counts: {
      trips: tripPaths.length,
      stations: stationMap.size,
      routes: ROUTES_CSV.split(',').length
    }
  };
}

// =====================================================================
// Service alerts: real-time disruptions affecting the subway
// =====================================================================
export async function loadAlerts() {
  const url = `${API}/alerts?filter%5Broute%5D=${ROUTES_CSV}&filter%5Bactivity%5D=BOARD,EXIT,RIDE`;
  const r = await fetchWithRetry(url);
  return (r.data || []).map(a => {
    const routes = (a.relationships?.routes?.data || []).map(d => d.id);
    return {
      id: a.id,
      header: a.attributes.header,
      shortHeader: a.attributes.short_header,
      severity: a.attributes.severity,
      effect: a.attributes.effect,
      lifecycle: a.attributes.lifecycle,
      cause: a.attributes.cause,
      url: a.attributes.url,
      routes
    };
  }).filter(a => a.lifecycle === 'NEW' || a.lifecycle === 'ONGOING');
}

// =====================================================================
// Predictions: next train arrivals at a given stop
// =====================================================================
export async function loadPredictions(stopId) {
  // Stop IDs can be parent (place-*) or child (numeric). Both work.
  // Filter to subway routes only . predictions for a station also include buses.
  const url = `${API}/predictions?filter%5Bstop%5D=${encodeURIComponent(stopId)}&filter%5Broute%5D=${ROUTES_CSV}&include=route,trip&sort=arrival_time`;
  const r = await fetchWithRetry(url);
  const included = {};
  for (const inc of (r.included || [])) {
    included[`${inc.type}:${inc.id}`] = inc;
  }
  const now = Date.now();
  return (r.data || []).map(p => {
    const routeId = p.relationships?.route?.data?.id;
    const tripId = p.relationships?.trip?.data?.id;
    const route = included[`route:${routeId}`];
    const trip = included[`trip:${tripId}`];
    const line = ROUTE_TO_LINE[routeId];
    const arrival = p.attributes.arrival_time || p.attributes.departure_time;
    const t = arrival ? new Date(arrival).getTime() : null;
    const minutesAway = t ? Math.max(0, Math.round((t - now) / 60000)) : null;
    return {
      id: p.id,
      routeId,
      lineId: line?.id,
      lineColor: line?.rgb || '#888',
      headsign: trip?.attributes?.headsign || route?.attributes?.long_name || routeId,
      direction: p.attributes.direction_id,
      status: p.attributes.status,
      arrival,
      minutesAway
    };
  }).filter(p => p.minutesAway != null && p.minutesAway < 60);
}

// Resolve a stop's parent ID (place-*) if available . predictions work better at parent level.
export function parentStopId(stop) {
  // The /stops payload includes parent_station relationships; for our cached stops
  // we may not have this. Strategy: if stop.id starts with "place-" use it; else
  // try a heuristic match by name later.
  return stop?.id || null;
}

// =====================================================================
// Live mode: current vehicle positions
// =====================================================================
export async function loadLiveVehicles() {
  // Don't cache live data
  const url = `${API}/vehicles?filter%5Broute%5D=${ROUTES_CSV}`;
  const r = await fetchWithRetry(url);
  return r.data.map(v => {
    const routeId = v.relationships?.route?.data?.id;
    const line = ROUTE_TO_LINE[routeId];
    return {
      id: v.id,
      lng: v.attributes.longitude,
      lat: v.attributes.latitude,
      bearing: v.attributes.bearing,
      status: v.attributes.current_status,
      routeId,
      lineId: line?.id,
      color: line?.color || [200, 200, 200]
    };
  }).filter(v => v.lng && v.lat);
}
