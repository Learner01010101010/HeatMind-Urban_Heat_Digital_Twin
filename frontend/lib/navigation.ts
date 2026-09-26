"use client";

import { create } from "zustand";
import type { Route, RouteStep } from "./api";
import { stopSimulation, stopWatch, useGeo } from "./geolocation";

/**
 * Guided navigation along a chosen route.
 *
 * Position comes from a real fix when there is one on the route, and from a paced
 * preview when there is not. The preview is not a gimmick: geolocation needs HTTPS
 * and a granted permission, and the product is routinely shown on a laptop nowhere
 * near Narhe — the same reason `geolocation.ts` already carries a simulated walker.
 * Which source is live is always stated in the HUD rather than implied.
 *
 * Progress is held as one number — metres travelled along the route — because every
 * question navigation asks reduces to it: which step you are on, how far to the next
 * turn, what is left, when you arrive, and where the camera should look.
 */

export interface NavState {
  active: boolean;
  routeId: string | null;
  /** Metres travelled along the route polyline. */
  progressM: number;
  /** True when a real position fix is driving progress. */
  live: boolean;
  /** Wall-clock ms at which navigation started, for elapsed time. */
  startedAt: number;
  /** Set when the user has been carried off the planned line. */
  offRouteM: number;
  /**
   * Playback rate for the simulated walk, when no real fix is driving progress.
   *
   * Real time is right for someone actually walking and useless for showing the
   * thing to a room: a 50-minute route takes 50 minutes to watch. This multiplies
   * only the simulated advance, never a real position, so the demo runs at 8x
   * while a real trip still moves at the speed the body is moving.
   */
  simSpeed: number;
  paused: boolean;
  forceSimulation: boolean;
  set: (p: Partial<Omit<NavState, "set">>) => void;
}

export const useNav = create<NavState>()((set) => ({
  active: false,
  routeId: null,
  progressM: 0,
  live: false,
  startedAt: 0,
  offRouteM: 0,
  simSpeed: 1,
  paused: false,
  forceSimulation: false,
  set: (p) => set(p),
}));

const R = 6371000;
const RAD = Math.PI / 180;

export function metresBetween(a: [number, number], b: [number, number]): number {
  const dLat = (b[0] - a[0]) * RAD;
  const dLon = (b[1] - a[1]) * RAD;
  const la1 = a[0] * RAD;
  const la2 = b[0] * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Bearing a→b, degrees clockwise from north. Mirrors backend navigation.bearing_deg. */
export function bearingDeg(a: [number, number], b: [number, number]): number {
  const lat1 = a[0] * RAD;
  const lat2 = b[0] * RAD;
  const dLon = (b[1] - a[1]) * RAD;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Cumulative distance at each vertex of a route polyline. */
export function cumulative(geometry: [number, number][]): number[] {
  const out = [0];
  for (let i = 1; i < geometry.length; i++) {
    out.push(out[i - 1] + metresBetween(geometry[i - 1], geometry[i]));
  }
  return out;
}

export interface Along {
  position: [number, number];
  bearing: number;
}

/** Interpolate a position and heading at `metres` along the polyline. */
export function alongRoute(geometry: [number, number][], cum: number[], metres: number): Along {
  if (geometry.length === 0) return { position: [0, 0], bearing: 0 };
  if (geometry.length === 1) return { position: geometry[0], bearing: 0 };
  const total = cum[cum.length - 1];
  const d = Math.max(0, Math.min(total, metres));

  // Long city routes can have thousands of vertices; the camera reads this every
  // frame. Binary search avoids scanning the travelled route again each time.
  let low = 1;
  let high = cum.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cum[middle] < d) low = middle + 1;
    else high = middle;
  }
  const i = low;
  const span = cum[i] - cum[i - 1];
  const t = span > 1e-6 ? (d - cum[i - 1]) / span : 0;
  const a = geometry[i - 1];
  const b = geometry[i];
  return {
    // Linear in lat/lon: over an 8 m graph piece the great-circle correction is far
    // below the precision of the underlying OSM geometry.
    position: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    bearing: bearingDeg(a, b),
  };
}

/**
 * Project a fix onto the route: how far along it is, and how far off it.
 *
 * `offM` is what decides whether a fix is trusted. A GPS point 200 m from the line
 * is not progress, it is someone who has left the route (or a bad fix in an urban
 * canyon, which south Pune's taller corridors produce plenty of), and snapping to
 * the nearest point would teleport the camera up the street.
 */
export function projectOnto(
  geometry: [number, number][],
  cum: number[],
  fix: [number, number],
): { alongM: number; offM: number } {
  let best = { alongM: 0, offM: Infinity };
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1];
    const b = geometry[i];
    // Work in local metres: latitude degrees are constant, longitude degrees shrink
    // with cos(lat), and ignoring that skews the projection by ~5% at this latitude.
    const kx = Math.cos(a[0] * RAD);
    const ax = 0;
    const ay = 0;
    const bx = (b[1] - a[1]) * kx;
    const by = b[0] - a[0];
    const px = (fix[1] - a[1]) * kx;
    const py = fix[0] - a[0];
    const len2 = bx * bx + by * by;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
    const cxv = ax + bx * t;
    const cyv = ay + by * t;
    const off = Math.hypot(px - cxv, py - cyv) * 111_320;
    if (off < best.offM) {
      best = { alongM: cum[i - 1] + (cum[i] - cum[i - 1]) * t, offM: off };
    }
  }
  return best;
}

