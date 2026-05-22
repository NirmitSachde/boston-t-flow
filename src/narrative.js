// Narrative moments. A curated 24-hour story arc.
// Each moment fires when the simulation time crosses its `start` second.

export const PHASES = [
  { from:  0, to: 4*3600,    label: 'Late-night quiet' },
  { from: 4*3600, to: 6*3600, label: 'System wakes' },
  { from: 6*3600, to: 9.5*3600, label: 'Morning rush' },
  { from: 9.5*3600, to: 11*3600, label: 'Post-rush' },
  { from: 11*3600, to: 15*3600, label: 'Midday steady-state' },
  { from: 15*3600, to: 16*3600, label: 'School out' },
  { from: 16*3600, to: 19*3600, label: 'Evening rush' },
  { from: 19*3600, to: 22*3600, label: 'Evening dispersal' },
  { from: 22*3600, to: 25*3600, label: 'Last trains' }
];

export const MOMENTS = [
  { t:  5 * 3600,            time: '5:00 AM', text: 'First trains roll out of the yards. Alewife to Ashmont begins.' },
  { t:  6.75 * 3600,         time: '6:45 AM', text: 'The Red Line fills first. Commuters from Cambridge and Quincy converge on downtown.' },
  { t:  8.25 * 3600,         time: '8:15 AM', text: 'Peak morning flow. Every line breathes inbound. Downtown swallows the city.' },
  { t:  10 * 3600,           time: '10:00 AM', text: 'Rush hour fades. The system settles into its midday rhythm.' },
  { t:  12 * 3600,           time: '12:00 PM', text: 'Lunchtime brings a quieter cross-current of short trips, errands and transfers at Park Street.' },
  { t:  15.25 * 3600,        time: '3:15 PM', text: 'School lets out. The Green Line carries students west toward Brookline and Newton.' },
  { t:  17.25 * 3600,        time: '5:15 PM', text: 'Evening exodus. The morning flow reverses and downtown empties outward.' },
  { t:  18.5 * 3600,         time: '6:30 PM', text: 'Lingering rush. Slower than the morning peak but longer.' },
  { t:  20 * 3600,           time: '8:00 PM', text: 'Dinner-hour ridership: dispersed, social, no longer commute-shaped.' },
  { t:  22.5 * 3600,         time: '10:30 PM', text: 'Service thins. Headways stretch. The city quiets.' },
  { t:  24.75 * 3600 % 86400, time: '12:45 AM', text: 'Last train. Tomorrow begins in three hours.' }
];

export function getPhase(t) {
  for (const p of PHASES) if (t >= p.from && t < p.to) return p.label;
  return PHASES[PHASES.length - 1].label;
}

export function findActiveMoment(t, prevT) {
  // Fire when we cross the moment's t boundary
  for (const m of MOMENTS) {
    if (prevT < m.t && t >= m.t) return m;
    // Allow time wraparound across midnight
    if (prevT > t && (m.t > prevT || m.t < t)) return m;
  }
  return null;
}

export function formatClock(t) {
  const h = Math.floor(t / 3600) % 24;
  const m = Math.floor((t % 3600) / 60);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return {
    time: `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
    ampm
  };
}
