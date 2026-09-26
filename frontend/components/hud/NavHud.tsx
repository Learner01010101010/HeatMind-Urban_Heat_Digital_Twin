"use client";

import {
  ArrowUp, Bus, CornerUpLeft, CornerUpRight, Footprints, Hourglass, MapPin,
  Navigation, RotateCcw, Sun, TriangleAlert, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Route, RouteStep } from "@/lib/api";
import { fmtDist } from "@/lib/heatColorScale";
import { advance, cumulative, stepAt, stopNavigation, toStepScale, useNav } from "@/lib/navigation";
import { useMap } from "@/lib/store";

/** Maneuver → glyph. Slight and sharp turns reuse the corner arrows, rotated by CSS. */
function ManeuverIcon({ step, size = 30 }: { step: RouteStep; size?: number }) {
  const m = step.maneuver;
  if (m === "walk") return <Footprints size={size} />;
  if (m === "wait") return <Hourglass size={size} />;
  if (m === "ride") return <Bus size={size} />;
  if (m === "uturn") return <RotateCcw size={size} />;
  if (m === "depart") return <Navigation size={size} />;
  if (step.arrival) return <MapPin size={size} />;
  if (m.endsWith("left")) {
    return <CornerUpLeft size={size} className={m.startsWith("slight") ? "-rotate-[18deg]" : ""} />;
  }
  if (m.endsWith("right")) {
    return <CornerUpRight size={size} className={m.startsWith("slight") ? "rotate-[18deg]" : ""} />;
  }
  return <ArrowUp size={size} />;
}

