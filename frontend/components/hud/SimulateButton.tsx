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
          <div className={`glass-strong absolute right-0 z-20 w-[290px] ${compact ? "top-full mt-3" : "bottom-full mb-3"} rounded-[26px] p-4 pop-in`} role="dialog" aria-label="Simulate conditions">
            <div className="flex items-baseline justify-between mb-1">
              <div className="text-[15px] font-semibold text-ink-100 tracking-tight">What if it gets hotter?</div>
              <div className="text-[22px] font-semibold tabular tracking-tight" style={{ color: d > 0 ? "#fb8a1f" : d < 0 ? "#4cc3ff" : "#eef2f7" }}>
                {fmtDelta(d, units, 0)}
              </div>
            </div>
            <p className="text-[12px] text-ink-400 mb-3 leading-snug">{hasTrip ? "Routes re-score instantly. You'll get a reroute if a safer path appears." : "The twin repaints instantly. Plan a trip to see live rerouting."}</p>
            <input type="range" className="hm-mini w-full" min={-4} max={10} step={0.5} value={d} onChange={(e) => setD(Number(e.target.value))} aria-label="Temperature change" />
            <div className="flex gap-1.5 mt-4">
              {PRESETS.map((p) => (
                <button key={p.label} onClick={() => apply(p.delta)} className="press flex-1 rounded-2xl bg-white/[0.05] hover:bg-white/[0.1] px-2 py-2 text-center">
                  <div className="text-[13px] font-semibold tabular" style={{ color: p.delta > 0 ? "#fb8a1f" : "#4cc3ff" }}>
                    {fmtDelta(p.delta, units, 0)}
                  </div>
                  <div className="text-[10.5px] text-ink-400 leading-tight">{p.label}</div>
                </button>
              ))}
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
        className={`press glass flex items-center justify-center gap-2 rounded-full text-[14px] font-semibold ${compact ? "w-11 h-11" : "h-12 pl-3.5 pr-4"} ${active ? "glow-pulse" : ""}`}
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
