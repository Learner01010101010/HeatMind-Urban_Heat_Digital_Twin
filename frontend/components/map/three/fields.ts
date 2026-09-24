"use client";

import * as THREE from "three";
import { api, type ZoneFields } from "@/lib/api";
import { TWIN_LUT } from "@/lib/heatColorScale";
import { LocalOrigin } from "./origin";

/** base64 -> bytes, with the rows flipped from image order (row 0 = north) to GL
 *  order (v = 0 at the south edge) so every shader can sample with plain UVs. */
function decodeFlipped(b64: string, rows: number, cols: number): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const src = r * cols;
    const dst = (rows - 1 - r) * cols;
    for (let c = 0; c < cols; c++) out[dst + c] = bin.charCodeAt(src + c);
  }
  return out;
}

function r8(data: Uint8Array, cols: number, rows: number, smooth: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, cols, rows, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter;
  t.minFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** The heat colour scale as a 256x1 texture, so the LUT is applied per-fragment on the
 *  GPU instead of per-cell on the CPU. Identical stops to lib/heatColorScale. */
export function makeLutTexture(): THREE.DataTexture {
  const data = new Uint8Array(256 * 4);
  for (let v = 0; v < 256; v++) {
    data[v * 4] = TWIN_LUT[v * 3];
    data[v * 4 + 1] = TWIN_LUT[v * 3 + 1];
    data[v * 4 + 2] = TWIN_LUT[v * 3 + 2];
    data[v * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** A heat/shade keyframe uploaded as a single-channel texture (no PNG round-trip). */
export function makeFrameTexture(cols: number, rows: number): THREE.DataTexture {
  return r8(new Uint8Array(cols * rows), cols, rows, true);
}

export function uploadFrame(tex: THREE.DataTexture, src: Uint8Array, rows: number, cols: number) {
  const dst = tex.image.data as Uint8Array;
  for (let r = 0; r < rows; r++) {
    dst.set(src.subarray(r * cols, r * cols + cols), (rows - 1 - r) * cols);
  }
  tex.needsUpdate = true;
}

export interface TwinFields {
  rows: number;
  cols: number;
  cellM: number;
  heightScaleM: number;
  origin: LocalOrigin;
  /** building height, metres = texel * heightScaleM */
  height: THREE.DataTexture;
  /** canopy cover 0..1 */
  canopy: THREE.DataTexture;
  /** sky view factor 0..1 — drives both the canyon physics term and ambient occlusion */
  svf: THREE.DataTexture;
  /** raw surface class codes (nearest-sampled) */
  surface: THREE.DataTexture;
  /** 255 on carriageway cells */
  road: THREE.DataTexture;
  raw: { height: Uint8Array; canopy: Uint8Array; svf: Uint8Array; surface: Uint8Array };
  dispose(): void;
}

let pending: Promise<TwinFields> | null = null;

/** Fetch + upload the static twin rasters. Cached for the lifetime of the page. */
export function loadFields(): Promise<TwinFields> {
  if (!pending) {
    pending = api.zoneFields().then((f: ZoneFields) => build(f));
    pending.catch(() => (pending = null));
  }
  return pending;
}

function build(f: ZoneFields): TwinFields {
  const { rows, cols } = f;
  const height = decodeFlipped(f.height_b64, rows, cols);
  const canopy = decodeFlipped(f.canopy_b64, rows, cols);
  const svf = decodeFlipped(f.svf_b64, rows, cols);
  const surface = decodeFlipped(f.surface_b64, rows, cols);
  const road = decodeFlipped(f.road_b64, rows, cols);

  const tex = {
    // NEAREST: interpolating an occluder's height averages it with the zeros around it
    // and shrinks small footprints out of the shadow march (see sunExposure.ts).
    height: r8(height, cols, rows, false),
    canopy: r8(canopy, cols, rows, true),
    svf: r8(svf, cols, rows, true),
    surface: r8(surface, cols, rows, false),
    road: r8(road, cols, rows, true),
  };

  return {
    rows,
    cols,
    cellM: f.cell_m,
    heightScaleM: f.height_scale_m,
    origin: new LocalOrigin(f.origin),
    ...tex,
    raw: { height, canopy, svf, surface },
    dispose() {
      Object.values(tex).forEach((t) => t.dispose());
    },
  };
}
