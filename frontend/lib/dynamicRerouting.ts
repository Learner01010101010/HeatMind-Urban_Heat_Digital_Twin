"use client";

import { create } from "zustand";
import type { CompareResult, Route } from "./api";
import { useGeo } from "./geolocation";
import { alongRoute, cumulative, metresBetween, projectOnto, useNav } from "./navigation";
import { useMap } from "./store";

export interface UpdateSettings {
  available: boolean; check_seconds: number; continue_cooldown_seconds: number;
  time_saving_min: number; heat_improvement_percent: number;
}
export interface RouteUpdate {
  suggest: boolean; arrived: boolean; reason: string; blocked?: boolean;
  saving_min: number | null; heat_improvement_percent: number | null;
  conditions_signature?: string; comparison: CompareResult | null;
  prediction?: { source: string; ml_applied: boolean; training_source?: string };
}
interface Suggestion { result: RouteUpdate; trip: string; expires: number; source: "gps" | "preview" }
interface DynamicState {
  enabled: boolean; checking: boolean; accepting: boolean; pending: Suggestion | null;
  config: UpdateSettings | null; cooldownUntil: number; signature: string | null;
  trip: string | null; error: string | null;
  set: (patch: Partial<Omit<DynamicState, "set">>) => void;
}
export const useDynamicRerouting = create<DynamicState>()((set) => ({
  enabled: false, checking: false, accepting: false, pending: null, config: null,
  cooldownUntil: 0, signature: null, trip: null, error: null, set,
}));

let sequence = 0;
let controller: AbortController | null = null;
let lastFixAt = 0;
let realTripStartedAt = 0;
useGeo.subscribe((geo) => {
  if (geo.status === "inside") {
    lastFixAt = Date.now();
    if (useNav.getState().active) realTripStartedAt = useNav.getState().startedAt;
  }
});

function tripKey() {
  const nav = useNav.getState(), map = useMap.getState();
  return nav.active && map.compare && nav.routeId ? `${nav.startedAt}:${map.compare.compare_id}:${nav.routeId}` : null;
}

export function currentPosition(route: Route) {
  const nav = useNav.getState(), geo = useGeo.getState();
  if (!nav.forceSimulation && geo.status === "inside" && Date.now() - lastFixAt <= 30000
      && geo.accuracyM != null && geo.accuracyM <= 50 && Number.isFinite(geo.lat) && Number.isFinite(geo.lon)) {
    return { lat: geo.lat!, lon: geo.lon!, source: "gps" as const };
  }
  // Once real GPS drives this trip, losing it must not reroute from a fabricated fix.
  if (!nav.forceSimulation && (realTripStartedAt === nav.startedAt || geo.status !== "simulated")) return null;
  if (route.geometry.length < 2) return null;
  const cum = cumulative(route.geometry);
  if ((cum[cum.length - 1] ?? 0) - nav.progressM < 12) return null;
  const point = alongRoute(route.geometry, cum, nav.progressM).position;
  return { lat: point[0], lon: point[1], source: "preview" as const };
}

export function cancelDynamicCheck() {
  sequence++;
  controller?.abort();
  controller = null;
  useDynamicRerouting.getState().set({ checking: false, accepting: false });
}
export function toggleDynamicRerouting(enabled: boolean) {
  cancelDynamicCheck();
  useDynamicRerouting.getState().set({ enabled, pending: null, cooldownUntil: 0, signature: null, trip: null, error: null });
}
export function continueCurrentRoute() {
  const state = useDynamicRerouting.getState();
  // No route, map, geolocation or navigation state is written on decline.
  state.set({ pending: null, cooldownUntil: Date.now() + (state.config?.continue_cooldown_seconds ?? 300) * 1000 });
}

