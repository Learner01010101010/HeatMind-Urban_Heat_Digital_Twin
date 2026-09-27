"use client";

import { Loader2, Route as RouteIcon } from "lucide-react";
import { useEffect } from "react";
import type { Route } from "@/lib/api";
import { acceptDynamicSuggestion, cancelDynamicCheck, checkDynamicRoute, continueCurrentRoute,
  toggleDynamicRerouting, useDynamicRerouting } from "@/lib/dynamicRerouting";
import { useNav } from "@/lib/navigation";

export default function RouteUpdateNotice({ route, arrived }: { route: Route; arrived: boolean }) {
  const state = useDynamicRerouting();
  const active = useNav((s) => s.active);
  const startedAt = useNav((s) => s.startedAt);
  useEffect(() => {
    if (!state.enabled || !active || arrived || route.transit) return;
    const check = () => { if (document.visibilityState === "visible") void checkDynamicRoute(); };
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        check();
        schedule();
      }, (useDynamicRerouting.getState().config?.check_seconds ?? 60) * 1000);
    };
    check();
    schedule();
    document.addEventListener("visibilitychange", check);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", check); cancelDynamicCheck(); };
  }, [state.enabled, active, arrived, route.id, route.transit, startedAt]);
  // Expiry removes a stale notification while the traveller keeps moving.
  useEffect(() => {
    if (!state.pending) return;
    const timer = setTimeout(() => useDynamicRerouting.getState().set({ pending: null }), Math.max(0, state.pending.expires - Date.now()));
    return () => clearTimeout(timer);
  }, [state.pending]);
  if (!active || arrived || route.transit) return null;
  const pending = state.pending;
  return <div className="border-t border-white/[0.06] px-4 py-2.5">
    <label className="flex items-center gap-2 text-[11px] text-ink-400">
      <input type="checkbox" checked={state.enabled} onChange={(e) => toggleDynamicRerouting(e.target.checked)} className="accent-emerald-300" />
      Suggest route updates
      {(state.checking || state.accepting) && <Loader2 size={12} className="animate-spin ml-auto" aria-label="Checking conditions" />}
    </label>
    {pending && <div role="status" aria-live="polite" className="mt-2 rounded-2xl border border-emerald-300/25 bg-emerald-300/[0.07] p-3">
      <div className="flex gap-2 items-center text-[12px] font-semibold text-emerald-200"><RouteIcon size={15} />Conditions changed → Reroute?</div>
      <p className="text-[11px] text-ink-300 mt-1">{pending.result.reason}</p>
      <p className="text-[10.5px] text-ink-400 mt-1">
        {pending.result.saving_min != null && pending.result.saving_min >= 1 ? `About ${Math.round(pending.result.saving_min)} min quicker` : null}
        {pending.result.heat_improvement_percent != null && pending.result.heat_improvement_percent >= 1
          ? `${pending.result.saving_min != null && pending.result.saving_min >= 1 ? " · " : ""}${Math.round(pending.result.heat_improvement_percent)}% less estimated heat exposure` : null}
        {pending.source === "preview" && <span className="block">Trip preview position · forecast estimates</span>}
      </p>
      <div className="flex gap-2 mt-2">
        <button type="button" disabled={state.accepting} onClick={() => void acceptDynamicSuggestion()} className="press flex-1 rounded-full bg-emerald-300 text-ink-950 py-2 text-[12px] font-semibold disabled:opacity-50">{state.accepting ? "Recalculating…" : "Reroute"}</button>
        <button type="button" disabled={state.accepting} onClick={continueCurrentRoute} className="press flex-1 rounded-full bg-white/10 text-ink-200 py-2 text-[12px] disabled:opacity-50">Continue</button>
      </div>
    </div>}
    {state.enabled && state.error && <p role="status" className="text-[10px] text-ink-500 mt-1.5">{state.error}</p>}
  </div>;
}
