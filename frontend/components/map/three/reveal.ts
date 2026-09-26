"use client";

import * as THREE from "three";
import type { TwinFields } from "./fields";

/**
 * Progressive reveal: the twin is only drawn where you have been.
 *
 * A coverage field at the physics grid's own resolution. Each position fix paints a
 * soft disc into it and keeps the maximum, so ground already walked stays revealed
 * while the street ahead resolves as you approach it. Every shader in the scene
 * multiplies by this field, so heat, roads, buildings and canopy all appear together
 * rather than one layer floating over undiscovered ground.
 *
 * Accumulating on the CPU rather than in a render target is deliberate: only the cells
 * inside one radius are touched per fix (a few hundred), the field is tiny, and keeping
 * it as a plain array means the reveal survives a context loss and can be queried
 * directly for "how much of the zone have you covered".
 */

/** Metres of fully-revealed radius around a position fix. */
export const REVEAL_RADIUS_M = 220;
/** Additional metres over which the reveal fades out to nothing. */
export const REVEAL_FEATHER_M = 140;
/**
 * Half-width of the band revealed either side of a planned route.
 *
 * Wide enough to carry the street's own context -- the buildings that actually
 * shade it, the canopy along it, the junctions it passes -- without paying to
 * draw a city the trip never goes near. With the feather this is a ~600 m
 * corridor, which over a Narhe-to-Swargate route is roughly a tenth of the cells
 * the full zone would cost.
 */
export const ROUTE_CORRIDOR_M = 170;

export class RevealField {
  readonly texture: THREE.DataTexture;
  private readonly data: Uint8Array;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cellM: number;
  private revealedCells = 0;
  private allRevealed = false;

