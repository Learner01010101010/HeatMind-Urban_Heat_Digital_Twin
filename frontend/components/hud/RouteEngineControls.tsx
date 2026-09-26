"use client";

import { Activity, RefreshCw } from "lucide-react";
import type { CompareResult, RouteObjective } from "@/lib/api";
import { runCompare } from "@/lib/actions";
import { applyRouteChange, checkLiveRoute } from "@/lib/liveRouting";
import { useNav } from "@/lib/navigation";
import { useRouteEngine } from "@/lib/routeEngineState";
import { useMap } from "@/lib/store";

const GOALS: [RouteObjective, string][] = [["balanced", "Balanced"], ["fastest", "Fastest"], ["shortest", "Shortest"], ["coolest", "Least heat"]];

export default function RouteEngineControls({ compare, navigation = false }: { compare: CompareResult; navigation?: boolean }) {
  const state = useRouteEngine();
  const loading = useMap((s) => s.loading);
  const activeRouteId = useNav((s) => s.routeId);
  const engine = compare.route_engine;
  if (!engine) return null;
  const bus = navigation && compare.routes.find((r) => r.id === activeRouteId)?.transit;
  const choose = (objective: RouteObjective) => { state.set({ objective, pending: null }); void runCompare(); };
  return <section aria-label="Multi-algorithm route engine" className={`${navigation ? "glass-strong rounded-[20px] p-3 mt-2" : "rounded-[18px] bg-white/[0.04] p-3 mb-2"} text-[11px]`}>
    <div className="flex items-center gap-1.5 text-cool-300 font-semibold"><Activity size={13} aria-hidden />Multi-algorithm optimizer{navigation && <span className="ml-auto text-[10px] text-ink-400">{GOALS.find(([goal]) => goal === engine.objective)?.[1]}</span>}</div>
    {!navigation && <div className="grid grid-cols-4 gap-1 mt-2" role="group" aria-label="Route priority">{GOALS.map(([goal, label]) =>
      <button key={goal} onClick={() => choose(goal)} disabled={loading || state.checking} aria-pressed={engine.objective === goal}
        className={`press rounded-xl px-1 py-2 text-[10px] disabled:opacity-50 ${engine.objective === goal ? "bg-cool-300 text-ink-950 font-semibold" : "bg-white/5 text-ink-300"}`}>{label}</button>
    )}</div>}
    <div className="flex items-center gap-2 mt-2">
      <label className="flex items-center gap-1.5 flex-1 cursor-pointer"><input type="checkbox" checked={state.enabled} disabled={!!bus}
        onChange={(e) => state.set({ enabled: e.target.checked })} aria-label="Automatic live rerouting" className="accent-[#8ad8b0]" />Auto reroute during navigation</label>
      <button onClick={() => void checkLiveRoute("manual")} disabled={state.checking || loading || !!bus} aria-label="Check route conditions now" className="press p-1.5 rounded-full hover:bg-white/10 disabled:opacity-50"><RefreshCw size={12} className={state.checking ? "animate-spin" : ""} /></button>
    </div>
    <p role="status" className={`mt-1.5 leading-snug ${state.error ? "text-heat-4" : "text-ink-300"}`}>{bus ? "Bus service times are estimated; automatic rerouting is available for street navigation." : state.checking ? "Checking the remaining journey…" : state.error ?? state.message}</p>
    {state.lastChecked && <p className="text-[10px] text-ink-400 mt-1">{state.source === "gps" ? "GPS" : state.source === "preview" ? "Simulated navigation" : "Planned start"} · checked {new Date(state.lastChecked).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{state.switches > 0 ? ` · ${state.switches} reroute${state.switches === 1 ? "" : "s"}` : ""}</p>}
    {state.changes.length > 0 && <p className="text-[10px] text-heat-4 mt-1">{state.changes.join(" · ")}</p>}
    {state.pending && <button onClick={() => state.pending && applyRouteChange(state.pending)} className="press mt-2 rounded-full bg-cool-300 text-ink-950 px-3 py-1.5 font-semibold">Use updated route</button>}
    <details className="mt-2 text-[10px] text-ink-400"><summary className="cursor-pointer">Algorithms, live data & training</summary>
      <p className="mt-1">{engine.algorithms.join(" · ")}</p><p className="mt-1">{engine.note}</p>
      <p className="mt-1">While this page is open: conditions checked every minute; off-route GPS checks up to every 10 sec. Traffic cached up to 5 min; weather feed refreshed up to every 30 min. Sudden changes need an updated feed.</p>
      <p className="mt-1">{engine.training.available ? `${engine.training.examples} local training examples recorded.` : "Training log temporarily unavailable."} Metrics are modelled and labels are rule-derived; no measured outcomes or trained ML yet. No coordinates or user IDs recorded.</p>
      {navigation && !bus && <div className="mt-2 flex gap-2"><button disabled={state.checking} onClick={() => { state.set({ demoHeatDelta: 5 }); void checkLiveRoute("temperature"); }} className="press rounded-full px-2 py-1 bg-white/10 text-ink-200">Test +5°C (simulation)</button>
        {state.demoHeatDelta !== 0 && <button disabled={state.checking} onClick={() => { state.set({ demoHeatDelta: 0 }); void checkLiveRoute("temperature"); }} className="press rounded-full px-2 py-1 bg-white/10 text-ink-200">Reset simulation</button>}</div>}
    </details>
    {state.demoHeatDelta !== 0 && <p className="mt-1 text-heat-4">Simulated heat change: +{state.demoHeatDelta}°C</p>}
  </section>;
}
