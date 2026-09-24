"use client";

import { Crosshair, Footprints, LocateFixed, Map as MapIcon, Square } from "lucide-react";
import { useEffect, useState } from "react";
import {
  isSimulating,
  startSimulation,
  startWatch,
  stopSimulation,
  stopWatch,
  useGeo,
} from "@/lib/geolocation";
import { useMeta } from "@/lib/hooks";
import { useMap } from "@/lib/store";

/**
 * "Start from where I am", and progressive reveal as the user moves.
 *
 * The twin only covers ~4 km² around the BSCOER campus, so a real fix from anywhere
 * else is a legitimate outcome that has to be said out loud rather than swallowed —
 * hence the explicit `outside` state and the offer to walk the campus instead.
 */
export default function MyLocation({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const meta = useMeta();
  const status = useGeo((s) => s.status);
  const lat = useGeo((s) => s.lat);
  const lon = useGeo((s) => s.lon);
  const accuracyM = useGeo((s) => s.accuracyM);
  const error = useGeo((s) => s.error);
  const revealOn = useMap((s) => s.revealOn);
  const set = useMap((s) => s.set);

  const bbox = meta.data?.zone.bbox;
  const centre = meta.data?.zone.center;
  const live = status === "inside" || status === "outside" || status === "simulated";

  useEffect(() => () => stopSimulation(), []);

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

  const stopAll = () => {
    stopWatch();
    stopSimulation();
    useGeo.getState().set({ status: "idle" });
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

  return (
    <div className="relative">
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div
            className={`glass-strong absolute right-0 z-20 w-[300px] ${compact ? "top-full mt-3" : "bottom-full mb-3"} rounded-[26px] p-4 pop-in`}
            role="dialog"
            aria-label="My location"
          >
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

            {status === "outside" && (
              <div
                className="mt-3 rounded-2xl px-3 py-2 text-[11.5px] leading-snug"
                style={{ background: "rgba(251,138,31,.12)", color: "#ffc48a" }}
              >
                You are outside the modelled zone, so there is no twin data where you are standing.
                HeatMind only covers ~4 km² around TSSM BSCOER, Narhe.
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
              {live && (
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
        onClick={() => setOpen((o) => !o)}
        className={`press glass flex items-center justify-center gap-2 rounded-full text-[14px] font-semibold ${compact ? "w-11 h-11" : "h-12 pl-3.5 pr-4"} ${live ? "glow-pulse" : ""}`}
        aria-label="Use my location"
        aria-expanded={open}
        style={
          live
            ? { background: "linear-gradient(135deg, rgba(52,226,198,.95), rgba(76,195,255,.9))", color: "#04140f" }
            : undefined
        }
      >
        <LocateFixed size={16} className={live ? "" : "text-ink-200"} />
        {compact ? null : label[status] ?? "Use my location"}
      </button>
    </div>
  );
}

export { isSimulating };