/** Round the way a navigation app does: precise up close, coarse far away. */
function callout(metres: number): string {
  if (metres < 15) return "Now";
  if (metres < 100) return `${Math.round(metres / 10) * 10} m`;
  if (metres < 1000) return `${Math.round(metres / 50) * 50} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/**
 * Turn-by-turn guidance, in the shape people already know: the next maneuver large
 * at the top, the one after it underneath, and arrival facts along the bottom.
 *
 * The addition is the sun. The step carries its own exposure, so the HUD can warn
 * that the next stretch is in full sun *before* the walker is standing in it — which
 * is the only moment the warning is any use, and the reason this route was chosen
 * over the faster one in the first place.
 */
export default function NavHud({ route }: { route: Route }) {
  const active = useNav((s) => s.active);
  const progressM = useNav((s) => s.progressM);
  const live = useNav((s) => s.live);
  const offRouteM = useNav((s) => s.offRouteM);
  const simSpeed = useNav((s) => s.simSpeed);
  const [now, setNow] = useState(() => Date.now());
  const raf = useRef(0);
  const last = useRef(0);

  const geometry = route.geometry;
  // Derived from the geometry, so it is memoised rather than stashed in a ref:
  // a ref written during render is not a cache, it is a value React is free to
  // discard or read at the wrong time.
  const cum = useMemo(() => cumulative(geometry), [geometry]);

  // One animation loop drives progress; the store is the single source the map and
  // this panel both read, so the camera and the instruction can never disagree.
  useEffect(() => {
    if (!active) return;
    last.current = performance.now();
    const tick = (t: number) => {
      const dt = Math.min(0.25, (t - last.current) / 1000);
      last.current = t;
      advance(route, geometry, cum, dt);
      setNow(Date.now());
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [active, route, geometry, cum]);

  if (!active) return null;

  const total = cum[cum.length - 1] ?? route.distance_m;
  const remainingM = Math.max(0, total - progressM);
  // Step boundaries are on the router's own ruler, not the polyline's — see
  // toStepScale for why those differ and what it costs to ignore it.
  const cur = stepAt(route.steps, toStepScale(progressM, total, route.distance_m));
  const next = cur && route.steps[cur.index + 1] ? route.steps[cur.index + 1] : null;
  const arrived = remainingM < 12;

  // Remaining time from the route's own pace, so the ETA agrees with the plan the
  // heat model produced rather than with a generic speed.
  const speedMs = ((route.speed_kmh ?? 5) * 1000) / 3600;
  const remainingMin = remainingM / speedMs / 60;
  const eta = new Date(now + remainingMin * 60_000);
  const hotNext = next && next.exposure > 0.55;

  return (
    <div className="glass-strong rounded-[26px] overflow-hidden w-full max-w-[420px] pointer-events-auto">
      {/* ── the instruction ── */}
      <div className="flex items-center gap-3.5 p-4 pb-3">
        <span className="grid place-items-center w-14 h-14 rounded-2xl bg-white/[0.1] text-ink-100 shrink-0">
          {arrived ? <MapPin size={30} /> : cur ? <ManeuverIcon step={cur.step} /> : <ArrowUp size={30} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[26px] font-semibold tracking-[-0.04em] text-ink-100 tabular leading-none">
            {arrived ? "Arrived" : callout(cur?.toEndM ?? 0)}
          </div>
          <div className="text-[13px] text-ink-300 mt-1.5 truncate">
            {arrived ? "You have reached your destination" : (cur?.step.instruction ?? "")}
          </div>
        </div>
      </div>

      {/* ── what comes after, and whether it is in the sun ── */}
      {!arrived && next && (
        <div className="flex items-center gap-2.5 px-4 py-2 border-t border-white/[0.06] text-[12px]">
          <span className="text-ink-500 shrink-0">Then</span>
          <span className="text-ink-400 shrink-0">
            <ManeuverIcon step={next} size={14} />
          </span>
          <span className="text-ink-300 truncate flex-1">{next.road}</span>
          {hotNext && (
            <span className="flex items-center gap-1 text-heat-4 shrink-0" title="That stretch is in direct sun">
              <Sun size={12} aria-hidden />
              full sun
            </span>
          )}
        </div>
      )}

      {/* ── off-route / preview notice ── */}
      {offRouteM > 45 && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-white/[0.06] text-[11.5px] text-amber-200">
          <TriangleAlert size={12} className="shrink-0" aria-hidden />
          {/* Said rather than silently corrected: snapping a 200 m fix onto the line
              would teleport the camera and claim progress that did not happen. */}
          <span>You are about {fmtDist(offRouteM)} off the planned route.</span>
        </div>
      )}

      {/* ── arrival facts ── */}
      <div className="flex items-center gap-4 px-4 py-2.5 border-t border-white/[0.06]">
        <div className="leading-none">
          <div className="text-[17px] font-semibold text-ink-100 tabular">{Math.max(0, Math.round(remainingMin))} min</div>
          <div className="text-[10.5px] text-ink-500 mt-1">{fmtDist(remainingM)} left</div>
        </div>
        <div className="leading-none">
          <div className="text-[17px] font-semibold text-ink-100 tabular" suppressHydrationWarning>
            {eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </div>
          <div className="text-[10.5px] text-ink-500 mt-1">arrival</div>
        </div>
        <div className="flex-1 min-w-0 text-right">
          <div className={`text-[10.5px] ${live ? "text-emerald-300" : "text-ink-500"}`}>
            {live ? "Following your position" : `Simulated · ${route.speed_kmh ?? 5} km/h`}
          </div>
          {/* Playback rate, only while the walk is simulated. A real trip moves at
              the speed the body is moving and this has nothing to offer it; a demo
              in front of a room cannot wait fifty minutes for a fifty-minute route. */}
          {!live && (
            <div className="flex items-center gap-1 justify-end mt-1">
              {[1, 4, 12].map((x) => (
                <button
                  key={x}
                  onClick={() => useNav.getState().set({ simSpeed: x })}
                  className={`press px-1.5 h-5 rounded-full text-[10px] font-bold tabular ${
                    simSpeed === x ? "bg-white/[0.16] text-ink-100" : "text-ink-500 hover:text-ink-300"
                  }`}
                  aria-label={`Play the simulation at ${x} times speed`}
                >
                  {x}×
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={stopNavigation}
          className="press grid place-items-center w-9 h-9 rounded-full bg-white/[0.08] hover:bg-white/[0.14] text-ink-200 shrink-0"
          aria-label="End navigation"
        >
          <X size={16} />
        </button>
      </div>

      {/* ── progress ── */}
      <div className="h-1 bg-white/[0.06]">
        <div
          className="h-full transition-[width] duration-200"
          style={{ width: `${total > 0 ? Math.min(100, (progressM / total) * 100) : 0}%`, background: route.color }}
        />
      </div>
    </div>
  );
}

/** The button that starts guidance. Placed with the route, not with the view controls. */
export function StartNavButton({ route }: { route: Route }) {
  const active = useNav((s) => s.active);
  const set = useMap((s) => s.set);
  if (active) return null;
  return (
    <button
      onClick={() => {
        // Guidance is a 3D experience: the shadows the route was chosen for are only
        // legible from street level, so entering the twin is part of starting.
        set({ mode: "twin" });
        import("@/lib/navigation").then((m) => m.startNavigation(route));
      }}
      className="press flex items-center gap-2 rounded-full h-11 px-5 font-semibold text-[13.5px] text-ink-950"
      style={{ background: route.color }}
    >
      <Navigation size={16} />
      Start
    </button>
  );
}
