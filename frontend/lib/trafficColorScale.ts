/**
 * Congestion → colour for the route line.
 *
 * Deliberately not the heat ramp. Heat already owns green-through-red on this
 * map, so reusing it would make a jammed road read as a hot one. Traffic runs its
 * own way: clear roads stay a muted teal that recedes, and the scale climbs
 * through amber into deep purple, which is the one strong hue the heat palette
 * never uses and so can only mean traffic.
 *
 * Congestion is TomTom's definition, carried through the twin: 1 - current speed
 * / free-flow speed, so 0 is free-flowing and 1 is stopped.
 */

export interface TrafficBand {
  /** Lower bound of the band, inclusive. */
  from: number;
  color: string;
  label: string;
}

export const TRAFFIC_BANDS: TrafficBand[] = [
  { from: 0, color: "#4d7c78", label: "Free flowing" },
  { from: 0.25, color: "#c2a63e", label: "Light" },
  { from: 0.45, color: "#d97b3c", label: "Moderate" },
  { from: 0.65, color: "#8b3fa8", label: "Heavy" },
  { from: 0.85, color: "#4a1a63", label: "Severe" },
];

/** Below this a road is not worth drawing as congested at all. */
export const TRAFFIC_VISIBLE_AT = 0.2;

export function trafficColor(congestion: number): string {
  let band = TRAFFIC_BANDS[0];
  for (const candidate of TRAFFIC_BANDS) if (congestion >= candidate.from) band = candidate;
  return band.color;
}

export function trafficLabel(congestion: number): string {
  let band = TRAFFIC_BANDS[0];
  for (const candidate of TRAFFIC_BANDS) if (congestion >= candidate.from) band = candidate;
  return band.label;
}

/** "62% slower than free flow" reads better than a bare 0.62. */
export const trafficPct = (congestion: number) => `${Math.round(congestion * 100)}% below free flow`;
