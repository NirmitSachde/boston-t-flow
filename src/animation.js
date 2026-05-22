// Deck.gl animation engine for MBTA particle flow.
// Uses TripsLayer for moving particles, PathLayer for static route tracks,
// and ScatterplotLayer for stations.

const { Deck } = deck;
const TripsLayer = deck.TripsLayer;
const { PathLayer, ScatterplotLayer } = deck;

const INITIAL_VIEW_STATE = {
  longitude: -71.075,
  latitude: 42.345,
  zoom: 11.6,
  pitch: 35,
  bearing: -15,
  maxPitch: 60,
  minZoom: 9,
  maxZoom: 16
};

export class FlowAnimation {
  constructor(canvas, map) {
    this.canvas = canvas;
    this.map = map;
    this.currentTime = 5 * 3600; // start at 05:00
    this.playing = true;
    this.speed = 300; // seconds of simulated time per real-time second
    this.trailLength = 600; // seconds
    this.lineFilter = new Set(['Red', 'Orange', 'Blue', 'Green']);
    this.liveMode = false;
    this.trips = [];
    this.referencePaths = [];
    this.stations = [];
    this.liveVehicles = [];
    this.highlightStationId = null;
    this.viewState = INITIAL_VIEW_STATE;

    this.onStationHover = null;
    this.onStationClick = null;

    this.deck = new Deck({
      canvas,
      initialViewState: INITIAL_VIEW_STATE,
      controller: true,
      onViewStateChange: ({ viewState }) => {
        this.viewState = viewState;
        this.syncMap(viewState);
      },
      onHover: (info) => {
        if (this.onStationHover) this.onStationHover(info);
      },
      onClick: (info) => {
        if (info?.object && info.layer?.id === 'stations' && this.onStationClick) {
          this.onStationClick(info.object, info);
        }
      },
      layers: []
    });
    // Make deck canvas capture pointer events for picking
    canvas.style.pointerEvents = 'auto';

    this.syncMap(INITIAL_VIEW_STATE);
  }

  syncMap(vs) {
    this.map.jumpTo({
      center: [vs.longitude, vs.latitude],
      zoom: vs.zoom,
      pitch: vs.pitch,
      bearing: vs.bearing
    });
  }

  setData({ trips, referencePaths, stations }) {
    this.trips = trips;
    this.referencePaths = referencePaths;
    this.stations = stations;
    this.render();
  }

  setLineFilter(set) {
    this.lineFilter = new Set(set);
    this.render();
  }

  setTime(t) {
    this.currentTime = ((t % 86400) + 86400) % 86400;
    this.render();
  }

  setSpeed(s) { this.speed = s; }
  setPlaying(p) { this.playing = p; }
  setLiveMode(on) {
    this.liveMode = on;
    this.render();
  }
  setLiveVehicles(v) {
    this.liveVehicles = v || [];
    this.render();
  }
  setHighlightStation(id) {
    this.highlightStationId = id;
    this.render();
  }
  flyTo(lng, lat, zoom = 13.5) {
    const target = { ...this.viewState, longitude: lng, latitude: lat, zoom, transitionDuration: 1200, transitionInterpolator: new deck.FlyToInterpolator() };
    this.deck.setProps({ initialViewState: target });
    this.viewState = target;
    this.syncMap(target);
  }

  tick(realDeltaSeconds) {
    if (this.playing && !this.liveMode) {
      this.currentTime = (this.currentTime + realDeltaSeconds * this.speed) % 86400;
      this.render();
    }
  }

