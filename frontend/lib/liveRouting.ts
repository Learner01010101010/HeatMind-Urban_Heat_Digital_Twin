"use client";

import { ApiError } from "./api";
import { useGeo } from "./geolocation";
import { metresBetween, useNav } from "./navigation";
import { useMap, usePrefs } from "./store";
import { remainingOrigin, sameTrip, type PositionFix } from "./liveRoutingRules";
import { useRouteEngine, type LiveRecheckResult, type PendingRouteChange } from "./routeEngineState";

let latestFix: PositionFix | null = null;
let controller: AbortController | null = null;
let sequence = 0;
let lastAttempt = 0;

export function capturePosition() {
  const fix = useGeo.getState();
  if (fix.status === "inside" && fix.lat != null && fix.lon != null && fix.accuracyM != null) {
    latestFix = { lat: fix.lat, lon: fix.lon, accuracy: fix.accuracyM, at: Date.now() };
  } else if (["outside", "denied", "unavailable", "idle"].includes(fix.status)) latestFix = null;
}

export function cancelLiveCheck() {
  sequence++;
  controller?.abort();
  controller = null;
  useRouteEngine.getState().set({ checking: false, pending: null });
}

function updateGuidance(change: PendingRouteChange, switchRoute: boolean) {
  const m = useMap.getState(), nav = useNav.getState();
  const currentId = nav.active ? nav.routeId : m.selectedRouteId;
  if (!sameTrip(change.compareId, change.routeId, m.compare?.compare_id, currentId) || change.navigating !== nav.active) return;
  const result = change.response.comparison;
  if (!result) return;
  const targetId = switchRoute ? result.recommended_id : result.routes.find((r) => r.tags.includes("current"))?.id;
  if (!targetId) return;
  m.set({ compare: result, anchorCompareId: result.compare_id, selectedRouteId: targetId,
    timeMin: 0, simOffsetMin: 0, tempDelta: result.temp_delta_c,
    ...(nav.active ? { origin: { ...result.origin, label: change.source === "gps" ? "Current position" : "Preview position" } } : {}) });
  if (nav.active) nav.set({ routeId: targetId, progressM: 0, offRouteM: 0, live: change.source === "gps" });
  const engine = useRouteEngine.getState();
  engine.set({ pending: null, ...(switchRoute ? { switches: engine.switches + 1, message: `Rerouted: ${change.response.message}` } : {}) });
}

export function applyRouteChange(change: PendingRouteChange) { updateGuidance(change, true); }

export async function checkLiveRoute(reason: "timer" | "off_route" | "temperature" | "manual" = "timer") {
  const m = useMap.getState(), nav = useNav.getState(), engine = useRouteEngine.getState();
  if (engine.checking || m.loading || !m.compare || (!engine.enabled && reason !== "manual")) return;
  if (!nav.active && reason !== "manual" && reason !== "temperature") return;
  const id = nav.active ? nav.routeId : m.selectedRouteId;
  const route = m.compare.routes.find((r) => r.id === id);
  if (!route || route.transit) return;
  if (reason === "off_route" && Date.now() - lastAttempt < 10_000) return;
  const position = nav.active ? remainingOrigin(route, nav.progressM, nav.forceSimulation ? null : latestFix, Date.now()) : null;
  if (reason === "off_route" && !position?.off_route) return;
  const source = position?.source ?? "planned";
  const compareId = m.compare.compare_id;
  const navigating = nav.active;
  const objective = m.compare.route_engine?.objective ?? engine.objective;
  // A demo spike is explicit. Regular live checks use the actual weather model.
  const delta = engine.demoHeatDelta || (navigating ? 0 : m.tempDelta);
  const my = ++sequence;
  const requestController = new AbortController();
  controller = requestController;
  const timeout = setTimeout(() => requestController.abort(), 60_000);
  lastAttempt = Date.now();
  engine.set({ checking: true, error: null, pending: null, source });
  try {
    const res = await fetch("/api/routes/recheck", { method: "POST", signal: requestController.signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ compare_id: compareId,
        route_id: route.id, objective, ...(position ? { position: { lat: position.lat, lon: position.lon }, off_route: position.off_route } : {}),
        temp_delta_c: delta }) });
    if (!res.ok) throw new ApiError(res.status, "Live check unavailable; keeping your current route.");
    const response = await res.json() as LiveRecheckResult;
    if (my !== sequence) return;
    const current = useMap.getState(), currentNav = useNav.getState();
    if (current.loading || !sameTrip(compareId, route.id, current.compare?.compare_id, currentNav.active ? currentNav.routeId : current.selectedRouteId)
        || navigating !== currentNav.active || usePrefs.getState().persona !== m.compare.persona) return;
    if (position && currentNav.active) {
      const here = remainingOrigin(route, currentNav.progressM, currentNav.forceSimulation ? null : latestFix, Date.now());
      if (metresBetween([position.lat, position.lon], [here.lat, here.lon]) > 100) return;
    }
    const change: PendingRouteChange = { response, compareId, routeId: route.id, navigating, source };
    engine.set({ lastChecked: response.checked_at, message: response.message, changes: response.changes,
      pending: response.should_switch ? change : null });
    if (response.should_switch && useRouteEngine.getState().enabled && navigating) applyRouteChange(change);
    else if (navigating && !response.should_switch) updateGuidance(change, false);
    else if (!navigating && response.comparison) {
      // Planning refresh: maintain the actual pinned route rather than its letter.
      const result = response.comparison;
      current.set({ compare: result, anchorCompareId: result.compare_id,
        selectedRouteId: result.routes.find((r) => r.tags.includes("current"))?.id ?? result.recommended_id });
      engine.set({ pending: null });
    }
  } catch (error) {
    if (my === sequence) engine.set({ error: error instanceof ApiError ? error.message : "Could not check conditions. Current guidance continues; retrying at the next check." });
  } finally {
    clearTimeout(timeout);
    if (my === sequence) { controller = null; engine.set({ checking: false }); }
  }
}
