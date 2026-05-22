# Boston Breathes T. MBTA Ridership Flow

An animated visualization of Boston MBTA subway system pulsing through a full 24-hour day. Every particle is a real, scheduled train. Every flow is built from live MBTA data. No fallbacks, no synthetic fixtures.

![Concept](https://img.shields.io/badge/data-MBTA%20V3%20API-DA291C) ![Stack](https://img.shields.io/badge/stack-deck.gl%20%2B%20MapLibre-003DA5)

## What it does

Watch Boston transit system come alive across a 24-hour cycle:

- **Schedule mode** replays one full service day of subway operations. Particles flow along Red, Orange, Blue and Green lines in real geographic space, with timing pulled from MBTA published schedule for today.
- **Live mode** pulls every active train GPS position from the MBTA V3 API and renders them as glowing dots on the map, refreshed every 15 seconds.
- **Station details panel** opens on click. Shows real-time next arrivals from MBTA predictions API.
- **Station search** with live fly-to camera.
- **Narrative moments** surface at key times: 5:00 AM first trains, 8:15 AM peak rush, 5:15 PM evening exodus, last train at 12:45 AM.
- **Service alerts** banner shows live disruptions.
- **Weather widget** pulls current Boston conditions and draws a daylight band on the timeline.

## Data sources

Everything is fetched at runtime. No preprocessing scripts, no offline pipeline.

| Endpoint | What it does |
| --- | --- |
| MBTA `/routes` | Subway route metadata |
| MBTA `/route_patterns?filter[canonical]=true` | Canonical inbound and outbound shapes per branch |
| MBTA `/shapes?filter[route]=...` | Encoded polyline geometry per line |
| MBTA `/stops?filter[route]=...` | Station positions (lat/lng) plus parent station IDs |
| MBTA `/schedules?filter[route]=...&filter[date]=...` | Full day of scheduled stop-times |
| MBTA `/trips?filter[id]=...` | Resolving trip to route and shape mappings |
| MBTA `/vehicles?filter[route]=...` | Live train positions and bearings (refreshed every 15s) |
| MBTA `/alerts?filter[route]=...` | Active service disruptions |
| MBTA `/predictions?filter[stop]=...` | Next arrivals per station, live |
| Open-Meteo `/v1/forecast` | Current Boston temperature, conditions, sunrise and sunset |

Trip animation paths are constructed by:
1. Snapping each scheduled stop to its closest point on the route polyline
2. Interpolating evenly-spaced waypoints along the polyline between consecutive stops
3. Linearly distributing timestamps across those waypoints from the schedule

## Stack

- **[deck.gl](https://deck.gl)** TripsLayer for GPU-accelerated particle animation, PathLayer for static route geometry, ScatterplotLayer for stations and live vehicles
- **[MapLibre GL JS](https://maplibre.org)** with [CARTO Dark Matter](https://carto.com/attribution) basemap (free, no API key)
- **Vanilla JS** ES modules, no build step, no bundler

## Running it

```bash
# Any static file server works. From the project root:
python3 -m http.server 8766
# then open http://localhost:8766/
```

First load fetches roughly 14 MBTA API calls (5 to 8 seconds with rate limiting). All responses are cached in `sessionStorage` for the duration of the session.

## Project layout

```
boston-t-flow/
├── index.html              # Page shell, CDN imports, UI markup
├── src/
│   ├── main.js             # Entry: orchestration, UI events, render loop
│   ├── mbta.js             # MBTA V3 API loader (rate-limited, cached, batched)
│   ├── weather.js          # Open-Meteo client for Boston weather and sun times
│   ├── animation.js        # Deck.gl FlowAnimation class. Layers and view state
│   ├── narrative.js        # 24-hour phase labels and timed story moments
│   ├── polyline.js         # Encoded-polyline decoder and geodesic helpers
│   └── styles.css          # All styling. Space Grotesk, Inter, JetBrains Mono
└── README.md
```

## Rate limiting notes

The MBTA V3 API allows 20 requests per minute without an API key. The loader handles this by:

- Batching: a single call covers all 7 subway routes (`filter[route]=Red,Orange,Blue,Green-B,Green-C,Green-D,Green-E`)
- Queueing: one request in flight at a time, minimum 250 ms gap between calls
- Retry with exponential backoff on `429 Too Many Requests`
- `sessionStorage` caching so reloads do not re-hit the API

For higher throughput, [request a free key](https://api-v3.mbta.com/) and add `&api_key=...` to the requests in `src/mbta.js`.

## Visual identity

- Typography: **Space Grotesk** (display), **Inter** (body), **JetBrains Mono** (time and data)
- Background: deep navy `#03030C`, fully dark basemap
- Color: MBTA official line colors are the only saturated chroma in the interface
- Animation feel: trails leave 10-minute fade tails. Particles look organic, like blood through arteries.

## Deployment

Any static host. The whole thing is `index.html` plus `src/*`. No server logic, no environment variables.

```bash
# GitHub Pages
git init && git add . && git commit -m "Initial commit"
gh repo create boston-t-flow --public --source . --push
gh repo edit --enable-pages

# or Netlify
netlify deploy --dir . --prod
```

## Credit

Built by [Nirmit Sachde](mailto:sachde.n@northeastern.edu), May 2026.
Data from [MBTA](https://www.mbta.com/developers) and [Open-Meteo](https://open-meteo.com). Basemap from [CARTO](https://carto.com/attributions).