  render() {
    const t = this.currentTime;

    const visibleTrips = this.trips.filter(p => this.lineFilter.has(p.lineId));
    const visibleRefs = this.referencePaths.filter(p => this.lineFilter.has(p.lineId));

    const layers = [
      // Static dim route tracks
      new PathLayer({
        id: 'route-tracks',
        data: visibleRefs,
        getPath: d => d.path,
        getColor: d => [...d.color, 60],
        getWidth: 3,
        widthMinPixels: 1.5,
        widthMaxPixels: 4,
        pickable: false
      }),

      // Stations . outer halo
      new ScatterplotLayer({
        id: 'station-halos',
        data: this.stations,
        getPosition: d => [d.lng, d.lat],
        getRadius: 180,
        getFillColor: d => d.id === this.highlightStationId ? [0, 229, 255, 90] : [255, 255, 255, 14],
        radiusMinPixels: 5,
        radiusMaxPixels: 16,
        stroked: false,
        pickable: false,
        updateTriggers: { getFillColor: [this.highlightStationId] }
      }),
      // Stations . pickable dot
      new ScatterplotLayer({
        id: 'stations',
        data: this.stations,
        getPosition: d => [d.lng, d.lat],
        getRadius: 70,
        getFillColor: d => d.id === this.highlightStationId ? [0, 229, 255, 255] : [220, 225, 255, 220],
        getLineColor: d => d.id === this.highlightStationId ? [255, 255, 255, 255] : [110, 120, 160, 220],
        lineWidthMinPixels: 1,
        radiusMinPixels: 3,
        radiusMaxPixels: 8,
        stroked: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [0, 229, 255, 200],
        updateTriggers: { getFillColor: [this.highlightStationId], getLineColor: [this.highlightStationId] }
      }),

      // Trip glow halo (wider, more translucent)
      !this.liveMode && new TripsLayer({
        id: 'trips-glow',
        data: visibleTrips,
        getPath: d => d.path,
        getTimestamps: d => d.timestamps,
        getColor: d => [...d.color, 90],
        opacity: 0.6,
        widthMinPixels: 8,
        widthMaxPixels: 18,
        jointRounded: true,
        capRounded: true,
        trailLength: this.trailLength,
        currentTime: t,
        shadowEnabled: false
      }),

      // Moving particle trips (only in schedule mode)
      !this.liveMode && new TripsLayer({
        id: 'trips',
        data: visibleTrips,
        getPath: d => d.path,
        getTimestamps: d => d.timestamps,
        getColor: d => d.color,
        opacity: 1.0,
        widthMinPixels: 3.5,
        widthMaxPixels: 9,
        jointRounded: true,
        capRounded: true,
        trailLength: this.trailLength,
        currentTime: t,
        shadowEnabled: false
      }),

      // Live vehicles . outer glow
      this.liveMode && new ScatterplotLayer({
        id: 'live-vehicles-glow',
        data: this.liveVehicles.filter(v => this.lineFilter.has(v.lineId)),
        getPosition: d => [d.lng, d.lat],
        getRadius: 280,
        getFillColor: d => [...d.color, 70],
        radiusMinPixels: 10,
        radiusMaxPixels: 24,
        stroked: false,
        pickable: false
      }),
      // Live vehicles . solid dot
      this.liveMode && new ScatterplotLayer({
        id: 'live-vehicles',
        data: this.liveVehicles.filter(v => this.lineFilter.has(v.lineId)),
        getPosition: d => [d.lng, d.lat],
        getRadius: 120,
        getFillColor: d => [...d.color, 255],
        getLineColor: [255, 255, 255, 240],
        lineWidthMinPixels: 1.5,
        radiusMinPixels: 5,
        radiusMaxPixels: 11,
        stroked: true,
        pickable: true,
        updateTriggers: { getFillColor: this.liveVehicles.length }
      })
    ].filter(Boolean);

    this.deck.setProps({ layers });
  }

  // Count active trains at current time
  countActiveTrains() {
    if (this.liveMode) {
      return this.liveVehicles.filter(v => this.lineFilter.has(v.lineId)).length;
    }
    const t = this.currentTime;
    let n = 0;
    for (const trip of this.trips) {
      if (!this.lineFilter.has(trip.lineId)) continue;
      const start = trip.timestamps[0];
      const end = trip.timestamps[trip.timestamps.length - 1];
      if (t >= start && t <= end) n++;
    }
    return n;
  }
}
