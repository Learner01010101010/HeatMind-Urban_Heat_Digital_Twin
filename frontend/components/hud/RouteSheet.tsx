"use client";

import { Bus, ChevronDown, ChevronLeft, ChevronRight, Clock3, Droplets, Footprints, Hourglass, Sun, TreePine, TriangleAlert } from "lucide-react";
import type { CompareResult, Route } from "@/lib/api";
import { fmtClock, fmtDist, riskColor } from "@/lib/heatColorScale";
import { personaOf } from "@/lib/personas";
import { atTime, useMap, usePrefs } from "@/lib/store";
import AnimatedNumber from "@/components/ui/AnimatedNumber";
import RiskRing from "@/components/ui/RiskRing";
import RoutePanel from "./RoutePanel";
import TransitLegs from "./TransitLegs";

const TAG: Record<string, string> = { recommended: "HeatMind pick", fastest: "Fastest", coolest: "Least heat dose", current: "Your route" };

function metrics(r: Route, fastest: Route, timeMin: number) {
  // A transit route carries no per-keyframe forecast: its legs run at three speeds
  // and the wait does not move along the street, so the scrubber's interpolation has
  // nothing to interpolate. Its single scored snapshot is used instead.
  if (r.transit) {
    return { shade: r.metrics.pct_shaded, score: r.heat_risk_score, red: 0, water: 0 };
  }
  const shade = atTime(r.forecast.map((f) => f.pct_shaded), timeMin);
  const score = atTime(r.forecast.map((f) => f.score), timeMin);
  const sun = r.duration_min * (1 - shade / 100);
  const fShade = fastest.transit
    ? fastest.metrics.pct_shaded
    : atTime(fastest.forecast.map((f) => f.pct_shaded), timeMin);
  const sunF = fastest.duration_min * (1 - fShade / 100);
  const red = sunF > 0 ? ((sunF - sun) / sunF) * 100 : 0;
  const water = r.pois_along_route.filter((p) => p.type === "water" || p.type === "cooling_center").length;
  return { shade, score, red, water };
}

/** One compact comparison row: time · live risk · shade · water · sun-exposure reduction. */
function Row({ r, fastest, timeMin, selected }: { r: Route; fastest: Route; timeMin: number; selected: boolean }) {
  const set = useMap((s) => s.set);
  const { shade, score, red, water } = metrics(r, fastest, timeMin);
  const isFastest = r.id === fastest.id;
  const pick = r.tags.includes("recommended");
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => (selected ? set({ routeView: "detail" }) : set({ selectedRouteId: r.id }))}
      onKeyDown={(e) => e.key === "Enter" && (selected ? set({ routeView: "detail" }) : set({ selectedRouteId: r.id }))}
      className={`press relative flex items-center gap-3 rounded-[20px] pl-3 pr-2.5 py-2.5 cursor-pointer ${selected ? "bg-white/[0.08]" : "hover:bg-white/[0.04]"}`}
      style={selected ? { boxShadow: `inset 0 0 0 1.5px ${r.color}` } : undefined}
      aria-pressed={selected}
    >
      <RiskRing score={score} size={46} stroke={4} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="grid place-items-center w-[18px] h-[18px] rounded-full text-[10px] font-bold text-ink-950 shrink-0" style={{ background: r.color }}>
            {r.transit ? <Bus size={11} aria-label="Bus" /> : r.label.replace("Route ", "")}
          </span>
          <span className={`text-[12.5px] font-semibold truncate ${pick ? "text-ink-100" : "text-ink-300"}`}>{TAG[r.tags[0]] ?? r.title}</span>
        </div>
        {r.transit ? (
          /* A bus trip is judged on how much of it is on foot and how long the wait
             is, not on the canopy over a street the rider is not standing on. */
          <div className="flex items-center gap-2.5 mt-1 text-[11.5px] text-ink-400 tabular">
            <span className="flex items-center gap-0.5">
              <Footprints size={11} className="text-cool-300" />
              {fmtDist(r.transit.walk_m)}
            </span>
            <span className="flex items-center gap-0.5">
              <Hourglass size={11} className={r.transit.board.shelter ? "text-cool-300" : "text-heat-4"} />
              {Math.round(r.transit.wait_min)} min
            </span>
            <span className="truncate">{r.transit.board.shelter ? "sheltered stop" : "open stop"}</span>
          </div>
        ) : (
        <div className="flex items-center gap-2.5 mt-1 text-[11.5px] text-ink-400 tabular">
          <span className="flex items-center gap-0.5">
            <TreePine size={11} className="text-cool-300" />
            <AnimatedNumber value={shade} suffix="%" />
          </span>
          <span className="flex items-center gap-0.5">
            <Droplets size={11} className="text-sky-glow" />
            {water}
          </span>
          <span className="flex items-center gap-0.5" style={{ color: isFastest ? undefined : red > 0.5 ? "#9dc06a" : "#fca5a5" }}>
            <Sun size={11} className="text-heat-4" />
            {isFastest ? "base" : `${red > 0 ? "−" : "+"}${Math.abs(Math.round(red))}%`}
          </span>
        </div>
        )}
      </div>
      <div className="text-right leading-none shrink-0">
        <div className="text-[22px] font-semibold tracking-[-0.04em] tabular text-ink-100">
          {Math.round(r.duration_min)}
          <span className="text-[11px] font-medium text-ink-400 ml-0.5 tracking-normal">min</span>
        </div>
        <div className="text-[10.5px] text-ink-500 mt-1">{fmtDist(r.distance_m)}</div>
      </div>
      {selected && <ChevronRight size={15} className="text-ink-400 -ml-1 shrink-0" />}
    </div>
  );
}

