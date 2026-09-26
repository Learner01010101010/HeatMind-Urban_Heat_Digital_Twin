"use client";

/**
 * What this device can afford, in one place.
 *
 * The twin was tuned on a desktop GPU and the zone has since grown about tenfold
 * (Narhe to Swargate). Costs that scale with the zone grew with it and were never
 * re-measured — most importantly the sun-exposure march, which now renders a
 * 5046x2664 target: 13.4 megapixels, 51 MB, up to 140 steps a pixel. A desktop
 * absorbs that. A phone does not.
 *
 * Everything here is a *budget*, not a visual switch. Nothing in this module removes
 * a building, a tree, a road or any UI: it caps how finely the same scene is sampled.
 * That distinction is the whole design. Shadow geometry comes from a 10 m raster and
 * is identical at every setting; supersampling only sharpens the shadow's *edge*, so
 * a lower budget costs edge crispness and nothing else.
 *
 * Supersampling and canvas density are bounded on desktop too: integrated GPUs
 * need room for the moving camera and route overlays as well as the shadow pass.
 */

export interface DeviceProfile {
  /** True for phones and tablets — coarse pointer, or a small viewport. */
  mobile: boolean;
  /**
   * Maximum pixels in the sun-exposure render target.
   *
   * The march is bounded by this rather than by a fixed supersample factor, because
   * the factor's cost is quadratic in the zone size: the same `6` that was cheap on
   * the old zone is 13.4 MP on this one, and would be worse again on a bigger one.
   * A pixel budget cannot be broken by growing the zone.
   */
  maxExposurePixels: number;
  /** Upper bound on the supersample factor, whatever the pixel budget allows. */
  maxSupersample: number;
  /**
   * Cap on devicePixelRatio for the map canvas.
   *
   * A phone at DPR 3 renders nine times the fragments of DPR 1, for a difference
   * most people cannot see on a 6-inch panel. Every fragment cost in the scene —
   * ground heat, buildings, canopy, the lot — scales with this.
   */
  maxPixelRatio: number;
  /**
   * Degrees of sun movement that force a re-march while the timeline is being
   * scrubbed. At rest the fine value below is used instead.
   */
  sunStepDegScrub: number;
  /** Degrees of sun movement that force a re-march when nothing is moving. */
  sunStepDegRest: number;
  /** Canopy instance budget by metres-of-ground-per-pixel, coarsest last. */
  treeBudget: [number, number][];
}

const DESKTOP: DeviceProfile = {
  mobile: false,
  // 3x the current grid is 3.36 MP, versus 13.44 MP at 6x. It still
  // supersamples the same physics fields without changing heat or route scores.
  maxExposurePixels: 4_000_000,
  maxSupersample: 4,
  maxPixelRatio: 2,
  sunStepDegScrub: 1,
  sunStepDegRest: 0.25,
  treeBudget: [
    [0.6, Infinity],
    [1.6, 46_000],
    [4, 18_000],
    [Infinity, 7_000],
  ],
};

const MOBILE: DeviceProfile = {
  mobile: true,
  // Sized so the integer factor lands on 3x for the current grid (3.4 MP, 13 MB):
  // still three times the physics resolution in each axis, and far finer than the
  // 10 m raster the occluder heights come from, at a quarter of the original 6x march.
  // The budget is what binds, not the factor, so a bigger zone steps down to 2x on
  // its own rather than quietly costing nine times more.
  maxExposurePixels: 3_600_000,
  maxSupersample: 4,
  maxPixelRatio: 2,
  // A three-hour scrub swings the sun ~45 degrees. At 0.25 that is ~180 full
  // re-marches during one drag; at 2 degrees it is ~22, and the shadows still move
  // continuously because the scene relights every frame from the same buffer.
  // The moment scrubbing stops, the fine value re-marches once and the result is
  // identical to never having throttled.
  sunStepDegScrub: 2.0,
  sunStepDegRest: 0.4,
  treeBudget: [
    [0.6, 30_000],
    [1.6, 16_000],
    [4, 7_000],
    [Infinity, 3_000],
  ],
};

function detect(): DeviceProfile {
  if (typeof window === "undefined") return DESKTOP;
  // Pointer type over user-agent sniffing: it answers the question actually being
  // asked (is this a touch device driving a mobile GPU) and does not rot with every
  // browser release. The width test catches desktop browsers in device-emulation
  // mode and small tablets that report a fine pointer.
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const small = window.matchMedia?.("(max-width: 1024px)").matches ?? false;
  return coarse || small ? MOBILE : DESKTOP;
}

let cached: DeviceProfile | null = null;

/** The active profile. Resolved once — a phone does not become a desktop mid-session. */
export function deviceProfile(): DeviceProfile {
  if (!cached) cached = detect();
  return cached;
}

/**
 * Largest supersample factor that keeps `cols x rows x f^2` inside the pixel budget.
 *
 * Returned as an integer so the target stays an exact multiple of the physics grid:
 * a fractional factor would put field texels on non-integer boundaries and shimmer
 * along shadow edges as the sun moves.
 */
export function supersampleFor(cols: number, rows: number, p = deviceProfile()): number {
  const cells = Math.max(1, cols * rows);
  const byBudget = Math.floor(Math.sqrt(p.maxExposurePixels / cells));
  return Math.max(1, Math.min(p.maxSupersample, byBudget));
}

/** Canopy budget for the current metres-per-pixel, from the profile's tiers. */
export function treeBudgetFor(metresPerPixel: number, p = deviceProfile()): number {
  for (const [limit, budget] of p.treeBudget) {
    if (metresPerPixel <= limit) return budget;
  }
  return p.treeBudget[p.treeBudget.length - 1][1];
}
