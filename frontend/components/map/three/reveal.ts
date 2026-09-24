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

export class RevealField {
  readonly texture: THREE.DataTexture;
  private readonly data: Uint8Array;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cellM: number;
  private revealedCells = 0;

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
        if (d > outer) continue;
        const v = d <= radiusM ? 1 : 1 - (d - radiusM) / REVEAL_FEATHER_M;
        const byte = Math.round(Math.max(0, Math.min(1, v)) * 255);
        const i = r * this.cols + c;
        if (byte > this.data[i]) {
          if (this.data[i] < 128 && byte >= 128) this.revealedCells++;
          this.data[i] = byte;
          changed = true;
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
    this.texture.needsUpdate = true;
  }

  clear() {
    this.data.fill(0);
    this.revealedCells = 0;
    this.texture.needsUpdate = true;
  }

  /** Fraction of the zone revealed so far, 0..1. */
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
