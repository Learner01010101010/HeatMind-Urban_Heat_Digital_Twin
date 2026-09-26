"use client";

import { Scale } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type EquitySummary } from "@/lib/api";
import { useBaseTime, useNearestFrame } from "@/lib/hooks";
import { SCENARIO, useMap } from "@/lib/store";

/** SDG 10 — Heat Vulnerability overlay: heat × cooling deficit × cooling-access deficit. */
export default function EquityToggle({ compact = false }: { compact?: boolean }) {
  const on = useMap((s) => s.equityOn);
  const set = useMap((s) => s.set);
  const [showInfo, setShowInfo] = useState(false);
  const [summary, setSummary] = useState<EquitySummary | null>(null);
  const nearest = useNearestFrame();
  const base = useBaseTime();

  useEffect(() => {
    if (!on || !nearest || !base) return;
    let dead = false;
    api.equity({ scenario: SCENARIO, time: nearest.time }).then((r) => {
      if (!dead) setSummary(r.summary);
    });
    return () => {
      dead = true;
    };
  }, [on, nearest, base]);

  return (
    <div className="relative">
      {showInfo && on && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setShowInfo(false)} aria-hidden />
          <div className={`glass-strong z-20 rounded-[22px] p-4 pop-in ${compact ? "fixed top-[72px] right-[76px] w-[min(280px,calc(100vw-100px))] max-h-[calc(100dvh-140px)] overflow-y-auto" : "absolute right-0 bottom-full mb-3 w-[280px]"}`} role="dialog" aria-label="Heat vulnerability index">
            <div className="text-[10.5px] font-bold uppercase tracking-wider mb-1" style={{ color: "#dd1367" }}>
              Heat vulnerability · SDG 10
            </div>
            <p className="text-[12px] text-ink-300 leading-relaxed mb-2">
              Where heat, lack of shade/water cooling, and distance from rest &amp; water points compound. <strong className="text-ink-100">Not demographic data</strong> — no census or income data exists for this zone.
            </p>
            {/* The relief is read by colour before it is read by height, so the scale
                has to be on screen. Blue is a low index, yellow a high one. */}
            <div className="mt-3">
              <div className="h-2 rounded-full" style={{ background: "var(--vuln-gradient)" }} />
              <div className="flex justify-between text-[9.5px] text-ink-400 mt-1 tabular">
                <span>0</span><span>10</span><span>20</span><span>30</span><span>40</span><span>50+</span>
              </div>
            </div>
            {summary && (
              <div className="grid grid-cols-3 gap-2 text-center mt-3">
                <div>
                  <div className="text-[18px] font-bold text-ink-100 tabular">{summary.mean}</div>
                  <div className="text-[9.5px] text-ink-400">Mean index</div>
                </div>
                <div>
                  <div className="text-[18px] font-bold text-ink-100 tabular">{summary.p90}</div>
                  <div className="text-[9.5px] text-ink-400">90th pct</div>
                </div>
                <div>
                  <div className="text-[18px] font-bold" style={{ color: "#dd1367" }}>
                    {summary.pct_high}%
                  </div>
                  <div className="text-[9.5px] text-ink-400">High risk</div>
                </div>
              </div>
            )}
            <div className="mt-3 pt-3 border-t border-white/10 text-[10.5px] text-ink-400 leading-snug">45% heat exposure + 30% cooling deficit + 25% distance to nearest cooling point</div>
          </div>
        </>
      )}
      <button
        onClick={() => {
          const next = !on;
          set({ equityOn: next });
          if (next) setShowInfo(true);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className={`press flex items-center justify-center gap-2 rounded-full text-[14px] font-semibold ${compact ? "w-11 h-11" : "glass h-12 pl-3.5 pr-4"}`}
        aria-label="Toggle heat vulnerability overlay"
        aria-pressed={on}
        style={on ? { background: "#dd1367", color: "#fff" } : undefined}
      >
        <Scale size={16} className={on ? "" : "text-ink-200"} />
        {compact ? null : on ? "Vulnerability on" : "Heat vulnerability"}
      </button>
      {on && (
        <button
          onClick={() => setShowInfo((v) => !v)}
          className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-[#dd1367] text-white text-[10px] font-bold grid place-items-center"
          aria-label="Show methodology"
        >
          i
        </button>
      )}
    </div>
  );
}