function Notices({ compare }: { compare: CompareResult }) {
  const set = useMap((s) => s.set);
  const bd = compare.best_departure;
  const rr = compare.simulation?.reroute;
  return (
    <>
      {rr && (rr.suggest_switch || compare.temp_delta_c !== 0) && (
        <div className={`flex items-start gap-2.5 rounded-[18px] px-3.5 py-3 ${rr.suggest_switch ? "bg-heat-4/15" : "bg-white/[0.04]"}`} role="status">
          <TriangleAlert size={15} className={`mt-0.5 shrink-0 ${rr.suggest_switch ? "text-heat-4" : "text-ink-300"}`} />
          <p className="flex-1 text-[12px] text-ink-200 leading-snug">{rr.message}</p>
          {rr.suggest_switch && (
            <button onClick={() => set({ selectedRouteId: rr.recommended_route_id })} className="press h-7 px-2.5 rounded-full bg-heat-4 text-ink-950 text-[11.5px] font-semibold shrink-0">
              Switch
            </button>
          )}
        </div>
      )}
      {bd.offset_min > 0 && bd.improvement >= 3 && (
        <button onClick={() => set({ timeMin: bd.offset_min })} className="press w-full flex items-center gap-2 rounded-[18px] bg-cool-400/10 hover:bg-cool-400/15 px-3.5 h-10 text-[12px] font-medium text-cool-300">
          <Clock3 size={13} /> Leaving at {fmtClock(bd.time)} cuts risk by {Math.round(bd.improvement)}
          <ChevronRight size={13} className="ml-auto" />
        </button>
      )}
    </>
  );
}

/**
 * Route comparison + detail, docked as a compact LEFT sheet on desktop (map stays the hero),
 * and as a slim peek-up bottom sheet on phones.
 */
