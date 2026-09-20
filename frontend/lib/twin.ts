"use client";

import { api, type Scenario, type TwinResponse } from "./api";
import { TWIN_LUT } from "./heatColorScale";

export interface DecodedFrame extends TwinResponse {
  key: string;
  heat: Uint8Array;
  shade: Uint8Array;
  heatUrl: string;
  shadeUrl: string;
}

const cache = new Map<string, Promise<DecodedFrame>>();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function renderHeat(heat: Uint8Array, cols: number, rows: number): string {
  const c = document.createElement("canvas");
  c.width = cols;
  c.height = rows;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(cols, rows);
  const feather = 8; // cells of soft fade at the twin boundary
  for (let i = 0; i < heat.length; i++) {
    const v = heat[i];
    const r = Math.floor(i / cols);
    const col = i % cols;
    const edge = Math.min(r, col, rows - 1 - r, cols - 1 - col);
    img.data[i * 4] = TWIN_LUT[v * 3];
    img.data[i * 4 + 1] = TWIN_LUT[v * 3 + 1];
    img.data[i * 4 + 2] = TWIN_LUT[v * 3 + 2];
    img.data[i * 4 + 3] = edge >= feather ? 255 : Math.round(255 * Math.pow(edge / feather, 1.5));
  }
  ctx.putImageData(img, 0, 0);
  // Upscale with smoothing so the 10 m cells read as a continuous surface.
  const up = document.createElement("canvas");
  up.width = cols * 4;
  up.height = rows * 4;
  const uctx = up.getContext("2d")!;
  uctx.imageSmoothingEnabled = true;
  uctx.imageSmoothingQuality = "high";
  uctx.drawImage(c, 0, 0, up.width, up.height);
  return up.toDataURL("image/png");
}

function renderShade(shade: Uint8Array, cols: number, rows: number): string {
  const c = document.createElement("canvas");
  c.width = cols;
  c.height = rows;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(cols, rows);
  for (let i = 0; i < shade.length; i++) {
    const shadeAmt = 1 - shade[i] / 255; // 1 = full shade
    img.data[i * 4] = 8;
    img.data[i * 4 + 1] = 30;
    img.data[i * 4 + 2] = 70;
    img.data[i * 4 + 3] = Math.round(Math.pow(shadeAmt, 1.4) * 215);
  }
  ctx.putImageData(img, 0, 0);
  const up = document.createElement("canvas");
  up.width = cols * 4;
  up.height = rows * 4;
  const uctx = up.getContext("2d")!;
  uctx.imageSmoothingEnabled = true;
  uctx.drawImage(c, 0, 0, up.width, up.height);
  return up.toDataURL("image/png");
}

export function frameKey(scenario: Scenario, baseTime: string, offsetMin: number, tempDelta: number) {
  return `${scenario}|${baseTime}|${offsetMin}|${tempDelta}`;
}

export function getFrame(scenario: Scenario, baseTime: string, offsetMin: number, tempDelta: number): Promise<DecodedFrame> {
  const key = frameKey(scenario, baseTime, offsetMin, tempDelta);
  let p = cache.get(key);
  if (!p) {
    p = api
      .twin({ scenario, time: baseTime, offset_min: offsetMin, temp_delta: tempDelta })
      .then((t) => {
        const heat = b64ToBytes(t.grid.heat_b64);
        const shade = b64ToBytes(t.grid.shade_b64);
        return {
          ...t,
          key,
          heat,
          shade,
          heatUrl: renderHeat(heat, t.grid.cols, t.grid.rows),
          shadeUrl: renderShade(shade, t.grid.cols, t.grid.rows),
        };
      });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > 90) cache.delete(cache.keys().next().value!);
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
