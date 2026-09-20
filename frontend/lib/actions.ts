"use client";

import { api, ApiError } from "./api";
import { SCENARIO, useClock, useMap, usePrefs, type Endpoint } from "./store";

let seq = 0;

/**
 * Compare routes for the current origin/destination/persona, anchored to the live clock.
 * `silent` re-baselines an existing trip (keeps the timeline position and selected route slot).
 */
export async function runCompare(opts: { silent?: boolean } = {}) {
  const m = useMap.getState();
  const p = usePrefs.getState();
  if (!m.origin || !m.destination) return;
  const my = ++seq;
  if (!opts.silent) m.set({ loading: true, error: null });
  try {
    const base = useClock.getState().base;
    // A fresh comparison always starts from real (un-simulated) conditions at the live time.
    const r = await api.compare({ origin: m.origin, destination: m.destination, persona: p.persona, scenario: SCENARIO, depart_at: base });
    if (my !== seq) return;
    const cur = useMap.getState();
    const prevLabel = cur.compare?.routes.find((x) => x.id === cur.selectedRouteId)?.label;
    const keep = opts.silent && prevLabel ? r.routes.find((x) => x.label === prevLabel)?.id : undefined;
    cur.set({
      compare: r,
      anchorCompareId: r.compare_id,
      simOffsetMin: 0,
      tempDelta: 0,
      selectedRouteId: keep ?? r.recommended_id,
      loading: false,
      ...(opts.silent ? {} : { timeMin: 0, routeView: "list" as const, sheetOpen: typeof window === "undefined" || window.innerWidth >= 768 }),
    });
  } catch (e) {
    if (my !== seq) return;
    useMap.getState().set({ loading: false, error: e instanceof ApiError ? e.message : "Could not reach the HeatMind engine. Is the backend running on :8000?" });
  }
}

export async function runSimulate(timeOffsetMin: number, tempDelta: number) {
  const m = useMap.getState();
  m.set({ simOffsetMin: timeOffsetMin, tempDelta, timeMin: 0 });
  if (!m.compare) return null;
  m.set({ loading: true, error: null });
  try {
    const r = await api.simulate({
      compare_id: m.anchorCompareId ?? m.compare.compare_id,
      route_id: m.selectedRouteId ?? undefined,
      simulate: { time_offset_min: timeOffsetMin, temp_delta_c: tempDelta },
    });
    // Keep the originally-planned trip as the anchor for further simulations
    useMap.getState().set({ compare: r, loading: false, selectedRouteId: r.simulation?.reroute?.current_route_id ?? r.recommended_id });
    return r;
  } catch (e) {
    useMap.getState().set({ loading: false, error: e instanceof ApiError ? e.message : "Simulation failed" });
    return null;
  }
}

export function setEndpoint(which: "origin" | "destination", ep: Endpoint | null) {
  const m = useMap.getState();
  m.set({ [which]: ep, pickMode: null } as Partial<ReturnType<typeof useMap.getState>>);
  const s = useMap.getState();
  if (s.origin && s.destination) void runCompare();
}

export function clearTrip() {
  useMap.getState().set({
    origin: null,
    destination: null,
    compare: null,
    anchorCompareId: null,
    selectedRouteId: null,
    routeView: "list",
    pickMode: null,
    error: null,
    timeMin: 0,
  });
}

export function resetSimulation() {
  const m = useMap.getState();
  m.set({ simOffsetMin: 0, tempDelta: 0 });
  if (m.origin && m.destination) void runCompare();
}
