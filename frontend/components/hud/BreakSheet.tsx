"use client";

import { Droplets, MapPin, Sun, Thermometer, TreePine, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type NearbyPhotos } from "@/lib/api";
import { fmtTemp, heatColor } from "@/lib/heatColorScale";
import { useMap, usePrefs } from "@/lib/store";

/**
 * One hydration or rest stop, opened from its pin on the map.
 *
 * About the picture: there is no photograph of most of these places to show. OSM
 * carries seven image tags across the whole zone, and Google's terms do not permit
 * using Street View this way. So the panel asks the backend for street-level imagery
 * — Mapillary, when a token is configured there — and when there is none it flies
 * the twin to the spot instead. That view is not a stock photo: it is this location
 * built from measured building heights and measured canopy, lit by the real sun for
 * the time you will arrive, which is the thing you actually want to know before
 * deciding whether to stop there.
 */
export default function BreakSheet() {
  const stop = useMap((s) => s.selectedBreak);
  const set = useMap((s) => s.set);
  const units = usePrefs((s) => s.units);
  // Tagged with the stop it was fetched for, rather than cleared at the top of the
  // effect: clearing it there is a synchronous setState inside an effect, which
  // cascades a render. Comparing keys means a stale result for the previous pin is
  // simply not shown.
  const [photos, setPhotos] = useState<{ key: string; data: NearbyPhotos } | null>(null);
  const key = stop ? `${stop.lat},${stop.lon},${stop.at_m}` : "";
  const lat = stop?.lat ?? null;
  const lon = stop?.lon ?? null;

  useEffect(() => {
    if (lat === null || lon === null) return;
    let dead = false;
    api.photosNearby({ lat, lon })
      .then((r) => !dead && setPhotos({ key, data: r }))
      .catch(() => !dead && setPhotos({ key, data: { available: false, reason: "provider_error", photos: [] } }));
    return () => {
      dead = true;
    };
  }, [key, lat, lon]);

  if (!stop) return null;
  const shown = photos && photos.key === key ? photos.data : null;

  const close = () => set({ selectedBreak: null });
  const showInTwin = () => {
    if (stop.lat === null || stop.lon === null) return;
    set({
      mode: "twin",
      flyTo: { lat: stop.lat, lon: stop.lon, zoom: 18.2, nonce: Date.now() },
      selectedBreak: null,
    });
  };

  const eta = new Date(stop.eta);
  const sunny = stop.exposure > 0.6;
  const isRest = stop.type === "rest";

  return (
    <div className="fixed inset-0 z-[70] grid place-items-end sm:place-items-center p-3 pointer-events-none">
      <div className="fixed inset-0 bg-black/40" onClick={close} aria-hidden />
      <div
        className="glass-strong pointer-events-auto relative w-full sm:w-[360px] max-h-[86dvh] overflow-y-auto rounded-[26px] p-4 pop-in"
        role="dialog"
        aria-label="Stop details"
      >
        <div className="flex items-start justify-between gap-2 mb-2">
          <div>
            <div className="text-[10.5px] font-bold uppercase tracking-wider text-cool-400">
              {isRest ? "Rest stop" : stop.type === "water+rest" ? "Drink & rest" : "Water stop"}
              {" · "}
              {(stop.at_m / 1000).toFixed(1)} km in
            </div>
            <div className="text-[17px] font-semibold text-ink-100 tracking-tight leading-tight">
              {stop.poi?.name || (stop.has_source ? "Mapped stop" : "No water source here")}
            </div>
          </div>
          <button onClick={close} className="press grid place-items-center w-7 h-7 rounded-full hover:bg-white/10 text-ink-300 shrink-0" aria-label="Close">
            <X size={14} />
          </button>
        </div>

        {/* what it looks like */}
        <div className="rounded-[18px] overflow-hidden bg-white/[0.04] mb-3">
          {shown?.available && shown.photos[0] ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={shown.photos[0].url} alt={`Street view near ${stop.poi?.name ?? "this stop"}`} className="w-full h-[168px] object-cover" />
              <div className="px-3 py-1.5 text-[10px] text-ink-500">{shown.attribution}</div>
            </>
          ) : (
            <button onClick={showInTwin} className="press w-full h-[168px] grid place-items-center text-center px-5 hover:bg-white/[0.03]">
              <span>
                <MapPin size={20} className="text-cool-400 mx-auto mb-2" />
                <span className="block text-[13px] font-semibold text-ink-100">See this spot in the twin</span>
                <span className="block text-[11px] text-ink-400 mt-1 leading-snug">
                  {shown === null
                    ? "Checking for a street-level photo…"
                    : shown.reason === "no_provider"
                      ? "No photo provider is configured, so here is the modelled street instead — real building heights, real canopy, real shade."
                      : "No street-level photo covers this spot. The twin shows it from measured buildings and canopy."}
                </span>
              </span>
            </button>
          )}
        </div>

        {/* why here */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          <Stat icon={<Thermometer size={13} />} label="Feels" value={fmtTemp(stop.feels_c, units)} color={heatColor(stop.feels_c)} />
          <Stat icon={sunny ? <Sun size={13} /> : <TreePine size={13} />} label={sunny ? "Full sun" : stop.exposure > 0.3 ? "Part shade" : "Shaded"} value={`${Math.round(stop.exposure * 100)}%`} />
          <Stat
            icon={<Droplets size={13} />}
            label={isRest ? "Rest" : "Drink"}
            value={isRest ? `${stop.rest_min} min` : `${stop.fluid_ml} ml`}
          />
        </div>

        <p className="text-[12.5px] text-ink-200 leading-snug mb-2">{stop.advice}</p>
        <p className="text-[11.5px] text-ink-400 leading-snug">{stop.why}</p>

        <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between text-[11.5px] text-ink-300">
          <span className="tabular">
            Arrive ~{eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            <span className="text-ink-500"> · t+{Math.round(stop.eta_min)} min</span>
          </span>
          {stop.poi && (
            <span className="text-ink-500">
              {stop.poi.off_route_m} m off route
            </span>
          )}
        </div>

        {!stop.has_source && (
          <div className="mt-3 rounded-2xl px-3 py-2 text-[11.5px] leading-snug" style={{ background: "rgba(251,138,31,.12)", color: "#ffc48a" }}>
            Nothing is mapped within 130 m of here. That is not a gap in the app — it
            is a gap in the street. Carry water for this stretch.
          </div>
        )}

        {stop.poi?.water_kind === "buy" && (
          <div className="mt-2 text-[11px] text-ink-500 leading-snug">
            This is a shop or café rather than a public tap — you will need to buy a bottle.
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color?: string }) {
  return (
    <div className="rounded-2xl bg-white/[0.05] px-2.5 py-2">
      <div className="flex items-center gap-1 text-ink-400 mb-0.5">
        {icon}
        <span className="text-[9.5px] uppercase tracking-wide truncate">{label}</span>
      </div>
      <div className="text-[15px] font-semibold tabular" style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  );
}
