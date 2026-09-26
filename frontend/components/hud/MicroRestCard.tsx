"use client";

import { MapPin, Timer, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useGeo } from "@/lib/geolocation";
import { useMicroRest } from "@/lib/microRest";
import { availableRest, requestRestSchedule, restMinutes, type RestSchedule } from "@/lib/microRestApi";
import { useClock, useMap, usePrefs } from "@/lib/store";

const walkLabel = (min: number) => min < 1 ? "less than a minute away" : `about ${Math.ceil(min)} min away`;
const durationLabel = (min: number) => `${Math.floor(Math.max(0, min))}:${String(Math.floor(Math.max(0, min) * 60) % 60).padStart(2, "0")}`;

export default function MicroRestCard() {
  const persona = usePrefs((s) => s.persona);
  const active = useMicroRest((s) => s.active);
  const hidden = useMicroRest((s) => s.hidden);
  const start = useMicroRest((s) => s.start);
  const finish = useMicroRest((s) => s.finish);
  const now = useClock((s) => s.now);
  const geo = useGeo();
  const origin = useMap((s) => s.origin);
  const startAt = useMap((s) => s.startAt);
  const [wait, setWait] = useState("8");
  const [packet, setPacket] = useState<{ key: string; data?: RestSchedule; error?: string } | null>(null);
  const applies = persona === "gig_worker" || persona === "worker";
  const liveFix = geo.status === "inside";
  const simulated = geo.status === "simulated";
  const inaccurate = liveFix && (geo.accuracyM ?? Infinity) > 80;
  const location = geo.status === "outside" || inaccurate ? null
    : (liveFix || simulated) && geo.lat !== null && geo.lon !== null
      ? { lat: geo.lat, lon: geo.lon, label: simulated ? "Simulated position" : "GPS position" }
      : origin ?? startAt;
  const source = simulated ? "Simulated location" : liveFix ? "GPS location" : "Selected start";
  const lat = location?.lat;
  const lon = location?.lon;
  // Position buckets prevent a GPS tick from triggering a network request.
  const positionKey = lat === undefined || lon === undefined ? "none" : `${Math.round(lat * 110540 / 25)},${Math.round(lon * 105000 / 25)}`;
  const key = `${active?.id}:${persona}:${source}:${positionKey}`;

  useEffect(() => {
    if (!applies || !active || hidden || positionKey === "none") return;
    let dead = false;
    let controller: AbortController | undefined;
    let requestNumber = 0;
    const refresh = async () => {
      if (dead || active.readyAtMs <= Date.now() || document.visibilityState === "hidden") return;
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      const n = ++requestNumber;
      // Read the newest coordinates instead of closing over an earlier GPS fix.
      const fix = useGeo.getState();
      const map = useMap.getState();
      const pos = (fix.status === "inside" || fix.status === "simulated") && fix.lat !== null && fix.lon !== null
        ? { lat: fix.lat, lon: fix.lon } : map.origin ?? map.startAt;
      if (!pos) return;
      try {
        const data = await requestRestSchedule({ origin: pos, pickup: active.pickup,
          ready_at: new Date(active.readyAtMs).toISOString(), persona }, requestController.signal);
        if (!dead && n === requestNumber) setPacket({ key, data });
      } catch (error) {
        if (!dead && n === requestNumber && !requestController.signal.aborted) {
          setPacket({ key, error: error instanceof Error ? error.message : "Rest suggestions are temporarily unavailable." });
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    const onVisible = () => { useClock.getState().tick(); void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { dead = true; controller?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [active, applies, hidden, key, persona, positionKey]);

  if (!applies) return null;
  if (hidden) return <button className="glass rounded-full px-3 py-2 text-[11px] text-cool-300" onClick={() => useMicroRest.getState().show()}>Micro-rest{active ? " · show countdown" : ""}</button>;
  const remaining = active ? Math.max(0, (active.readyAtMs - now) / 60000) : 0;
  const shown = packet?.key === key ? packet : null;
  const expired = active !== null && remaining <= 0;
  const stale = shown?.data ? now - Date.parse(shown.data.calculated_at) > 45000 : false;
  const point = !expired && !stale && location && shown?.data ? availableRest(shown.data, now) : null;
  const rest = point ? restMinutes(point, remaining) : 0;
  const validWait = Number.isFinite(Number(wait)) && Number(wait) >= 1 && Number(wait) <= 60;
  const goToPoint = () => {
    if (!point) return;
    useMap.getState().set({ mode: "map", flyTo: { lat: point.lat, lon: point.lon, zoom: 18.5, nonce: now } });
  };

  return (
    <div className="glass-strong rounded-[22px] px-3.5 py-3 w-[min(340px,calc(100vw-28px))] pop-in" aria-label="Micro-rest scheduler">
      <div className="flex items-start gap-2.5">
        <span className="grid place-items-center w-8 h-8 rounded-full shrink-0 bg-pink-500/15 text-pink-300"><Timer size={15} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-[10.5px] font-bold uppercase tracking-wider text-cool-400 mb-1">Micro-rest · live scheduling</div>
          {!active ? (
            <>
              <p className="text-[12px] text-ink-200 leading-snug">Waiting for pickup? Find a rest stop that fits a return trip.</p>
              <form className="flex items-center gap-2 mt-2" onSubmit={(e) => { e.preventDefault(); if (location && validWait) start(Number(wait), location); }}>
                <label className="text-[11px] text-ink-300" htmlFor="pickup-wait">Wait (min)</label>
                <input id="pickup-wait" aria-label="Pickup wait in minutes" type="number" min="1" max="60" step="1" value={wait} onChange={(e) => setWait(e.target.value)} className="w-14 rounded-lg bg-white/10 px-2 py-1.5 text-[12px] text-ink-100" />
                <button type="submit" disabled={!location || !validWait} className="rounded-full bg-cool-400/15 text-cool-300 px-3 py-1.5 text-[11px] font-semibold disabled:opacity-40">Find a stop</button>
              </form>
              <p className="text-[10px] text-ink-400 mt-1.5">{location ? `${source} is the pickup point · wait entered by you` : inaccurate ? "GPS accuracy is low. Wait for a better location fix." : "Choose a pickup point inside the twin zone first."}</p>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 mb-1"><span className="text-[11px] text-ink-300">Pickup wait remaining</span><span className="font-mono text-[13px] text-ink-100" aria-label="Pickup countdown">{durationLabel(remaining)}</span></div>
              <p className="text-[13px] text-ink-100 leading-snug">
                {expired ? "Pickup time reached — return to your pickup point." : !location ? "Location unavailable or inaccurate — rest advice is paused." : shown?.error ? shown.error : stale ? "Refreshing the estimate — stay near pickup until it updates." : !shown?.data ? "Checking nearby mapped stops and the return trip…" : point ? <><strong>{point.name}</strong> is {walkLabel(point.outbound_min)} on foot, with {point.amenities.join(" + ")}. Rest ~{rest.toFixed(1)} min; estimated return before pickup.</> : "No new rest detour fits the remaining time with a return buffer. Stay near or return to pickup."}
              </p>
              {point && <>
                <div className="flex gap-0.5 h-1.5 rounded-full overflow-hidden mt-2" aria-label="Walk, rest, return and buffer time">
                  {[{ min: point.outbound_min, color: "#8ebcdd" }, { min: rest, color: "#8ad8b0" }, { min: point.return_min, color: "#8ebcdd" }, { min: point.buffer_min, color: "#e8c876" }].map((p, i) => <span key={i} style={{ flex: p.min || .01, background: p.color }} />)}
                </div>
                <p className="text-[10px] text-ink-300 mt-1">Walk {point.outbound_min.toFixed(1)} min · rest {rest.toFixed(1)} · back {point.return_min.toFixed(1)} · buffer 1</p>
                <p className="text-[11px] text-cool-300 mt-1">Leave stop by {new Date(point.leave_by).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} · {point.feels_c.toFixed(1)}°C feels-like</p>
                <button onClick={goToPoint} className="inline-flex items-center gap-1 text-[11px] text-cool-300 mt-2"><MapPin size={12} />Show stop on map</button>
                <p className="text-[10px] text-ink-400 mt-1">{point.hours_status} · confirm on arrival</p>
              </>}
              <p className="text-[10px] text-ink-400 mt-1.5">{source} · wait entered by you · walking ETA estimated{shown?.data?.weather_source === "climatology_fallback" ? " · weather fallback" : ""}</p>
              <button onClick={finish} className="text-[11px] text-ink-200 underline underline-offset-2 mt-2">{expired ? "Start another wait" : "Pickup ready / end wait"}</button>
            </>
          )}
        </div>
        <button onClick={() => useMicroRest.getState().dismiss()} className="press grid place-items-center w-6 h-6 rounded-full hover:bg-white/10 text-ink-400 shrink-0" aria-label="Hide micro-rest"><X size={12} /></button>
      </div>
    </div>
  );
}
