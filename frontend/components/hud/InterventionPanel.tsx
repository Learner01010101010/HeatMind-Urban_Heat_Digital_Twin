"use client";

import { Sprout, Trash2, X } from "lucide-react";
import { useState } from "react";
import { clearInterventions } from "@/lib/actions";
import type { InterventionKind } from "@/lib/api";
import { fmtDelta } from "@/lib/heatColorScale";
import { INTERVENTION_STYLE } from "@/lib/interventionStyle";
import { useMap, usePrefs } from "@/lib/store";

const KINDS: InterventionKind[] = ["trees", "cool_pavement", "shade_structure"];
const BLURB: Record<InterventionKind, string> = {
  trees: "Adds canopy shade + evapotranspiration cooling",
  cool_pavement: "Reflective coating lowers surface heat gain",
  shade_structure: "Blocks direct sun at one exact spot",
};

/** SDG 13/15 — "What if we fixed this street?" Pick a fix, tap the map, see the twin respond. */
export default function InterventionPanel({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const pickMode = useMap((s) => s.pickMode);
  const results = useMap((s) => s.interventionResults);
  const busy = useMap((s) => s.interventionBusy);
  const set = useMap((s) => s.set);
  const units = usePrefs((s) => s.units);
  const picking = pickMode === "trees" || pickMode === "cool_pavement" || pickMode === "shade_structure";

  const pick = (k: InterventionKind) => {
    const next = pickMode === k ? null : k;
    set({ pickMode: next });
    // close the popover once a tool is armed, so its click-outside overlay
    // doesn't swallow the map click the user is about to make
    if (next) setOpen(false);
  };

  const avgDelta = results.length ? results.reduce((a, r) => a + r.delta_c, 0) / results.length : 0;

  return (
    <div className="relative">
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div
            className={`glass-strong absolute right-0 z-20 w-[300px] ${compact ? "top-full mt-3" : "bottom-full mb-3"} rounded-[26px] p-4 pop-in`}
            role="dialog"
            aria-label="Intervention simulator"
          >
            <div className="flex items-baseline justify-between mb-1">
              <div className="text-[15px] font-semibold text-ink-100 tracking-tight">Fix this street</div>
              {results.length > 0 && (
                <button onClick={clearInterventions} className="press flex items-center gap-1 text-[11px] text-ink-400 hover:text-ink-200" aria-label="Clear all interventions">
                  <Trash2 size={12} /> Clear
                </button>
              )}
            </div>
            <p className="text-[12px] text-ink-400 mb-3 leading-snug">
              Pick a street-cooling fix, then tap any spot on the map. The twin re-runs its physics model on that patch, live.
            </p>

            <div className="flex flex-col gap-1.5">
              {KINDS.map((k) => {
                const s = INTERVENTION_STYLE[k];
                const active = pickMode === k;
                return (
                  <button
                    key={k}
                    onClick={() => pick(k)}
                    className={`press flex items-center gap-2.5 rounded-2xl px-3 py-2.5 text-left transition-colors ${active ? "bg-white/[0.1]" : "bg-white/[0.05] hover:bg-white/[0.08]"}`}
                    style={active ? { boxShadow: `inset 0 0 0 1.5px ${s.color}` } : undefined}
                  >
                    <span className="text-[17px] leading-none">{s.icon}</span>
                    <span className="flex-1 min-w-0">
                      <div className="text-[13px] font-semibold text-ink-100">{s.short}</div>
                      <div className="text-[10.5px] text-ink-400 leading-tight truncate">{BLURB[k]}</div>
                    </span>
                  </button>
                );
              })}
            </div>

            {picking && (
              <div className="mt-3 rounded-2xl px-3 py-2 text-[12px] flex items-center gap-2" style={{ background: "rgba(52,226,198,.12)", color: "#7ff3de" }}>
                {busy ? "Simulating…" : "Tap the map to preview here"}
              </div>
            )}

            {results.length > 0 && (
              <div className="mt-3 pt-3 border-t border-white/10">
                <div className="text-[11px] text-ink-400 mb-1.5">
                  {results.length} intervention{results.length > 1 ? "s" : ""} placed · avg {fmtDelta(avgDelta, units)}
                </div>
                <div className="flex flex-col gap-1 max-h-[120px] overflow-y-auto">
                  {results.slice(-5).reverse().map((r, i) => {
                    const s = INTERVENTION_STYLE[r.kind];
                    return (
                      <div key={i} className="flex items-center gap-2 text-[11.5px] text-ink-300">
                        <span>{s.icon}</span>
                        <span className="flex-1 truncate">{s.short}</span>
                        <span className="font-semibold tabular" style={{ color: r.delta_c < 0 ? "#4cc3ff" : "#fb8a1f" }}>
                          {fmtDelta(r.delta_c, units)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </>
      )}
      <button
        onClick={() => {
          if (picking) set({ pickMode: null });
          setOpen((o) => !o);
        }}
        className={`press glass flex items-center justify-center gap-2 rounded-full text-[14px] font-semibold ${compact ? "w-11 h-11" : "h-12 pl-3.5 pr-4"} ${picking ? "glow-pulse" : ""}`}
        aria-label="Simulate a street-cooling intervention"
        style={picking ? { background: "linear-gradient(135deg, rgba(52,226,198,.95), rgba(76,195,255,.9))", color: "#04140f" } : undefined}
        aria-expanded={open}
      >
        {picking ? <X size={16} /> : <Sprout size={16} className={results.length ? "text-cool-400" : "text-ink-200"} />}
        {compact ? null : picking ? "Cancel" : results.length ? `${results.length} fix${results.length > 1 ? "es" : ""} placed` : "Fix this street"}
      </button>
    </div>
  );
}