export async function checkDynamicRoute(accept = false) {
  let state = useDynamicRerouting.getState();
  const map = useMap.getState(), nav = useNav.getState();
  const trip = tripKey();
  const route = map.compare?.routes.find((r) => r.id === nav.routeId);
  if (!state.enabled || state.checking || state.accepting || !trip || !route || route.transit || map.loading) return;
  if (state.trip && state.trip !== trip) {
    state.set({ trip, signature: null, pending: null, cooldownUntil: 0, error: null });
    state = useDynamicRerouting.getState();
  }
  if (accept && (!state.pending || state.pending.trip !== trip || state.pending.expires <= Date.now())) {
    state.set({ pending: null, error: "That suggestion expired. Checking current conditions again." });
    return;
  }
  if (!accept && (state.cooldownUntil > Date.now() || (state.pending && state.pending.expires > Date.now()))) return;
  const position = currentPosition(route);
  if (!position) { state.set({ pending: null, error: "Route updates are waiting for a recent, accurate location." }); return; }
  const my = ++sequence;
  const requestController = new AbortController(); controller = requestController;
  const timeout = setTimeout(() => requestController.abort(), 25000);
  state.set({ checking: !accept, accepting: accept, error: null });
  try {
    let config = state.config;
    if (!config) {
      const response = await fetch("/api/routes/dynamic/settings", { signal: requestController.signal });
      if (!response.ok) throw new Error("Route updates unavailable");
      config = await response.json() as UpdateSettings;
      if (my !== sequence || tripKey() !== trip) return;
      state.set({ config });
    }
    if (!config.available) throw new Error("Route updates unavailable");
    const request = async (point: typeof position) => {
      const response = await fetch(`/api/routes/dynamic/${accept ? "accept" : "check"}`, {
        method: "POST", signal: requestController.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ compare_id: map.compare!.compare_id, route_id: route.id,
          position: { lat: point.lat, lon: point.lon }, ...(accept ? { consent: true } : {}) }),
      });
      if (!response.ok) throw new Error("Route updates unavailable");
      return await response.json() as RouteUpdate;
    };
    let result = await request(position);
    if (my !== sequence || tripKey() !== trip || !useDynamicRerouting.getState().enabled) return;
    if (accept) {
      let here = currentPosition(route);
      if (!here) throw new Error("Position became unavailable");
      if (metresBetween([here.lat, here.lon], [position.lat, position.lon]) > 75) result = await request(here);
      if (my !== sequence || tripKey() !== trip || !useDynamicRerouting.getState().enabled) return;
      here = currentPosition(route);
      const comparison = result.comparison;
      const next = comparison?.routes.find((r) => r.id === comparison.recommended_id);
      if (result.suggest && comparison && next && next.geometry.length >= 2
          && comparison.destination.lat === map.compare!.destination.lat && comparison.destination.lon === map.compare!.destination.lon) {
        if (!here || metresBetween([here.lat, here.lon], [comparison.origin.lat, comparison.origin.lon]) > 75) throw new Error("Position changed during planning");
        const progress = projectOnto(next.geometry, cumulative(next.geometry), [here.lat, here.lon]);
        if (progress.offM > 75) throw new Error("Position is off the proposed route");
        // This branch is reachable only through the explicit Reroute button.
        useMap.getState().set({ compare: comparison, anchorCompareId: comparison.compare_id,
          selectedRouteId: next.id, origin: { lat: comparison.origin.lat, lon: comparison.origin.lon,
            label: position.source === "gps" ? "Current location" : "Trip preview position" }, timeMin: 0 });
        useNav.getState().set({ routeId: next.id, progressM: progress.alongM, offRouteM: progress.offM, live: here.source === "gps" });
      }
      state.set({ pending: null, signature: null, trip: tripKey(), cooldownUntil: Date.now() + config.continue_cooldown_seconds * 1000 });
      return;
    }
    const changed = (state.trip === trip && state.signature !== null && state.signature !== result.conditions_signature) || result.blocked;
    state.set({ trip, signature: result.conditions_signature ?? null,
      pending: result.suggest && changed && !result.arrived
        ? { result, trip, expires: Date.now() + 90000, source: position.source } : null });
  } catch {
    if (my === sequence && tripKey() === trip) state.set({ error: "Could not check route updates. Your current guidance continues." });
  } finally {
    clearTimeout(timeout);
    if (my === sequence) { controller = null; state.set({ checking: false, accepting: false }); }
  }
}

/** Call only from a user confirmation event; periodic monitoring uses checkDynamicRoute(). */
export function acceptDynamicSuggestion() { return checkDynamicRoute(true); }
