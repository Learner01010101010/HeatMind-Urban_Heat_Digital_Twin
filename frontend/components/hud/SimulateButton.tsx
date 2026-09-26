"use client";

import { Loader2, Navigation, RotateCcw, TrafficCone, X, Zap } from "lucide-react";
import { useState } from "react";
import { resetSimulation, runSimulate } from "@/lib/actions";
import { stopSimulation, stopWatch, useGeo } from "@/lib/geolocation";
import { fmtDelta } from "@/lib/heatColorScale";
import { checkLiveRoute } from "@/lib/liveRouting";
import { startNavigation, stopNavigation, useNav } from "@/lib/navigation";
import { useRouteEngine } from "@/lib/routeEngineState";
import { useMap, usePrefs } from "@/lib/store";

const PRESETS = [
  { label: "Heat advisory", delta: 5 },
  { label: "Extreme day", delta: 8 },
  { label: "Cool change", delta: -3 },
];

// SDG 13 — same temp_delta mechanism as the weather presets above, but framed as
// long-run climate scenarios rather than a short-term advisory.
const CLIMATE_PRESETS = [
  { label: "+1.5°C", sub: "Paris Agreement target", delta: 1.5 },
  { label: "+2°C", sub: "Likely by ~2050", delta: 2 },
  { label: "+3°C", sub: "Current-policy pathway", delta: 3 },
];

