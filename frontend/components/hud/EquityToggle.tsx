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
          <div className={`glass-strong absolute right-0 z-20 w-[280px] ${compact ? "top-full mt-3" : "bottom-full mb-3"} rounded-[22px] p-4 pop-in`} role="dialog" aria-label="Heat vulnerability index">
            <div className="text-[10.5px] font-bold uppercase tracking-wider mb-1" style={{ color: "#dd1367" }}>
              Heat vulnerability · SDG 10
            </div>
            <p className="text-[12px] text-ink-300 leading-relaxed mb-2">
              Where heat, lack of shade/water cooling, and distance from rest &amp; water points compound. <strong className="text-ink-100">Not demographic data</strong> — no census or income data exists for this zone.
            </p>
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
        className={`press glass flex items-center justify-center gap-2 rounded-full text-[14px] font-semibold ${compact ? "w-11 h-11" : "h-12 pl-3.5 pr-4"}`}
        aria-label="Toggle heat vulnerability overlay"
        aria-pressed={on}
        style={on ? { background: "linear-gradient(135deg, rgba(190,24,93,.9), rgba(221,19,103,.85))", color: "#fff" } : undefined}
      >
        <Scale size={16} className={on ? "" : "text-ink-200"} />
        {compact ? null : on ? "Vulnerability on" : "Heat vulnerability"}
      </button>
      {on && (
        <button
          onClick={() => setShowInfo((v) => !v)}
          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[#dd1367] text-white text-[10px] font-bold grid place-items-center"
          aria-label="Show methodology"
        >
          i
        </button>
      )}
    </div>
  );
}