export default function RouteSheet({ compare, variant }: { compare: CompareResult; variant: "side" | "bottom" }) {
  const selected = useMap((s) => s.selectedRouteId);
  const timeMin = useMap((s) => s.timeMin);
  const view = useMap((s) => s.routeView);
  const open = useMap((s) => s.sheetOpen);
  const set = useMap((s) => s.set);
  const senior = usePrefs((s) => s.seniorMode);
  const persona = personaOf(compare.persona);
  const fastest = compare.routes.reduce((a, b) => (b.duration_min < a.duration_min ? b : a));
  const routes = senior ? compare.routes.filter((r) => r.id === compare.recommended_id) : compare.routes;
  const route = compare.routes.find((r) => r.id === selected);
  const detail = view === "detail" && route;
  const times = compare.routes.map((r) => Math.round(r.duration_min));

  const header = (
    <div className="flex items-center gap-2.5 px-3 h-[52px] shrink-0">
      {detail ? (
        <button onClick={() => set({ routeView: "list" })} className="press grid place-items-center w-8 h-8 rounded-full bg-white/[0.06] hover:bg-white/[0.1] text-ink-200" aria-label="Back to route comparison">
          <ChevronLeft size={16} />
        </button>
      ) : (
        <span className="grid place-items-center w-8 h-8 rounded-full shrink-0 bg-white/[0.08] text-ink-200">
          <persona.icon size={15} />
        </span>
      )}
      <button onClick={() => set({ sheetOpen: !open })} className="flex-1 min-w-0 text-left" aria-expanded={open}>
        <div className="text-[14px] font-semibold tracking-tight text-ink-100 truncate">
          {detail ? `${route.label} · ${TAG[route.tags[0]] ?? route.title}` : `${compare.routes.length} routes · ${Math.min(...times)}–${Math.max(...times)} min`}
        </div>
        <div className="text-[11px] text-ink-400 truncate">
          {detail ? "Updates live with the timeline" : `For ${/^[aeiou]/i.test(persona.label) ? "an" : "a"} ${persona.label.toLowerCase()} · tap a route for details`}
        </div>
      </button>
      <button onClick={() => set({ sheetOpen: !open })} className="press grid place-items-center w-8 h-8 rounded-full hover:bg-white/[0.08] text-ink-400" aria-label={open ? "Collapse routes" : "Expand routes"}>
        <ChevronDown size={16} className={`transition-transform duration-300 ${open ? "" : variant === "side" ? "-rotate-90" : "rotate-180"}`} />
      </button>
    </div>
  );

  if (variant === "side") {
    return (
      <div className={`glass-strong rounded-[26px] flex flex-col w-[340px] overflow-hidden transition-[max-height] duration-500 ${open ? (detail ? "max-h-[calc(100dvh-220px)]" : "max-h-[calc(100dvh-220px)]") : "max-h-[52px]"}`}>
        {header}
        {open && (
          <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-2.5 pb-3 fade-in">
            {detail ? (
              <div className="px-2 pt-1 space-y-2">
                {route.transit ? <TransitLegs plan={route.transit} /> : null}
                <RoutePanel route={route} />
              </div>
            ) : (
              <div className="space-y-1.5">
                {routes.map((r) => (
                  <Row key={r.id} r={r} fastest={fastest} timeMin={timeMin} selected={r.id === selected} />
                ))}
                <div className="space-y-1.5 pt-1">
                  <Notices compare={compare} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── phone: slim peek (route chips) that expands into list / detail ──
  return (
    <div className={`glass-strong rounded-[24px] flex flex-col w-full overflow-hidden transition-[max-height] duration-500 ${open ? "max-h-[62dvh]" : "max-h-[118px]"}`}>
      {header}
      {!open ? (
        <div className="flex gap-2 overflow-x-auto no-scrollbar px-2.5 pb-2.5">
          {routes.map((r) => {
            const { score, shade } = metrics(r, fastest, timeMin);
            const sel = r.id === selected;
            return (
              <button
                key={r.id}
                onClick={() => (sel ? set({ routeView: "detail", sheetOpen: true }) : set({ selectedRouteId: r.id }))}
                className="press shrink-0 flex items-center gap-2 rounded-full pl-1.5 pr-3 h-11"
                style={{ background: sel ? `${r.color}26` : "rgba(255,255,255,.04)", boxShadow: sel ? `inset 0 0 0 1.5px ${r.color}` : "none" }}
              >
                <span className="grid place-items-center w-8 h-8 rounded-full text-[12px] font-bold tabular" style={{ background: `${riskColor(score)}22`, color: riskColor(score) }}>
                  {Math.round(score)}
                </span>
                <span className="text-left leading-tight">
                  <span className="block text-[13px] font-semibold text-ink-100 tabular">
                    {r.label.replace("Route ", "")} · {Math.round(r.duration_min)} min
                  </span>
                  <span className="block text-[10.5px] text-ink-400 tabular">
                    {r.transit ? `${fmtDist(r.transit.walk_m)} walk` : `${Math.round(shade)}% shade`}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-2.5 pb-3">
          {detail ? (
            <div className="px-2 pt-1">
              <RoutePanel route={route} />
            </div>
          ) : (
            <div className="space-y-1.5">
              {routes.map((r) => (
                <Row key={r.id} r={r} fastest={fastest} timeMin={timeMin} selected={r.id === selected} />
              ))}
              <Notices compare={compare} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
