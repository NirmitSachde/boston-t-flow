// Tiny Google Encoded Polyline decoder.
// Returns an array of [lng, lat] pairs (note: lng/lat for deck.gl/maplibre).
export function decodePolyline(str, precision = 5) {
  const factor = Math.pow(10, precision);
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];

  while (index < str.length) {
    let result = 1, shift = 0, b;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 1; shift = 0;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    coordinates.push([lng / factor, lat / factor]);
  }
  return coordinates;
}

// Haversine distance in meters between two [lng, lat] points.
export function distMeters(a, b) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const lat1 = a[1] * toRad, lat2 = b[1] * toRad;
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Compute cumulative distance along a polyline. Returns [d0=0, d1, ...].
export function cumulativeDistances(coords) {
  const out = [0];
  for (let i = 1; i < coords.length; i++) {
    out.push(out[i - 1] + distMeters(coords[i - 1], coords[i]));
  }
  return out;
}

// Find the index of the point on the polyline closest to the given [lng,lat].
export function nearestIndex(coords, point) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = distMeters(coords[i], point);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Interpolate evenly-spaced waypoints along a slice of the polyline
// between indices i0..i1 (inclusive), creating roughly `n` segments
// between them. Returns array of [lng, lat] points.
export function interpolateAlong(coords, i0, i1, n) {
  if (i0 === i1) return [coords[i0]];
  const reverse = i0 > i1;
  const start = Math.min(i0, i1), end = Math.max(i0, i1);
  const slice = coords.slice(start, end + 1);
  if (reverse) slice.reverse();

  // Resample to exactly n+1 points along the slice
  const cum = cumulativeDistances(slice);
  const total = cum[cum.length - 1];
  if (total === 0) return [slice[0]];

  const result = [];
  for (let k = 0; k <= n; k++) {
    const target = (k / n) * total;
    // find segment
    let j = 1;
    while (j < cum.length && cum[j] < target) j++;
    if (j >= cum.length) { result.push(slice[slice.length - 1]); continue; }
    const t = (target - cum[j - 1]) / (cum[j] - cum[j - 1] || 1);
    const a = slice[j - 1], b = slice[j];
    result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return result;
}
