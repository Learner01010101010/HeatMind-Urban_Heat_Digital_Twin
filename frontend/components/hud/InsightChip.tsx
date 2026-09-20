"use client";

import { ChevronRight, Flame, Snowflake } from "lucide-react";
import { useFrames, useMeta, useNearestFrame } from "@/lib/hooks";
import { fmtClock, fmtTemp, heatColor } from "@/lib/heatColorScale";
import { TIMELINE, TIMELINE_MAX, useMap, usePrefs } from "@/lib/store";
import AnimatedNumber from "@/components/ui/AnimatedNumber";

/** The one heat insight that stays on screen: one city number vs. the street-level reality. */
export function InsightChip({ compact = false }: { compact?: boolean }) {
  const f = useNearestFrame();
  const units = usePrefs((s) => s.units);
  const set = useMap((s) => s.set);
  const conv = (c: number) => (units === "F" ? (c * 9) / 5 + 32 : c);
  if (compact) {
    return (
      <button onClick={() => set({ panel: "insight" })} className="press glass relative grid place-items-center w-11 h-11 rounded-full" aria-label="Heat insights">
        <span className="absolute inset-[5px] rounded-full" style={{ background: f ? `conic-gradient(from 200deg, ${heatColor(f.stats.street_min_c)}, ${heatColor(f.stats.street_max_c)}, ${heatColor(f.stats.street_min_c)})` : "#1a2130" }} />
        <span className="relative grid place-items-center w-7 h-7 rounded-full bg-ink-900 text-[10.5px] font-semibold tabular text-ink-100">{f ? Math.round(conv(f.stats.street_max_c)) : "–"}°</span>
      </button>
    );
  }
  return (
    <button onClick={() => set({ panel: "insight" })} className="press glass flex items-center gap-3 h-12 pl-2 pr-3.5 rounded-full text-left" aria-label="Heat insights">
      <span className="relative grid place-items-center w-8 h-8 rounded-full" style={{ background: f ? `conic-gradient(from 200deg, ${heatColor(f.stats.street_min_c)}, ${heatColor(f.stats.street_max_c)}, ${heatColor(f.stats.street_min_c)})` : "#1a2130" }}>
        <span className="w-5 h-5 rounded-full bg-ink-900" />
      </span>
      {f ? (
        <span className="leading-none">
          <span className="block text-[15px] font-semibold tracking-tight text-ink-100">
            <AnimatedNumber value={conv(f.stats.street_min_c)} />–<AnimatedNumber value={conv(f.stats.street_max_c)} />°
            <span className="text-ink-400 font-normal text-[12px] ml-1.5">streets</span>
          </span>
          <span className="block text-[11px] text-ink-400 mt-1">
            City says {fmtTemp(f.weather.air_c, units)} · Δ{Math.round(f.stats.street_spread_c)}°
          </span>
        </span>
      ) : (
        <span className="skeleton w-28 h-6 rounded-lg" />
      )}
      <ChevronRight size={15} className="text-ink-500" />
    </button>
  );
}

const SOURCE: Record<string, string> = {
  demo_scenario: "Heatwave profile",
  open_meteo: "Live weather · Open-Meteo",
  climatology_fallback: "Pune climatology (offline)",
};

