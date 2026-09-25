"use client";

import { Loader2, RotateCcw, Zap } from "lucide-react";
import { useState } from "react";
import { resetSimulation, runSimulate } from "@/lib/actions";
import { fmtDelta } from "@/lib/heatColorScale";
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
