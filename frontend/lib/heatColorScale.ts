// One heat scale used everywhere — twin, routes, charts and passport (PRD §8).
// Values are pedestrian feels-like °C.

// A thermal ramp, deliberately with no blue anywhere in it.
//
// Two things were wrong with the blue -> teal -> green version. The scale floor sat
// at 28°C while the twin encodes from 20°C, so every cell below 28 clamped to the
// same saturated blue: a 23°C night rendered the whole city as one flat colour with
// no structure at all. And green in the middle read as "safe" at 42°C, which NOAA
// calls danger. Stops now start at the encoding floor and are pinned to the
// heatLabel() boundaries, so colour and wording change at the same temperature.
//
// Luminance climbs from the cool end up to amber; past that, hue and chroma carry
// the signal, because any saturated red is intrinsically dark (green is 71% of
// luma). The top stop is deliberately kept off true oxblood so the worst cells
// still read against a near-black basemap instead of sinking into it.
// The stops below are a re-tune, not a new scale: every boundary temperature and the
// whole rationale above are unchanged. What changed is the middle, which was reading
// muddy — 178,166,82 is an acid olive-gold, and between it and the sage below it the
// twin spent its two most common daytime bands on two colours that argue with each
// other and with the warm greys of the basemap. These are the same hues held back
// toward the product's ink palette: chroma down, the yellow-green pulled out of the
// mid, and the hot end off pure red so it still reads as a surface rather than a
// warning light.
export const HEAT_STOPS: [number, [number, number, number]][] = [
  [20, [76, 82, 80]], // cool — near-neutral, sits back into the basemap
  [27, [116, 130, 104]], // comfortable ceiling — muted sage
  [32, [176, 170, 104]], // caution — soft gold
  [39, [226, 164, 78]], // extreme caution — amber
  [45, [226, 116, 60]], // burnt orange
  [52, [208, 68, 56]], // danger -> extreme danger — red
  [56, [168, 40, 50]], // off the top of the scale — deep crimson
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
  { max: 25, label: "Low", color: "#8fa055" },
  { max: 45, label: "Moderate", color: "#e8b93c" },
  { max: 65, label: "High", color: "#f16c2c" },
  { max: 101, label: "Extreme", color: "#df342c" },
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