  constructor(private readonly fields: TwinFields) {
    this.cols = fields.cols;
    this.rows = fields.rows;
    this.cellM = fields.cellM;
    this.data = new Uint8Array(this.cols * this.rows);
    this.texture = new THREE.DataTexture(
      this.data,
      this.cols,
      this.rows,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  /** Write one cell, keeping the maximum. Returns true if it changed. */
  private poke(r: number, c: number, d: number, radiusM: number): boolean {
    const v = d <= radiusM ? 1 : 1 - (d - radiusM) / REVEAL_FEATHER_M;
    const byte = Math.round(Math.max(0, Math.min(1, v)) * 255);
    const i = r * this.cols + c;
    if (byte <= this.data[i]) return false;
    if (this.data[i] < 128 && byte >= 128) this.revealedCells++;
    this.data[i] = byte;
    return true;
  }

  /** Paint a fix at lat/lon. Returns true when anything new became visible. */
  addFix(lat: number, lon: number, radiusM = REVEAL_RADIUS_M): boolean {
    const [x, y] = this.fields.origin.toXY(lat, lon);
    const outer = radiusM + REVEAL_FEATHER_M;

    // The grid is stored GL-side-up (v = 0 at the south edge), matching fields.ts.
    const c0 = Math.max(0, Math.floor((x - outer) / this.cellM));
    const c1 = Math.min(this.cols - 1, Math.ceil((x + outer) / this.cellM));
    const r0 = Math.max(0, Math.floor((y - outer) / this.cellM));
    const r1 = Math.min(this.rows - 1, Math.ceil((y + outer) / this.cellM));
    if (c0 > c1 || r0 > r1) return false; // fix is outside the zone

    let changed = false;
    for (let r = r0; r <= r1; r++) {
      const cy = (r + 0.5) * this.cellM;
      for (let c = c0; c <= c1; c++) {
        const cx = (c + 0.5) * this.cellM;
        const d = Math.hypot(cx - x, cy - y);
        if (d <= outer && this.poke(r, c, d, radiusM)) changed = true;
      }
    }
    if (changed) this.texture.needsUpdate = true;
    return changed;
  }

  /**
   * Reveal a corridor along a planned route.
   *
   * Distance is measured to the nearest *segment*, not to stamped discs along it:
   * a route across open ground has vertices hundreds of metres apart, and disc
   * stamping would leave the corridor scalloped between them. Only the cells in
   * each segment's own expanded bbox are visited, so cost tracks the route's
   * length rather than the size of the zone -- which is what makes this affordable
   * once the zone is the whole Narhe-to-Swargate corridor.
   */
  addPath(coords: [number, number][], radiusM = ROUTE_CORRIDOR_M): boolean {
    if (coords.length === 0) return false;
    if (coords.length === 1) return this.addFix(coords[0][0], coords[0][1], radiusM);

    const outer = radiusM + REVEAL_FEATHER_M;
    let changed = false;

    for (let k = 0; k < coords.length - 1; k++) {
      const [ax, ay] = this.fields.origin.toXY(coords[k][0], coords[k][1]);
      const [bx, by] = this.fields.origin.toXY(coords[k + 1][0], coords[k + 1][1]);

      const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - outer) / this.cellM));
      const c1 = Math.min(this.cols - 1, Math.ceil((Math.max(ax, bx) + outer) / this.cellM));
      const r0 = Math.max(0, Math.floor((Math.min(ay, by) - outer) / this.cellM));
      const r1 = Math.min(this.rows - 1, Math.ceil((Math.max(ay, by) + outer) / this.cellM));
      if (c0 > c1 || r0 > r1) continue; // this leg lies outside the zone

      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;

      for (let r = r0; r <= r1; r++) {
        const cy = (r + 0.5) * this.cellM;
        for (let c = c0; c <= c1; c++) {
          const cx = (c + 0.5) * this.cellM;
          // clamped projection onto the segment
          const t = len2 > 0
            ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / len2))
            : 0;
          const d = Math.hypot(cx - (ax + t * dx), cy - (ay + t * dy));
          if (d <= outer && this.poke(r, c, d, radiusM)) changed = true;
        }
      }
    }
    if (changed) this.texture.needsUpdate = true;
    return changed;
  }

  /** Reveal the whole zone at once (the "show everything" escape hatch). */
  revealAll() {
    this.data.fill(255);
    this.revealedCells = this.cols * this.rows;
    this.allRevealed = true;
    this.texture.needsUpdate = true;
  }

  clear() {
    this.data.fill(0);
    this.revealedCells = 0;
    this.allRevealed = false;
    this.texture.needsUpdate = true;
  }

  /**
   * Is this point inside the revealed corridor?
   *
   * Used to decide what to *build*, not what to shade. The shaders multiply by this
   * same field to fade the corridor's edge, but a fragment discarded at the end of
   * the pipeline has already cost its vertex transform, and the whole-zone building
   * mesh is 2.85 million of them. Asking the question here instead means the geometry
   * outside the corridor is never created.
   *
   * Deliberately generous: `min` of 1 rather than the feathered value, so a building
   * on the soft edge is built and then faded by the shader, instead of popping into
   * existence when the corridor creeps over its centroid.
   */
  covers(x: number, y: number, marginM = 0): boolean {
    if (this.allRevealed) return true;
    // Row 0 is the SOUTH edge here, matching addFix and addPath — this grid is
    // stored GL-side-up, not in image order.
    const c0 = Math.max(0, Math.floor((x - marginM) / this.cellM));
    const c1 = Math.min(this.cols - 1, Math.floor((x + marginM) / this.cellM));
    const r0 = Math.max(0, Math.floor((y - marginM) / this.cellM));
    const r1 = Math.min(this.rows - 1, Math.floor((y + marginM) / this.cellM));
    for (let r = r0; r <= r1; r++) {
      const base = r * this.cols;
      for (let c = c0; c <= c1; c++) {
        if (this.data[base + c] > 0) return true;
      }
    }
    return false;
  }

  /** True once the whole zone has been revealed — nothing left to cull against. */
  get isAll(): boolean {
    return this.allRevealed;
  }

  get coverage(): number {
    return this.revealedCells / (this.cols * this.rows);
  }

  dispose() {
    this.texture.dispose();
  }
}

/**
 * GLSL every scene shader shares, so one definition governs how undiscovered ground
 * looks. `uRevealOn` at 0 disables the whole mechanic with no branch divergence cost
 * worth worrying about.
 */
export const REVEAL_GLSL = `
uniform sampler2D uReveal;
uniform float uRevealOn;

float revealAt(vec2 uv) {
  float r = texture2D(uReveal, clamp(uv, 0.0, 1.0)).r;
  return mix(1.0, r, uRevealOn);
}
`;
