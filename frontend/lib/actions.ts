"use client";

import { api, ApiError, type InterventionKind, type InterventionResult, type TravelMode } from "./api";
import { SCENARIO, TIMELINE, useClock, useMap, usePrefs, type Endpoint } from "./store";

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
    const r = await api.compare({ origin: m.origin, destination: m.destination, persona: p.persona, mode: p.mode, scenario: SCENARIO, depart_at: base });
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

/**
 * Switch travel mode and re-plan.
 *
 * The whole comparison is recomputed rather than rescaled: a different mode is a
 * different set of usable streets, not the same route at a different speed. A car
 * cannot take the campus footpath the walking route went down, so its geometry,
 * its time and its heat exposure all change together.
 */
export function setMode(mode: TravelMode) {
  if (usePrefs.getState().mode === mode) return;
  usePrefs.getState().set({ mode });
  const m = useMap.getState();
  if (m.origin && m.destination) void runCompare();
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

/** SDG 13/15 Intervention Simulator — "what if we fixed this street?" */
export async function runIntervention(lat: number, lon: number, kind: InterventionKind): Promise<InterventionResult | null> {
  const m = useMap.getState();
  const base = useClock.getState().base;
  const offset = m.simOffsetMin + TIMELINE[Math.min(TIMELINE.length - 1, Math.round(m.timeMin / 15))];
  m.set({ interventionBusy: true });
  try {
    const r = await api.intervene({ lat, lon, kind, scenario: SCENARIO, time: base, offset_min: offset, temp_delta: m.tempDelta });
    useMap.getState().set({ interventionResults: [...useMap.getState().interventionResults, r], interventionBusy: false });
    return r;
  } catch (e) {
    useMap.getState().set({ interventionBusy: false, error: e instanceof ApiError ? e.message : "Could not simulate that intervention here." });
    return null;
  }
}

export function clearInterventions() {
  useMap.getState().set({ interventionResults: [], pickMode: null });
}

export function resetSimulation() {
  const m = useMap.getState();
  m.set({ simOffsetMin: 0, tempDelta: 0 });
  if (m.origin && m.destination) void runCompare();
}
