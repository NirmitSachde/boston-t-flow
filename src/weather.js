// Open-Meteo client. Free, no API key.
// Returns current Boston conditions plus today sunrise and sunset.

const URL = 'https://api.open-meteo.com/v1/forecast'
  + '?latitude=42.36&longitude=-71.06'
  + '&current=temperature_2m,weather_code,wind_speed_10m,is_day,relative_humidity_2m'
  + '&temperature_unit=fahrenheit&wind_speed_unit=mph'
  + '&timezone=America/New_York'
  + '&daily=sunrise,sunset&forecast_days=1';

// WMO weather codes mapped to short labels and icons.
const WMO = {
  0:  { label: 'Clear',          icon: '☀' },
  1:  { label: 'Mostly clear',   icon: '🌤' },
  2:  { label: 'Partly cloudy',  icon: '⛅' },
  3:  { label: 'Overcast',       icon: '☁' },
  45: { label: 'Fog',            icon: '🌫' },
  48: { label: 'Rime fog',       icon: '🌫' },
  51: { label: 'Light drizzle',  icon: '🌦' },
  53: { label: 'Drizzle',        icon: '🌦' },
  55: { label: 'Heavy drizzle',  icon: '🌧' },
  61: { label: 'Light rain',     icon: '🌦' },
  63: { label: 'Rain',           icon: '🌧' },
  65: { label: 'Heavy rain',     icon: '🌧' },
  71: { label: 'Light snow',     icon: '🌨' },
  73: { label: 'Snow',           icon: '🌨' },
  75: { label: 'Heavy snow',     icon: '❄' },
  80: { label: 'Showers',        icon: '🌧' },
  81: { label: 'Showers',        icon: '🌧' },
  82: { label: 'Heavy showers',  icon: '⛈' },
  95: { label: 'Thunderstorm',   icon: '⛈' },
  96: { label: 'Thunderstorm',   icon: '⛈' },
  99: { label: 'Severe storm',   icon: '⛈' }
};

// Parse an ISO time string of the form "2026-05-21T05:16" (no zone)
// into seconds-since-midnight of that day, in local America/New_York time.
function isoLocalToSeconds(iso) {
  if (!iso) return null;
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60;
}

export async function loadWeather() {
  const r = await fetch(URL);
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const d = await r.json();
  const cur = d.current || {};
  const code = cur.weather_code;
  const meta = WMO[code] || { label: 'Conditions', icon: '·' };
  return {
    temperatureF: Math.round(cur.temperature_2m),
    humidity: Math.round(cur.relative_humidity_2m),
    windMph: Math.round(cur.wind_speed_10m),
    code,
    label: meta.label,
    icon: meta.icon,
    isDay: cur.is_day === 1,
    sunriseSec: isoLocalToSeconds(d.daily?.sunrise?.[0]),
    sunsetSec: isoLocalToSeconds(d.daily?.sunset?.[0])
  };
}