/** Small floating ⚡ Simulate control — spikes the temperature and re-scores everything live. */
export default function SimulateButton({ compact = false }: { compact?: boolean }) {
  const delta = useMap((s) => s.tempDelta);
  const loading = useMap((s) => s.loading);
  const hasTrip = useMap((s) => !!s.compare);
  const units = usePrefs((s) => s.units);
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(delta);
  const active = delta !== 0;

  // ── the planned-trip run, moved here from the location control ──
  // It is a simulation of being on the route, so it belongs with the other
  // simulations rather than behind a button about where you actually are.
  const set = useMap((s) => s.set);
  const compare = useMap((s) => s.compare);
  const selectedRouteId = useMap((s) => s.selectedRouteId);
  const mode = useMap((s) => s.mode);
  const geoStatus = useGeo((s) => s.status);
  const navActive = useNav((s) => s.active);
  const navRouteId = useNav((s) => s.routeId);
  const progressM = useNav((s) => Math.floor(s.progressM));
  const simSpeed = useNav((s) => s.simSpeed);

  const route = compare?.routes.find((r) => r.id === selectedRouteId) ?? compare?.routes[0] ?? null;
  const navRoute = compare?.routes.find((r) => r.id === navRouteId) ?? null;
  const tripRunning = navActive && !!navRoute;
  /** Anything fabricating a position, whatever started it. */
  const simRunning = tripRunning || geoStatus === "simulated";
  const tripPct = tripRunning && navRoute.distance_m > 0
    ? Math.min(100, (progressM / navRoute.distance_m) * 100)
    : 0;

  const runTrip = () => {
    if (!route) return;
    set({ revealOn: true, selectedRouteId: route.id });
    startNavigation(route, { simulate: true });
    setOpen(false);
  };

  /** One stop for every fabricated position; hands the real one back. */
  const stopAll = () => {
    stopNavigation();
    stopWatch();
    stopSimulation();
    useGeo.getState().set({ status: "idle", lat: null, lon: null, headingDeg: null, accuracyM: null });
  };

  // ── simulated jam ──
  const engine = useRouteEngine();

  /**
   * Drop a jam on the road ahead and let the live engine answer it.
   *
   * The backend places it on the remaining route, so it is unmistakably in the
   * way, and every downstream consumer — travel time, the congestion penalty,
   * candidate generation, the traffic factor — sees it as it would a real
   * reading. Nothing here decides the new route.
   */
  /**
   * Vehicle flow does not slow a pedestrian, and the model says so: walking has a
   * congestion sensitivity of zero, cycling 0.15, against 0.45 for a two-wheeler
   * and 0.75 for a car. On foot a jam can only change exposure, never arrival
   * time, so the demo has to say that rather than imply a speed saving.
   */
  const jamMode = compare?.mode ?? "walk";
  const jamCostsTime = jamMode !== "walk";

  const jamAhead = () => {
    useRouteEngine.getState().set({ demoJam: true });
    void checkLiveRoute("jam");
  };
  const clearJam = () => {
    useRouteEngine.getState().set({ demoJam: false, jam: null, axes: null });
    void checkLiveRoute("jam");
  };

  const apply = async (v: number) => {
    setD(v);
    await runSimulate(0, v);
    setOpen(false);
  };

  return (
    <div className="relative">
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className={`glass-strong z-20 rounded-[26px] p-4 pop-in ${compact ? "fixed top-[72px] right-[76px] w-[min(290px,calc(100vw-100px))] max-h-[calc(100dvh-140px)] overflow-y-auto" : "absolute right-0 bottom-full mb-3 w-[290px]"}`} role="dialog" aria-label="Simulate conditions">
            <div className="flex items-baseline justify-between mb-1">
              <div className="text-[15px] font-semibold text-ink-100 tracking-tight">What if it gets hotter?</div>
              <div className="text-[22px] font-semibold tabular tracking-tight" style={{ color: d > 0 ? "#fb8a1f" : d < 0 ? "#9dc06a" : "#f3f3f2" }}>
                {fmtDelta(d, units, 0)}
              </div>
            </div>
            <p className="text-[12px] text-ink-400 mb-3 leading-snug">{hasTrip ? "Routes re-score instantly. You'll get a reroute if a safer path appears." : "The twin repaints instantly. Plan a trip to see live rerouting."}</p>
            <input type="range" className="hm-mini w-full" min={-4} max={10} step={0.5} value={d} onChange={(e) => setD(Number(e.target.value))} aria-label="Temperature change" />
            <div className="flex gap-1.5 mt-4">
              {PRESETS.map((p) => (
                <button key={p.label} onClick={() => apply(p.delta)} className="press flex-1 rounded-2xl bg-white/[0.05] hover:bg-white/[0.1] px-2 py-2 text-center">
                  <div className="text-[13px] font-semibold tabular" style={{ color: p.delta > 0 ? "#fb8a1f" : "#9dc06a" }}>
                    {fmtDelta(p.delta, units, 0)}
                  </div>
                  <div className="text-[10.5px] text-ink-400 leading-tight">{p.label}</div>
                </button>
              ))}
            </div>
            <div className="mt-4 pt-3 border-t border-white/10">
              <div className="text-[10.5px] font-bold uppercase tracking-wider text-emerald-400 mb-1.5">Climate scenario · SDG 13</div>
              <p className="text-[11px] text-ink-400 mb-2 leading-snug">Same twin, warmed by an IPCC-style pathway instead of a one-off weather event.</p>
              <div className="flex gap-1.5">
                {CLIMATE_PRESETS.map((p) => (
                  <button key={p.label} onClick={() => apply(p.delta)} className="press flex-1 rounded-2xl bg-emerald-400/[0.08] hover:bg-emerald-400/[0.15] px-2 py-2 text-center">
                    <div className="text-[13px] font-semibold tabular text-emerald-300">{p.label}</div>
                    <div className="text-[9.5px] text-ink-400 leading-tight">{p.sub}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* ── run the planned trip ──
                While something is already driving the position the only useful
                question is how to stop it, so the way to start is replaced by the
                way out rather than sitting next to it greyed out. */}
            <div className="mt-4 pt-3 border-t border-white/10">
              <div className="text-[10.5px] font-bold uppercase tracking-wider text-cool-300 mb-1.5">
                {simRunning ? (tripRunning ? "Running the trip" : "Simulated walk") : "Trip playback"}
              </div>

              {simRunning ? (
                <>
                  <p className="text-[11px] text-ink-400 mb-2 leading-snug">
                    {tripRunning
                      ? `Moving along ${navRoute.label} at ${navRoute.speed_kmh ?? "—"} km/h${simSpeed > 1 ? ` · ${simSpeed}× playback` : ""}. This is a simulated position, not a fix.`
                      : "A simulated pedestrian is walking the campus. This is not a real position."}
                  </p>

                  {tripRunning && (
                    <div className="mb-2.5">
                      <div className="h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
                        <div
                          className="h-full rounded-full transition-[width] duration-300"
                          style={{ width: `${tripPct}%`, background: navRoute.color }}
                        />
                      </div>
                      <div className="flex justify-between text-[10.5px] text-ink-400 mt-1 tabular">
                        <span>{(progressM / 1000).toFixed(2)} km</span>
                        <span>
                          {tripPct >= 99.5
                            ? "arrived"
                            : `${Math.max(0, (navRoute.distance_m - progressM) / 1000).toFixed(2)} km to go`}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* ── traffic jam ── */}
                  <div className="mb-2.5 rounded-2xl bg-white/[0.04] p-2.5">
                    <button
                      onClick={engine.demoJam ? clearJam : jamAhead}
                      disabled={engine.checking}
                      className="press flex items-center gap-2 w-full text-left text-[12.5px] font-semibold text-ink-100 disabled:opacity-50"
                    >
                      <TrafficCone size={15} className={engine.demoJam ? "text-heat-4" : "text-cool-400"} />
                      {engine.checking ? "Rerouting…" : engine.demoJam ? "Clear the jam" : "Simulate a traffic jam ahead"}
                    </button>
                    <p className="text-[10.5px] text-ink-400 leading-tight mt-1">
                      {engine.demoJam
                        ? `Jam on the road ahead at ${engine.jam ? `${engine.jam.speed_kmh} km/h over ${engine.jam.radius_m} m` : "walking pace"}. Simulated, never reported as a reading.`
                        : "Puts a crawling jam on the road ahead and reroutes from where you are now."}
                    </p>
                    {!jamCostsTime && (
                      <p className="text-[10px] text-[#ffc48a] leading-tight mt-1">
                        On foot, traffic does not slow you — the model gives walking zero congestion
                        sensitivity. Switch to two-wheeler or car for a jam that costs time.
                      </p>
                    )}
                    {engine.demoJam && engine.axes && (
                      <div className="mt-2 pt-2 border-t border-white/10">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-ink-400 mb-1.5">
                          New route vs old
                        </div>
                        <ul className="space-y-1">
                          {engine.axes.map((a) => (
                            <li key={a.label} className="flex items-baseline gap-2 text-[10.5px]">
                              <span className="flex-1 min-w-0 text-ink-300 truncate">{a.label}</span>
                              <span className="tabular text-ink-400">{a.before}{a.unit}</span>
                              <span className="text-ink-500">→</span>
                              <span
                                className="tabular font-semibold"
                                style={{ color: a.same ? "#adaaa5" : a.improved ? "#8ad8b0" : "#fb8a1f" }}
                              >
                                {a.after}{a.unit}
                              </span>
                            </li>
                          ))}
                        </ul>
                        {/* A detour is longer than the road it replaces almost by
                            definition, so the axes are reported rather than claimed. */}
                        <p className="text-[9.5px] text-ink-500 mt-1.5 leading-tight">
                          Measured against the route you were on. Green improved, amber did not — a detour
                          cannot beat the original on every axis at once.
                        </p>
                      </div>
                    )}
                    {engine.demoJam && !engine.axes && !engine.checking && (
                      <p className="text-[10.5px] text-[#ffc48a] mt-1.5 leading-tight">{engine.message}</p>
                    )}
                  </div>

                  <button
                    onClick={stopAll}
                    className="press hm-sos flex items-center justify-center gap-2 w-full h-11 rounded-full text-[13.5px] font-semibold"
                  >
                    <X size={16} />
                    Cancel the simulation
                  </button>
                </>
              ) : (
                <button
                  onClick={runTrip}
                  disabled={!route}
                  className="press flex items-center gap-2.5 w-full rounded-2xl px-3 py-2.5 text-left disabled:opacity-45 bg-white/[0.05] hover:bg-white/[0.09] disabled:hover:bg-white/[0.05]"
                >
                  <Navigation size={16} style={{ color: route?.color ?? "#6fbf5e" }} />
                  <span className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-ink-100">
                      Run the planned trip in {mode === "twin" ? "3D" : "2D"}
                    </div>
                    <div className="text-[10.5px] text-ink-400 leading-tight">
                      {route
                        ? `${route.label} · ${route.speed_kmh ?? "—"} km/h by ${route.mode_label?.toLowerCase() ?? "foot"}, to the destination`
                        : "Plan a route first — this follows the one on screen"}
                    </div>
                  </span>
                </button>
              )}
            </div>

            <div className="flex gap-2 mt-3">
              <button
                onClick={() => apply(d)}
                disabled={loading}
                className="press flex-1 h-11 rounded-full font-semibold text-[14px] text-ink-950 flex items-center justify-center gap-2 disabled:opacity-60"
                style={{ background: "linear-gradient(135deg,#ffb347,#fb8a1f 50%,#ef4444)" }}
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} fill="currentColor" />} Run simulation
              </button>
              <button
                onClick={() => {
                  setD(0);
                  resetSimulation();
                }}
                className="press grid place-items-center w-11 h-11 rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-ink-200"
                aria-label="Reset to real conditions"
              >
                <RotateCcw size={16} />
              </button>
            </div>
          </div>
        </>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        className={`press flex items-center justify-center gap-2 rounded-full text-[14px] font-semibold ${compact ? "w-11 h-11" : "glass h-12 pl-3.5 pr-4"} ${active ? "glow-pulse" : ""}`}
        aria-label="Simulate a temperature change"
        style={active ? { background: "linear-gradient(135deg, rgba(251,138,31,.95), rgba(239,68,68,.9))", color: "#fff" } : undefined}
        aria-expanded={open}
      >
        <Zap size={16} className={active ? "" : "text-heat-4"} fill="currentColor" />
        {compact ? null : active ? `${fmtDelta(delta, units, 0)} simulated` : "Simulate"}
      </button>
    </div>
  );
}
