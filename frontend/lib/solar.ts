"use client";

/**
 * NOAA General Solar Position — a direct port of backend/app/services/solar.py.
 *
 * The backend returns sun elevation and azimuth per *keyframe* (15-minute steps).
 * Scrubbing the timeline between keyframes would therefore snap the shadows from
 * one quarter hour to the next. Because the algorithm is deterministic, closed-form
 * and dependency-free, evaluating it on the client at the exact scrub time gives
 * continuously moving shadows at zero backend cost, while the heat field itself
 * stays backed by real backend frames.
 *
 * Kept numerically identical to the Python so the two never disagree: any drift
 * here would show up as the rendered shadow leaving the modelled one behind.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function dayOfYearUTC(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000) + 1;
}

export interface SolarPosition {
  elevationDeg: number;
  azimuthDeg: number;
}

export function solarPosition(when: Date, lat: number, lon: number): SolarPosition {
  const doy = dayOfYearUTC(when);
  const hour = when.getUTCHours() + when.getUTCMinutes() / 60 + when.getUTCSeconds() / 3600;
  const g = ((2 * Math.PI) / 365) * (doy - 1 + (hour - 12) / 24);

  const eqtime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g));

  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);

  const tst = hour * 60 + eqtime + 4 * lon;
  const ha = (tst / 4 - 180) * RAD;
  const phi = lat * RAD;

  let cosZen = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  cosZen = Math.max(-1, Math.min(1, cosZen));
  let elev = 90 - Math.acos(cosZen) * DEG;

  let az =
    Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) * DEG + 180;
  az = ((az % 360) + 360) % 360;

  // atmospheric refraction near the horizon
  if (elev > -0.575 && elev < 85) {
    elev += 1.02 / Math.tan((elev + 10.3 / (elev + 5.11)) * RAD) / 60;
  }
  return { elevationDeg: elev, azimuthDeg: az };
}

/**
 * Clear-sky beam intensity, matching heat_twin_service._compute:
 *   clearness = 1 - 0.75 * (cloud/100)^3.4
 *   intensity = clearness * max(0, sin(elev))^1.15
 */
export function solarIntensity(elevationDeg: number, cloudPct: number): number {
  if (elevationDeg <= 0) return 0;
  const clearness = 1 - 0.75 * Math.pow(cloudPct / 100, 3.4);
  return clearness * Math.pow(Math.max(0, Math.sin(elevationDeg * RAD)), 1.15);
}
