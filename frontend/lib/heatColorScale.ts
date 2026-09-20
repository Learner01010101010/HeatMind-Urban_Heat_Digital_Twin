// One heat scale used everywhere — twin, routes, charts and passport (PRD §8).
// Values are pedestrian feels-like °C.

export const HEAT_STOPS: [number, [number, number, number]][] = [
  [28, [29, 78, 216]], // deep blue — comfortable
  [35, [14, 165, 183]], // teal — caution
  [42, [34, 197, 94]], // green — shaded, but already NOAA "danger"
  [46.5, [250, 204, 21]], // yellow
  [50, [249, 115, 22]], // orange
  [53, [220, 38, 38]], // red — extreme danger (NOAA ≥ 52°C)
  [56, [127, 29, 29]], // deep red
];

export const SCALE_MIN = HEAT_STOPS[0][0];
export const SCALE_MAX = HEAT_STOPS[HEAT_STOPS.length - 1][0];

export function heatRgb(c: number): [number, number, number] {
  if (c <= SCALE_MIN) return HEAT_STOPS[0][1];
  if (c >= SCALE_MAX) return HEAT_STOPS[HEAT_STOPS.length - 1][1];
  for (let i = 0; i < HEAT_STOPS.length - 1; i++) {
    const [a, ca] = HEAT_STOPS[i];
    const [b, cb] = HEAT_STOPS[i + 1];
    if (c >= a && c <= b) {
      const t = (c - a) / (b - a);
      return [0, 1, 2].map((k) => Math.round(ca[k] + (cb[k] - ca[k]) * t)) as [number, number, number];
    }
  }
  return HEAT_STOPS[0][1];
}

export function heatColor(c: number, alpha = 1): string {
  const [r, g, b] = heatRgb(c);
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/** Lookup table for the uint8 twin encoding: feels_c = 20 + v/4 */
export const TWIN_LUT: Uint8ClampedArray = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let v = 0; v < 256; v++) {
    const [r, g, b] = heatRgb(20 + v / 4);
    lut[v * 3] = r;
    lut[v * 3 + 1] = g;
    lut[v * 3 + 2] = b;
  }
  return lut;
})();

export const RISK_BANDS = [
  { max: 25, label: "Low", color: "#2dd4bf" },
  { max: 45, label: "Moderate", color: "#facc15" },
  { max: 65, label: "High", color: "#f97316" },
  { max: 101, label: "Extreme", color: "#ef4444" },
];

export function riskColor(score: number): string {
  return (RISK_BANDS.find((b) => score < b.max) ?? RISK_BANDS[RISK_BANDS.length - 1]).color;
}

export function heatLabel(c: number): string {
  if (c < 27) return "Comfortable";
  if (c < 32) return "Caution";
  if (c < 39) return "Extreme caution";
  if (c < 52) return "Danger";
  return "Extreme danger";
}

export type Units = "C" | "F";

export function fmtTemp(c: number | null | undefined, units: Units, digits = 0): string {
  if (c === null || c === undefined || Number.isNaN(c)) return "—";
  const v = units === "F" ? (c * 9) / 5 + 32 : c;
  return `${v.toFixed(digits)}°${units}`;
}

export function fmtDelta(c: number, units: Units, digits = 1): string {
  const v = units === "F" ? (c * 9) / 5 : c;
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}°`;
}

/** Wall-clock time in the user's own locale/time zone. */
export function fmtClock(iso: string | number | Date): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function fmtDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}
