"use client";

import { Crosshair, Footprints, LocateFixed, Map as MapIcon, Navigation, Square, X } from "lucide-react";
import {
  isSimulating,
  startSimulation,
  startWatch,
  stopSimulation,
  stopWatch,
  useGeo,
} from "@/lib/geolocation";
import { useMeta } from "@/lib/hooks";
import { startNavigation, stopNavigation, useNav } from "@/lib/navigation";
import { useMap } from "@/lib/store";

/**
 * "Start from where I am", and progressive reveal as the user moves.
 *
 * The twin covers the Narhe-to-Swargate corridor, so a real fix from anywhere
 * else is a legitimate outcome that has to be said out loud rather than swallowed —
 * hence the explicit `outside` state and the offer to walk the campus instead.
 */
export default function MyLocation({ compact = false }: { compact?: boolean }) {
  const open = useMap((s) => s.locationPanelOpen);
  const setOpen = (v: boolean) => useMap.getState().set({ locationPanelOpen: v });
  const meta = useMeta();
  const status = useGeo((s) => s.status);
  const lat = useGeo((s) => s.lat);
  const lon = useGeo((s) => s.lon);
  const accuracyM = useGeo((s) => s.accuracyM);
  const error = useGeo((s) => s.error);
  const revealOn = useMap((s) => s.revealOn);
  const compare = useMap((s) => s.compare);
  const selectedRouteId = useMap((s) => s.selectedRouteId);
  const set = useMap((s) => s.set);
  const navActive = useNav((s) => s.active);
  const navRouteId = useNav((s) => s.routeId);
  const progressM = useNav((s) => Math.floor(s.progressM));
  const mode = useMap((s) => s.mode);
  const simSpeed = useNav((s) => s.simSpeed);

  // The route the trip simulation would run: whichever is selected, else the first.
  const route = compare?.routes.find((r) => r.id === selectedRouteId) ?? compare?.routes[0] ?? null;
  const navRoute = compare?.routes.find((r) => r.id === navRouteId) ?? null;
  const tripRunning = navActive && !!navRoute;
  /** Anything fabricating a position: the trip run, or the campus walker. */
  const simRunning = tripRunning || status === "simulated";
  const tripPct = tripRunning && navRoute.distance_m > 0
    ? Math.min(100, (progressM / navRoute.distance_m) * 100)
    : 0;

  const bbox = meta.data?.zone.bbox;
  const centre = meta.data?.zone.center;
  const live = status === "inside" || status === "outside" || status === "simulated";

  const locate = () => {
    if (!bbox) return;
    set({ revealOn: true });
    startWatch(bbox);
  };

  const walkDemo = () => {
    if (!centre) return;
    set({ revealOn: true });
    // start a little south-west of the campus centre so the walk crosses it
    startSimulation(centre[0] - 0.0035, centre[1] - 0.004);
    set({ flyTo: { lat: centre[0] - 0.0035, lon: centre[1] - 0.004, zoom: 17.2, nonce: Date.now() } });
  };

  /**
   * Run the planned trip as if the user were making it.
   *
   * Not the campus walker: that one strolls in a straight line from a fixed point
   * and has nothing to do with the route on screen. This drives the real guidance
   * loop along the selected route at the selected mode's own speed, writing the
   * position as it goes, so the arrow, the chase camera, the corridor reveal and the
   * turn instructions all behave exactly as they would on the street. It runs to the
   * end of the route and stops there.
   */
  const runTrip = () => {
    if (!route) return;
    set({ revealOn: true, selectedRouteId: route.id });
    startNavigation(route, { simulate: true });
    setOpen(false);
  };

  /**
   * Cancel whatever is pretending to be a position, whatever started it.
   *
   * One control for all three sources — the real watch, the campus walker and the
   * trip simulation — because from the user's side they are one thing: something
   * else is driving the blue dot and they want it to stop. stopNavigation hands the
   * position back rather than leaving a fabricated fix behind, and clearing the
   * status returns this panel to its opening state.
   */
  const stopAll = () => {
    stopNavigation();
    stopWatch();
    stopSimulation();
    useGeo.getState().set({ status: "idle", lat: null, lon: null, headingDeg: null, accuracyM: null });
  };

  const label: Record<string, string> = {
    idle: "Use my location",
    locating: "Locating…",
    inside: "Following you",
    outside: "Outside the twin",
    denied: "Location declined",
    unavailable: "Location unavailable",
    simulated: "Simulated walk",
  };
  const pillLabel = tripRunning ? "Simulated trip" : (label[status] ?? "Use my location");

  return (
    <div className="relative">
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div
            className={`glass-strong z-20 rounded-[26px] p-4 pop-in ${compact ? "fixed top-[72px] right-[76px] w-[min(300px,calc(100vw-100px))] max-h-[calc(100dvh-140px)] overflow-y-auto" : "absolute right-0 bottom-full mb-3 w-[300px]"}`}
            role="dialog"
            aria-label="My location"
          >
            {/* Two states, not one list with things greyed out. While something is
                driving the position the only question worth answering is "what is
                running and how do I stop it"; the ways to start are noise until it
                is. Cancelling clears the status, which brings this straight back. */}
            {simRunning ? (
              <>
                <div className="text-[15px] font-semibold text-ink-100 tracking-tight mb-1">
                  {tripRunning ? "Running the trip" : "Simulated walk"}
                </div>
                <p className="text-[12px] text-ink-400 mb-3 leading-snug">
                  {tripRunning
                    ? `Moving along ${navRoute.label} at ${navRoute.speed_kmh ?? "—"} km/h${simSpeed > 1 ? ` · ${simSpeed}× playback` : ""}. This is a simulated position, not a fix.`
                    : "A simulated pedestrian is walking the campus. This is not a real position."}
                </p>

                {tripRunning && (
                  <div className="mb-3">
                    <div className="h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
                      <div
                        className="h-full rounded-full transition-[width] duration-300"
                        style={{ width: `${tripPct}%`, background: navRoute.color }}
                      />
                    </div>
                    <div className="flex justify-between text-[10.5px] text-ink-400 mt-1 tabular">
                      <span>{(progressM / 1000).toFixed(2)} km</span>
                      <span>
                        {tripPct >= 99.5
                          ? "arrived"
                          : `${Math.max(0, (navRoute.distance_m - progressM) / 1000).toFixed(2)} km to go`}
                      </span>
                    </div>
                  </div>
                )}

                <button
                  onClick={stopAll}
                  className="press hm-sos flex items-center justify-center gap-2 w-full h-11 rounded-full text-[13.5px] font-semibold"
                >
                  <X size={16} />
                  Cancel the simulation
                </button>
              </>
            ) : (
              <>
                <div className="text-[15px] font-semibold text-ink-100 tracking-tight mb-1">Start from where I am</div>
                <p className="text-[12px] text-ink-400 mb-3 leading-snug">
                  Your position becomes the trip origin, and the twin renders only the ground you have
                  covered — the street ahead resolves as you reach it.
                </p>

                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={locate}
                    className="press flex items-center gap-2.5 rounded-2xl bg-white/[0.05] hover:bg-white/[0.09] px-3 py-2.5 text-left"
                  >
                    <LocateFixed size={16} className="text-cool-400" />
                    <span className="flex-1 min-w-0">
                      <div className="text-[13px] font-semibold text-ink-100">Use my real location</div>
                      <div className="text-[10.5px] text-ink-400 leading-tight">Needs location permission</div>
                    </span>
                  </button>

                  {/* The one a jury should see: the actual planned trip, moving. */}
                  <button
                    onClick={runTrip}
                    disabled={!route}
                    className="press flex items-center gap-2.5 rounded-2xl px-3 py-2.5 text-left disabled:opacity-45 bg-white/[0.05] hover:bg-white/[0.09] disabled:hover:bg-white/[0.05]"
                  >
                    <Navigation size={16} style={{ color: route?.color ?? "#6fbf5e" }} />
                    <span className="flex-1 min-w-0">
                      <div className="text-[13px] font-semibold text-ink-100">
                        Run the planned trip in {mode === "twin" ? "3D" : "2D"}
                      </div>
                      <div className="text-[10.5px] text-ink-400 leading-tight">
                        {route
                          ? `${route.label} · ${route.speed_kmh ?? "—"} km/h by ${route.mode_label?.toLowerCase() ?? "foot"}, to the destination`
                          : "Plan a route first — this follows the one on screen"}
                      </div>
                    </span>
                  </button>

                  <button
                    onClick={walkDemo}
                    className="press flex items-center gap-2.5 rounded-2xl bg-white/[0.05] hover:bg-white/[0.09] px-3 py-2.5 text-left"
                  >
                    <Footprints size={16} className="text-cool-400" />
                    <span className="flex-1 min-w-0">
                      <div className="text-[13px] font-semibold text-ink-100">Walk the campus (simulated)</div>
                      <div className="text-[10.5px] text-ink-400 leading-tight">
                        1.4 m/s pedestrian, for demoing away from Narhe
                      </div>
                    </span>
                  </button>
                </div>
              </>
            )}

            {status === "outside" && (
              <div
                className="mt-3 rounded-2xl px-3 py-2 text-[11.5px] leading-snug"
                style={{ background: "rgba(251,138,31,.12)", color: "#ffc48a" }}
              >
                You are outside the modelled zone, so there is no twin data where you are standing.
                HeatMind covers south Pune, from Narhe up to Swargate.
                {centre && (
                  <button
                    onClick={() => set({ flyTo: { lat: centre[0], lon: centre[1], zoom: 16, nonce: Date.now() } })}
                    className="press mt-1.5 block underline"
                  >
                    Jump to the campus instead
                  </button>
                )}
              </div>
            )}

            {(status === "denied" || status === "unavailable") && (
              <div
                className="mt-3 rounded-2xl px-3 py-2 text-[11.5px] leading-snug"
                style={{ background: "rgba(239,68,68,.12)", color: "#ffb4b4" }}
              >
                {error ?? "No position available."} The simulated walk works without permission.
              </div>
            )}

            {live && lat !== null && lon !== null && (
              <div className="mt-3 pt-3 border-t border-white/10 text-[11.5px] text-ink-300 flex items-center gap-2">
                <Crosshair size={12} className="text-ink-400" />
                <span className="tabular">
                  {lat.toFixed(5)}, {lon.toFixed(5)}
                </span>
                {accuracyM !== null && <span className="text-ink-500">±{Math.round(accuracyM)} m</span>}
                {status === "simulated" && <span className="text-cool-400 ml-auto">simulated</span>}
              </div>
            )}

            <div className="mt-3 pt-3 border-t border-white/10 flex items-center gap-2">
              <button
                onClick={() => set({ revealOn: !revealOn })}
                className="press flex-1 flex items-center justify-center gap-1.5 h-9 rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-[12px] font-semibold text-ink-200"
              >
                <MapIcon size={13} />
                {revealOn ? "Show whole zone" : "Reveal as I move"}
              </button>
              {/* Only for a real watch — a simulation has the full Cancel above it. */}
              {live && !simRunning && (
                <button
                  onClick={stopAll}
                  className="press grid place-items-center w-9 h-9 rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-ink-200"
                  aria-label="Stop following"
                >
                  <Square size={12} fill="currentColor" />
                </button>
              )}
            </div>
          </div>
        </>
      )}

      <button
        onClick={() => setOpen(!open)}
        className={`press flex items-center justify-center gap-2 rounded-full text-[14px] font-semibold ${compact ? "w-11 h-11" : "glass h-12 pl-3.5 pr-4"} ${live ? "glow-pulse" : ""}`}
        aria-label="Use my location"
        aria-expanded={open}
        style={
          live
            ? { background: "linear-gradient(135deg, rgba(111,191,94,.95), rgba(157,192,106,.9))", color: "#04140f" }
            : undefined
        }
      >
        <LocateFixed size={16} className={live ? "" : "text-ink-200"} />
        {compact ? null : pillLabel}
      </button>
    </div>
  );
}

export { isSimulating };
