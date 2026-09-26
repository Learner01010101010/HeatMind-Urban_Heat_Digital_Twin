"use client";

import { useEffect } from "react";
import { useGeo } from "@/lib/geolocation";
import { useNav } from "@/lib/navigation";
import { useMap } from "@/lib/store";
import { cancelLiveCheck, capturePosition, checkLiveRoute } from "@/lib/liveRouting";
import { useRouteEngine } from "@/lib/routeEngineState";

/** Stays mounted when the comparison sheet gives way to turn-by-turn guidance. */
export default function LiveRouteMonitor() {
  const enabled = useRouteEngine((s) => s.enabled);
  useEffect(() => {
    if (!enabled) { cancelLiveCheck(); return; }
    capturePosition();
    const tick = () => { if (document.visibilityState === "visible") void checkLiveRoute(); };
    const timer = setInterval(tick, 60_000);
    const stopGeo = useGeo.subscribe((fix) => {
      capturePosition();
      if (fix.status === "inside" && useNav.getState().active) void checkLiveRoute("off_route");
    });
    const stopNav = useNav.subscribe((state, previous) => {
      if (state.active && !previous.active) void checkLiveRoute();
    });
    const stopMap = useMap.subscribe((state, previous) => {
      if (state.compare !== previous.compare && state.compare?.route_engine) {
        useRouteEngine.getState().set({ objective: state.compare.route_engine.objective });
      }
    });
    document.addEventListener("visibilitychange", tick);
    tick();
    return () => { clearInterval(timer); stopGeo(); stopNav(); stopMap(); document.removeEventListener("visibilitychange", tick); cancelLiveCheck(); };
  }, [enabled]);
  return null;
}
