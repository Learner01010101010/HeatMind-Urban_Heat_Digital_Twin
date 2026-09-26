"use client";

import { api, type Scenario, type TwinResponse } from "./api";

/**
 * Decoded twin keyframes.
 *
 * These used to also carry `heatUrl` / `shadeUrl`: a canvas painted cell by cell
 * through the colour LUT, upscaled 4x, then serialised with toDataURL('image/png')
 * — a main-thread PNG encode of ~635k pixels, thirteen times over, producing
 * multi-megabyte base64 strings that were handed to MapLibre image sources.
 *
 * The raster now goes straight to the GPU as a single-channel texture and the colour
 * ramp is applied per fragment (see components/map/three/groundHeat.ts), so nothing
 * needs encoding and the raw arrays are the only product of this module.
 */
export interface DecodedFrame extends TwinResponse {
  key: string;
  /** feels_c = 20 + v / 4 — linear in degrees, so it is safe to interpolate directly */
  heat: Uint8Array;
  /** sun_exposure = v / 255 */
  shade: Uint8Array;
}

const cache = new Map<string, Promise<DecodedFrame>>();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function frameKey(scenario: Scenario, baseTime: string, offsetMin: number, tempDelta: number) {
  return `${scenario}|${baseTime}|${offsetMin}|${tempDelta}`;
}

export function getFrame(
  scenario: Scenario,
  baseTime: string,
  offsetMin: number,
  tempDelta: number,
): Promise<DecodedFrame> {
  const key = frameKey(scenario, baseTime, offsetMin, tempDelta);
  let p = cache.get(key);
  if (!p) {
    p = api.twin({ scenario, time: baseTime, offset_min: offsetMin, temp_delta: tempDelta }).then((t) => ({
      ...t,
      key,
      heat: b64ToBytes(t.grid.heat_b64),
      shade: b64ToBytes(t.grid.shade_b64),
    }));
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    // Retain two complete forecasts, rather than ninety decoded city rasters.
    if (cache.size > 26) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** Feels-like °C at a lat/lon from a decoded frame (client-side probe). */
export function sampleFrame(f: DecodedFrame, lat: number, lon: number): number | null {
  const [s, w, n, e] = f.grid.bbox;
  if (lat < s || lat > n || lon < w || lon > e) return null;
  const r = Math.min(f.grid.rows - 1, Math.floor(((n - lat) / (n - s)) * f.grid.rows));
  const c = Math.min(f.grid.cols - 1, Math.floor(((lon - w) / (e - w)) * f.grid.cols));
  return 20 + f.heat[r * f.grid.cols + c] / 4;
}
