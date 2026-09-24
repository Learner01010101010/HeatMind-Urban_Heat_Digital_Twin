"use client";

import { create } from "zustand";

/**
 * Where the user is, and whether the twin can say anything about it.
 *
 * The twin only models ~4 km² around the BSCOER campus, so "use my location" has a
 * real failure mode that is not an error: standing outside the zone. That is treated
 * as a first-class state (`outside`) rather than a rejected promise, because the
 * honest response is to say so and offer the campus, not to silently show nothing.
 *
 * A simulated walker is included for the same reason the demo needs one: geolocation
 * needs HTTPS and a granted permission, neither of which holds when the app is being
 * shown on a projector from a laptop that is nowhere near Narhe.
 */

export type GeoStatus =
  | "idle"
  | "locating"
  | "inside" // fix acquired, inside the modelled zone
  | "outside" // fix acquired, but outside the zone the twin covers
  | "denied"
  | "unavailable"
  | "simulated";

export interface GeoState {
  status: GeoStatus;
  lat: number | null;
  lon: number | null;
  accuracyM: number | null;
  headingDeg: number | null;
  /** Metres moved since the last fix that was painted into the reveal field. */
  movedM: number;
  error: string | null;
  set: (p: Partial<GeoState>) => void;
}

export const useGeo = create<GeoState>()((set) => ({
  status: "idle",
  lat: null,
  lon: null,
  accuracyM: null,
  headingDeg: null,
  movedM: 0,
  error: null,
  set: (p) => set(p),
}));

function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

let watchId: number | null = null;
let simTimer: ReturnType<typeof setInterval> | null = null;

function inside(bbox: [number, number, number, number], lat: number, lon: number): boolean {
  const [s, w, n, e] = bbox;
  return lat >= s && lat <= n && lon >= w && lon <= e;
}

/** Begin following the device position. Safe to call repeatedly. */
export function startWatch(bbox: [number, number, number, number]) {
  stopSimulation();
  if (watchId !== null) return;
  const g = useGeo.getState();

  if (typeof navigator === "undefined" || !navigator.geolocation) {
    g.set({ status: "unavailable", error: "This browser exposes no geolocation API." });
    return;
  }
  g.set({ status: "locating", error: null });

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy, heading } = pos.coords;
      const prev = useGeo.getState();
      const moved =
        prev.lat !== null && prev.lon !== null
          ? haversineM(prev.lat, prev.lon, latitude, longitude)
          : Infinity;
      useGeo.getState().set({
        status: inside(bbox, latitude, longitude) ? "inside" : "outside",
        lat: latitude,
        lon: longitude,
        accuracyM: accuracy ?? null,
        headingDeg: heading ?? null,
        movedM: moved,
        error: null,
      });
    },
    (err) => {
      useGeo.getState().set({
        status: err.code === err.PERMISSION_DENIED ? "denied" : "unavailable",
        error:
          err.code === err.PERMISSION_DENIED
            ? "Location permission was declined."
            : err.message || "Could not get a position fix.",
      });
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
}

export function stopWatch() {
  if (watchId !== null && typeof navigator !== "undefined") {
    navigator.geolocation.clearWatch(watchId);
  }
  watchId = null;
}

/**
 * Walk a simulated pedestrian through the zone at ~1.4 m/s.
 *
 * This is the demo path and the only way to exercise progressive reveal away from
 * Narhe. It is always labelled `simulated` in the UI — it never pretends to be a fix.
 */
export function startSimulation(startLat: number, startLon: number, headingDeg = 65) {
  stopWatch();
  stopSimulation();
  let lat = startLat;
  let lon = startLon;
  let heading = headingDeg;
  useGeo.getState().set({
    status: "simulated",
    lat,
    lon,
    accuracyM: 5,
    headingDeg: heading,
    movedM: Infinity,
    error: null,
  });

  const STEP_S = 1.0;
  const SPEED_MS = 1.4; // comfortable walking pace
  simTimer = setInterval(() => {
    // gentle wander so the path is not a dead straight line
    heading += (Math.random() - 0.5) * 12;
    const d = SPEED_MS * STEP_S;
    const dLat = (d * Math.cos((heading * Math.PI) / 180)) / 110540;
    const dLon = (d * Math.sin((heading * Math.PI) / 180)) / (111320 * Math.cos((lat * Math.PI) / 180));
    lat += dLat;
    lon += dLon;
    useGeo.getState().set({ lat, lon, headingDeg: heading, movedM: d });
  }, STEP_S * 1000);
}

export function stopSimulation() {
  if (simTimer) clearInterval(simTimer);
  simTimer = null;
}

export function isSimulating() {
  return simTimer !== null;
}