export function InsightPanel() {
  const f = useNearestFrame();
  const frames = useFrames((s) => s.frames);
  const timeMin = useMap((s) => s.timeMin);
  const mode = useMap((s) => s.mode);
  const set = useMap((s) => s.set);
  const units = usePrefs((s) => s.units);
  const meta = useMeta();
  if (!f) return <div className="skeleton h-64 rounded-3xl" />;
  const s = f.stats;
  const lo = Math.min(s.street_min_c, s.city_level_c) - 1;
  const hi = Math.max(s.street_max_c, s.city_level_c) + 1;
  const pos = (c: number) => `${((c - lo) / (hi - lo)) * 100}%`;

  const loaded = frames.map((x, i) => (x ? { i, max: x.stats.street_max_c, mean: x.stats.street_mean_c, min: x.stats.street_min_c } : null)).filter(Boolean) as { i: number; max: number; mean: number; min: number }[];
  const W = 340;
  const H = 96;
  const yLo = Math.min(...loaded.map((d) => d.min)) - 1;
  const yHi = Math.max(...loaded.map((d) => d.max)) + 1;
  const X = (i: number) => (TIMELINE[i] / TIMELINE_MAX) * W;
  const Y = (c: number) => 6 + (1 - (c - yLo) / Math.max(yHi - yLo, 1)) * (H - 12);
  const line = (k: "max" | "mean" | "min") => loaded.map((d, n) => `${n ? "L" : "M"}${X(d.i)},${Y(d[k])}`).join(" ");
  const band = loaded.length > 1 ? `${line("max")} ${[...loaded].reverse().map((d) => `L${X(d.i)},${Y(d.min)}`).join(" ")} Z` : "";

  return (
    <div className="space-y-5">
      <section>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-[22px] bg-white/[0.035] p-4">
            <div className="text-[12px] text-ink-400">Weather apps say</div>
            <div className="text-[40px] font-semibold tracking-[-0.04em] leading-none mt-2 tabular">{fmtTemp(s.city_level_c, units)}</div>
            <div className="text-[11px] text-ink-500 mt-2">one number for the whole city</div>
          </div>
          <div className="rounded-[22px] p-4" style={{ background: `linear-gradient(135deg, ${heatColor(s.street_min_c)}22, ${heatColor(s.street_max_c)}33)` }}>
            <div className="text-[12px] text-ink-300">Streets actually feel</div>
            <div className="text-[40px] font-semibold tracking-[-0.04em] leading-none mt-2 tabular">
              <span style={{ color: heatColor(s.street_min_c) }}>{Math.round(units === "F" ? (s.street_min_c * 9) / 5 + 32 : s.street_min_c)}</span>
              <span className="text-ink-500">–</span>
              <span style={{ color: heatColor(s.street_max_c) }}>{Math.round(units === "F" ? (s.street_max_c * 9) / 5 + 32 : s.street_max_c)}°</span>
            </div>
            <div className="text-[11px] text-ink-300 mt-2">{Math.round(s.street_spread_c)}° apart, same campus</div>
          </div>
        </div>
        <div className="relative mt-4 h-2 rounded-full heat-gradient opacity-25" />
        <div className="relative -mt-2 h-2">
          <div className="absolute h-2 rounded-full heat-gradient transition-all duration-500" style={{ left: pos(s.street_min_c), right: `calc(100% - ${pos(s.street_max_c)})` }} />
          <div className="absolute -top-1.5 w-1 h-5 rounded-full bg-white shadow-[0_0_10px_white] transition-all duration-500" style={{ left: pos(s.city_level_c) }} />
        </div>
      </section>

      <section className="space-y-2">
        {[
          { spot: s.hottest, icon: Flame, title: "Hottest street", c: "#ef4444" },
          { spot: s.coolest, icon: Snowflake, title: "Coolest street", c: "#34e2c6" },
        ].map((x) => (
          <button
            key={x.title}
            onClick={() => set({ flyTo: { lat: x.spot.lat, lon: x.spot.lon, zoom: 17.6, nonce: Date.now() }, mode: "twin" })}
            className="press w-full flex items-center gap-3 rounded-[20px] bg-white/[0.035] hover:bg-white/[0.06] p-3 text-left"
          >
            <span className="grid place-items-center w-10 h-10 rounded-2xl" style={{ background: `${x.c}1f`, color: x.c }}>
              <x.icon size={18} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[12px] text-ink-400">{x.title}</span>
              <span className="block text-[14px] font-medium text-ink-100 truncate">{x.spot.label}</span>
            </span>
            <span className="text-[20px] font-semibold tabular tracking-tight" style={{ color: heatColor(x.spot.feels_c) }}>
              {fmtTemp(x.spot.feels_c, units)}
            </span>
          </button>
        ))}
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-[15px] font-semibold tracking-tight">Next 3 hours</h3>
          <span className="text-[11px] text-ink-400">physics-informed nowcast</span>
        </div>
        <div className="rounded-[22px] bg-white/[0.035] p-4">
          {loaded.length > 1 ? (
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
              <defs>
                <linearGradient id="ins-band" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="#ef4444" stopOpacity=".35" />
                  <stop offset="1" stopColor="#facc15" stopOpacity=".05" />
                </linearGradient>
              </defs>
              <path d={band} fill="url(#ins-band)" />
              <path d={line("max")} fill="none" stroke="#ef4444" strokeWidth="2" />
              <path d={line("mean")} fill="none" stroke="#facc15" strokeWidth="1.6" strokeDasharray="3 4" />
              <line x1={(timeMin / TIMELINE_MAX) * W} x2={(timeMin / TIMELINE_MAX) * W} y1="0" y2={H} stroke="#fff" strokeOpacity=".7" />
            </svg>
          ) : (
            <div className="skeleton h-24 rounded-xl" />
          )}
          <div className="flex justify-between text-[10.5px] text-ink-400 mt-2">
            <span>Now</span>
            <span>+1h</span>
            <span>+2h</span>
            <span>+3h</span>
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-[15px] font-semibold tracking-tight mb-2">What you&apos;re seeing</h3>
        <div className="rounded-[22px] bg-white/[0.035] p-4 space-y-3 text-[13px] text-ink-200">
          <div>
            <div className="h-2 rounded-full heat-gradient" />
            <div className="flex justify-between text-[10.5px] text-ink-400 mt-1.5 tabular">
              <span>{fmtTemp(28, units)} comfortable</span>
              <span>{fmtTemp(56, units)} extreme</span>
            </div>
          </div>
          {[
            { sw: "linear-gradient(90deg,#34e2c6,#b6fff1)", t: "Cooling corridors", d: "coolest 22% of streets right now" },
            { sw: "#ff5a36", t: "Hot streets", d: "hottest 12% — avoid at peak sun" },
            { sw: "radial-gradient(circle,#ffd2b4,#ef4444 60%,transparent 70%)", t: "Hotspots", d: "densest sun-baked ground" },
            { sw: "#050a1c", t: "Computed shadows", d: "buildings × live sun angle" },
          ].map((x) => (
            <div key={x.t} className={`flex items-center gap-3 ${mode === "twin" ? "" : "opacity-50"}`}>
              <span className="w-8 h-3 rounded-full shrink-0 border border-white/10" style={{ background: x.sw }} />
              <span className="flex-1">
                <span className="text-ink-100">{x.t}</span> <span className="text-ink-400">· {x.d}</span>
              </span>
            </div>
          ))}
          {mode !== "twin" && (
            <button onClick={() => set({ mode: "twin" })} className="press text-[13px] font-semibold text-cool-300">
              Switch to Heat Twin to see these →
            </button>
          )}
        </div>
      </section>

      <p className="text-[11.5px] text-ink-500 leading-relaxed">
        {SOURCE[f.weather.source]} · {fmtClock(f.time)} · RH {f.weather.rh}% · sun {f.sun.elevation_deg > 0 ? `${Math.round(f.sun.elevation_deg)}° high` : "below horizon"}
        {meta.data ? ` · ${meta.data.zone.counts.buildings} buildings & ${meta.data.zone.counts.roads} streets from OpenStreetMap` : ""}
      </p>
    </div>
  );
}
