"use client";

import { ArrowDownUp, Check, ChevronDown, Droplets, Footprints, Loader2, Moon, Route as RouteIcon, Sparkles, Sun, Thermometer, TreePine } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Route } from "@/lib/api";
import { ensureUser, useMeta } from "@/lib/hooks";
import { fmtDist, fmtTemp, heatColor, riskColor } from "@/lib/heatColorScale";
import { POI_STYLE } from "@/lib/poiStyle";
import { atTime, TIMELINE, TIMELINE_MAX, useMap, usePrefs } from "@/lib/store";
import AnimatedNumber from "@/components/ui/AnimatedNumber";
import HeatProfileChart from "@/components/ui/HeatProfileChart";
import RiskRing from "@/components/ui/RiskRing";
import { StartNavButton } from "./NavHud";

const ICONS: Record<string, React.ElementType> = { shade: TreePine, thermo: Thermometer, water: Droplets, road: RouteIcon, tradeoff: ArrowDownUp, moon: Moon };

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-2.5">
        <h3 className="text-[15px] font-semibold tracking-tight text-ink-100">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function Fold({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-[22px] bg-white/[0.035]">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-4 h-12 text-[14px] font-medium text-ink-100" aria-expanded={open}>
        <span>
          {title}
          {count !== undefined && <span className="text-ink-400 font-normal"> · {count}</span>}
        </span>
        <ChevronDown size={16} className={`text-ink-400 transition-transform duration-300 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="px-4 pb-4 fade-in">{children}</div>}
    </div>
  );
}

export default function RoutePanel({ route }: { route: Route }) {
  const timeMin = useMap((s) => s.timeMin);
  const set = useMap((s) => s.set);
  const units = usePrefs((s) => s.units);
  const persona = usePrefs((s) => s.persona);
  const meta = useMeta();
  const [logState, setLogState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [polished, setPolished] = useState<{ id: string; text: string } | null>(null);

  // A transit route carries one keyframe, not thirteen — its wait does not travel
  // with the sun — so the scrubber has nothing to interpolate and reads that point.
  const score = atTime(route.forecast.map((f) => f.score), timeMin);
  const shade = atTime(route.forecast.map((f) => f.pct_shaded), timeMin);
  const peak = atTime(route.forecast.map((f) => f.peak_feels_c), timeMin);
  const water = route.pois_along_route.filter((p) => p.type === "water" || p.type === "cooling_center").length;
  const conv = (c: number) => (units === "F" ? (c * 9) / 5 + 32 : c);

  useEffect(() => {
    if (!meta.data?.llm_enabled) return;
    let alive = true;
    api
      .explain(route.id, true)
      .then((r) => alive && r.polished?.summary && setPolished({ id: route.id, text: r.polished.summary }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [route.id, meta.data?.llm_enabled]);

  const log = async () => {
    setLogState("busy");
    try {
      const uid = await ensureUser();
      await api.logTrip({ user_id: uid, route_id: route.id, persona });
      setLogState("done");
    } catch {
      setLogState("error");
    }
  };

  // group segments into named stretches
  const stretches: { name: string; len: number; feels: number; shade: number; surface: string }[] = [];
  for (const s of route.segments) {
    const f = atTime(s.feels, timeMin);
    const sh = 1 - atTime(s.exposure, timeMin);
    const last = stretches[stretches.length - 1];
    if (last && last.name === s.name) {
      const L = last.len + s.length_m;
      last.feels = (last.feels * last.len + f * s.length_m) / L;
      last.shade = (last.shade * last.len + sh * s.length_m) / L;
      last.len = L;
    } else stretches.push({ name: s.name, len: s.length_m, feels: f, shade: sh, surface: s.surface });
  }

  return (
    <div className="space-y-6">
      {/* hero */}
      <div className="flex items-center gap-5">
        <div className="flex-1">
          <div className="text-[56px] font-semibold tracking-[-0.055em] leading-none tabular">
            {Math.round(route.duration_min)}
            <span className="text-[18px] font-medium tracking-normal text-ink-400 ml-1.5">min</span>
          </div>
          <div className="text-[13px] text-ink-400 mt-2 flex items-center gap-1.5">
            {/* "Walks the shady side" is only true on foot. A car cannot cross the
                road for shade and saying it does would misdescribe the route. */}
            <Footprints size={13} /> {fmtDist(route.distance_m)}
            {route.mode && route.mode !== "walk"
              ? ` · by ${(route.mode_label ?? route.mode).toLowerCase()}`
              : " · walks the shady side"}
          </div>
        </div>
        <RiskRing score={score} size={92} stroke={7} label="heat risk" />
      </div>

      <StartNavButton route={route} />

      <div className="grid grid-cols-2 gap-2.5">
        {[
          { l: "Peak feels-like", v: <AnimatedNumber value={conv(peak)} suffix="°" />, c: heatColor(peak) },
          { l: "Shade coverage", v: <AnimatedNumber value={shade} suffix="%" />, c: "#6ff0da" },
          { l: "In danger heat", v: `${Math.round(route.metrics.minutes_danger)} min`, c: "#fca5a5" },
          { l: "Water & cooling", v: `${water} stops`, c: "#9dc06a" },
        ].map((x) => (
          <div key={x.l} className="rounded-[22px] bg-white/[0.035] px-4 py-3.5">
            <div className="text-[11.5px] text-ink-400">{x.l}</div>
            <div className="text-[24px] font-semibold tracking-tight mt-1 tabular" style={{ color: x.c }}>
              {x.v}
            </div>
          </div>
        ))}
      </div>

      <Section title="Why this score" right={polished?.id === route.id ? <span className="flex items-center gap-1 text-[11px] text-cool-300"><Sparkles size={11} /> AI</span> : <span className="text-[11px] text-ink-500">transparent · rule-based</span>}>
        <div className="rounded-[22px] bg-white/[0.035] p-4">
          <p className="text-[14px] text-ink-100 leading-relaxed">{polished?.id === route.id ? polished.text : route.explanation.summary}</p>
          <ul className="mt-3 space-y-2.5">
            {route.explanation.bullets.map((b, i) => {
              const I = ICONS[b.icon] ?? Thermometer;
              return (
                <li key={i} className="flex gap-3 text-[13px] text-ink-300 leading-snug">
                  <I size={15} className="text-cool-300 mt-0.5 shrink-0" />
                  <span>{b.text}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </Section>

      {route.steps.length > 0 && (
        <Section title="Directions" right={<span className="text-[11px] text-ink-500">{route.steps.length} steps</span>}>
          <ol className="rounded-[22px] bg-white/[0.035] divide-y divide-white/[0.05]">
            {route.steps.map((st) => (
              <li key={st.index} className="flex items-start gap-3 px-4 py-2.5">
                <span className="text-[11px] text-ink-500 tabular w-12 shrink-0 pt-0.5">{fmtDist(st.distance_m)}</span>
                <span className="flex-1 min-w-0 text-[12.5px] text-ink-200">{st.instruction}</span>
                {/* Marked per step, because the whole reason a step exists on this
                    street rather than the faster one is what the sun is doing to it. */}
                {st.exposure > 0.55 && (
                  <span className="flex items-center gap-0.5 text-[10.5px] text-heat-4 shrink-0 pt-0.5" title="In direct sun">
                    <Sun size={10} aria-hidden /> sun
                  </span>
                )}
              </li>
            ))}
          </ol>
        </Section>
      )}

      <Section title="Heat along the way" right={<span className="text-[11px] text-ink-500">updates with the timeline</span>}>
        <div className="rounded-[22px] bg-white/[0.035] p-4">
          <HeatProfileChart route={route} timeMin={timeMin} units={units} />
        </div>
      </Section>

      <Section title="Leave now or later?">
        <div className="rounded-[22px] bg-white/[0.035] p-4">
          <div className="flex items-end gap-1.5 h-20">
            {route.forecast.map((p, i) => {
              const on = Math.abs(TIMELINE[i] - timeMin) < 7.5;
              return (
                <button
                  key={p.offset_min}
                  onClick={() => set({ timeMin: TIMELINE[i] })}
                  className="flex-1 rounded-full transition-all duration-300"
                  style={{ height: `${Math.max(10, p.score)}%`, background: riskColor(p.score), opacity: on ? 1 : 0.35, boxShadow: on ? `0 0 16px ${riskColor(p.score)}` : "none" }}
                  aria-label={`Leave at +${p.offset_min} min: risk ${Math.round(p.score)}`}
                />
              );
            })}
          </div>
          <div className="flex justify-between text-[10.5px] text-ink-400 mt-2">
            <span>Now</span>
            <span>+1h</span>
            <span>+2h</span>
            <span>+3h</span>
          </div>
          <div className="h-1 mt-2 rounded-full bg-white/[0.06] relative">
            <span className="absolute top-0 h-1 rounded-full bg-white/60" style={{ width: `${(timeMin / TIMELINE_MAX) * 100}%` }} />
          </div>
        </div>
      </Section>

      <Section title="What drives the score" right={<Link href="/about#model" className="text-[11.5px] text-cool-300">weights →</Link>}>
        <div className="rounded-[22px] bg-white/[0.035] p-4 space-y-3">
          {[...route.factors]
            .sort((a, b) => b.contribution - a.contribution)
            .map((f) => {
              const max = Math.max(...route.factors.map((x) => x.contribution), 1);
              return (
                <div key={f.key}>
                  <div className="flex justify-between text-[12.5px] mb-1.5">
                    <span className="text-ink-200">{f.label}</span>
                    <span className="text-ink-400 tabular">+{f.contribution.toFixed(1)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(f.contribution / max) * 100}%`, background: "linear-gradient(90deg,#facc15,#fb8a1f,#ef4444)" }} />
                  </div>
                </div>
              );
            })}
        </div>
      </Section>

      <div className="space-y-2">
        <Fold title="Street by street" count={stretches.length}>
          <ol className="space-y-2">
            {stretches.map((p, i) => (
              <li key={i} className="flex items-center gap-3 text-[13px]">
                <span className="w-1 self-stretch rounded-full" style={{ background: heatColor(p.feels) }} />
                <span className="flex-1 min-w-0">
                  <span className="block text-ink-100 truncate capitalize">{p.name}</span>
                  <span className="block text-[11px] text-ink-400">
                    {Math.round(p.len)} m · {p.surface} · {Math.round(p.shade * 100)}% shade
                  </span>
                </span>
                <span className="tabular font-semibold" style={{ color: heatColor(p.feels) }}>
                  {fmtTemp(p.feels, units)}
                </span>
              </li>
            ))}
          </ol>
        </Fold>
        <Fold title="Water, rest & shade stops" count={route.pois_along_route.length}>
          <ul className="space-y-1">
            {route.pois_along_route.map((p) => (
              <li key={p.id}>
                <button onClick={() => set({ flyTo: { lat: p.lat, lon: p.lon, zoom: 18, nonce: Date.now() } })} className="w-full flex items-center gap-3 text-left text-[13px] rounded-xl px-1 py-1.5 hover:bg-white/5">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: POI_STYLE[p.type].color }} />
                  <span className="flex-1 truncate text-ink-200">{p.name}</span>
                  <span className="text-[11px] text-ink-400 tabular">{fmtDist(p.at_m ?? 0)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Fold>
      </div>

      <button
        onClick={log}
        disabled={logState === "busy" || logState === "done"}
        className="press w-full h-14 rounded-full font-semibold text-[15px] text-ink-950 flex items-center justify-center gap-2 disabled:opacity-90"
        style={{ background: "var(--cool-gradient)", boxShadow: "0 16px 40px -14px rgba(111,191,94,.7)" }}
      >
        {logState === "busy" ? <Loader2 size={18} className="animate-spin" /> : logState === "done" ? <Check size={18} /> : <Footprints size={18} />}
        {logState === "done" ? "Added to your Heat Passport" : logState === "error" ? "Couldn't log — retry" : "Start trip & log to Passport"}
      </button>
      {logState === "done" && (
        <Link href="/passport" className="block text-center text-[13px] font-semibold text-cool-300 -mt-3">
          Open Heat Passport →
        </Link>
      )}
    </div>
  );
}