/**
 * Rescale a distance measured along the route polyline onto the step scale.
 *
 * The two are not quite the same ruler. `steps[].start_m` accumulate the router's
 * 8 m piece lengths, computed in the backend's local metric projection, while
 * progress here is haversine over the graph's node polyline — about 0.3% longer on a
 * 7 km route. Left uncorrected the difference is silent but real: every instruction
 * fires ~25 m early by the end, which is the difference between "turn now" and
 * having already passed the turn.
 */
export function toStepScale(progressM: number, polylineTotalM: number, routeDistanceM: number): number {
  if (polylineTotalM <= 0) return progressM;
  return progressM * (routeDistanceM / polylineTotalM);
}

/** Which step contains `metres`, and how far remains to its end. */
export function stepAt(steps: RouteStep[], metres: number): { step: RouteStep; index: number; toEndM: number } | null {
  if (!steps.length) return null;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (metres >= steps[i].start_m || i === 0) {
      const end = steps[i].start_m + steps[i].distance_m;
      return { step: steps[i], index: i, toEndM: Math.max(0, end - metres) };
    }
  }
  return null;
}

/** A fix is treated as on-route within this many metres; beyond it the preview drives. */
export const ON_ROUTE_M = 45;

/** Begin guidance on a route. */
export function startNavigation(route: Route, opts: { simulate?: boolean } = {}) {
  if (route.geometry.length < 2) return;
  stopSimulation();
  if (opts.simulate) stopWatch();
  useNav.getState().set({
    active: true,
    routeId: route.id,
    progressM: 0,
    startedAt: Date.now(),
    offRouteM: 0,
    live: false,
    paused: false,
    forceSimulation: !!opts.simulate,
    simSpeed: opts.simulate ? 4 : 1,
  });
  if (opts.simulate) {
    const [lat, lon] = route.geometry[0];
    useGeo.getState().set({ status: "simulated", lat, lon, headingDeg: bearingDeg(route.geometry[0], route.geometry[1]), error: null });
  }
}

export function stopNavigation() {
  useNav.getState().set({ active: false, routeId: null, progressM: 0, live: false, offRouteM: 0, paused: false, forceSimulation: false });
  // Hand the position back. The simulation borrowed the geolocation store to move
  // the dot; leaving a fabricated fix behind it would have the rest of the app
  // believing the user is standing wherever the demo happened to stop.
  const g = useGeo.getState();
  if (g.status === "simulated") g.set({ status: "idle", lat: null, lon: null, headingDeg: null });
}

/**
 * Advance progress by one animation frame.
 *
 * Returns the metres to use. A real fix wins whenever it is on the line; otherwise
 * the preview walks forward at the route's own pace, so the guidance runs at the
 * speed the route was actually costed at rather than an arbitrary demo speed.
 */
export function advance(route: Route, geometry: [number, number][], cum: number[], dtSeconds: number): number {
  const nav = useNav.getState();
  const geo = useGeo.getState();
  const total = cum[cum.length - 1] ?? 0;
  if (!nav.active || nav.paused || geometry.length < 2) return nav.progressM;

  // A fix this function wrote itself is not evidence of anything. Without this the
  // simulation would feed its own position back in, project it onto the line it came
  // from, and the HUD would report a live GPS lock that does not exist.
  if (!nav.forceSimulation && geo.lat != null && geo.lon != null && geo.status === "inside") {
    const { alongM, offM } = projectOnto(geometry, cum, [geo.lat, geo.lon]);
    if (offM <= ON_ROUTE_M) {
      nav.set({ live: true, offRouteM: offM, progressM: alongM });
      return alongM;
    }
    // Keep the distance so the HUD can say how far off the line they are.
    if (nav.live) nav.set({ live: false, offRouteM: offM });
    else if (nav.offRouteM !== offM) nav.set({ offRouteM: offM });
  }

  // The mode's own speed, as the router costed it: 4.9 km/h on foot, 27 on a
  // two-wheeler, 24.8 in a car through modelled congestion.
  const speedMs = ((route.speed_kmh ?? 5) * 1000) / 3600;
  const next = Math.min(total, nav.progressM + speedMs * (nav.simSpeed || 1) * Math.max(0, dtSeconds));
  if (next === nav.progressM) return next;
  nav.set({ progressM: next, live: false });

  // Move the position with it. The blue dot, the chase camera and the corridor
  // reveal all read the geolocation store, so writing the simulated point here is
  // what makes the whole app behave as though the trip is really under way —
  // rather than a progress bar advancing next to a stationary dot.
  const here = alongRoute(geometry, cum, next);
  useGeo.getState().set({
    status: "simulated",
    lat: here.position[0],
    lon: here.position[1],
    headingDeg: here.bearing,
    accuracyM: 8,
  });
  return next;
}
