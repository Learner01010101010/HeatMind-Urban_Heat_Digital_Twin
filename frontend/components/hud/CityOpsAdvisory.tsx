"use client";

import { useState, useSyncExternalStore } from "react";
import { ArrowRight, Clock3, Droplets, Info, Lightbulb, Loader2, MapPin, RefreshCw, Signpost, Sparkles, Sun, Thermometer, TreePine, Umbrella, X } from "lucide-react";
import { api, type Route } from "@/lib/api";
import { useNearestFrame } from "@/lib/hooks";
import { SCENARIO, useMap, usePrefs } from "@/lib/store";
import { crossesHotspot, generateAdvisory, hotspotSummary, type Advisory, type Hotspot, type Recommendation } from "@/lib/generateAdvisory";

// A separate ephemeral store: no additions to existing app state or persisted prefs.
const initial = { open: false, busy: false, result: null as Advisory | null, source: "" };
let state = initial;
const listeners = new Set<() => void>();
function update(patch: Partial<typeof initial>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function useAdvisory() {
  return useSyncExternalStore(subscribe, () => state, () => initial);
}
const sourceKey = (compareId: string, frameKey: string) => `${compareId}|${frameKey}`;

export function CityOpsToggle() {
  const advisory = useAdvisory();
  return <button type="button" onClick={() => update({ open: !advisory.open })} aria-expanded={advisory.open} aria-controls="city-ops-advisory" className="press flex-1 flex items-center justify-center rounded-full px-3 py-2 text-[11px] md:text-[13px] text-ink-200 hover:bg-white/10">City Partner View</button>;
}

function actionVisual(action: string) {
  if (/shade|canop|umbrella/i.test(action)) return { Icon: Umbrella, label: "Add shade", color: "text-[#b4d9a3]", background: "bg-[#b4d9a3]/10" };
  if (/water|drink|hydrat/i.test(action)) return { Icon: Droplets, label: "Water support", color: "text-[#a9d7fa]", background: "bg-[#a9d7fa]/10" };
  if (/sign|warn|notice/i.test(action)) return { Icon: Signpost, label: "Heat awareness", color: "text-[#ffc48a]", background: "bg-[#ffc48a]/10" };
  if (/work|schedul|cooler time|break/i.test(action)) return { Icon: Clock3, label: "Adjust timing", color: "text-[#d0bdfa]", background: "bg-[#d0bdfa]/10" };
  return { Icon: Lightbulb, label: "Suggested action", color: "text-ink-200", background: "bg-white/5" };
}

function HotspotCard({ hotspot: h, rank, recommendation }: { hotspot: Hotspot; rank: number; recommendation?: Recommendation }) {
  const visual = recommendation ? actionVisual(recommendation.action) : null;
  const street = h.street || h.location.replace(/\s+\([^)]*\)$/, "");
  const shade = h.shade_pct;
  const hasTemperatures = Number.isFinite(h.feels_c) && Number.isFinite(h.average_c);
  return (
    <article aria-label={`Hotspot ${rank}: ${street}`} className="rounded-2xl border border-white/10 bg-white/[0.025] p-4">
      <div className="flex items-start gap-2.5">
        <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-heat-4/15 text-xs font-semibold text-[#ffc48a]">{rank}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-snug break-words">{street}</h3>
          <p className="mt-1 flex items-center gap-1 text-[11px] text-ink-300"><MapPin size={11} aria-hidden="true" />Route stretch {rank}</p>
        </div>
        <span className="shrink-0 rounded-lg bg-heat-4/10 px-2 py-1 text-sm font-semibold tabular text-[#ffc48a]">+{h.deviation_c.toFixed(1)}°<span className="block text-[9px] font-normal">warmer</span></span>
      </div>

      {recommendation && visual && <div className={`mt-3 rounded-xl p-3 ${visual.background}`}>
        <div className={`flex items-center gap-2 text-[11px] font-medium ${visual.color}`}><visual.Icon size={16} aria-hidden="true" /><span>{visual.label}</span><span className="ml-auto text-[9px] font-normal">Suggested</span></div>
        <p className="mt-2 text-sm font-medium leading-relaxed break-words first-letter:uppercase">{recommendation.action}</p>
        <div className="mt-2 flex items-start gap-1.5 border-t border-white/10 pt-2 text-xs leading-relaxed text-ink-200"><Clock3 size={12} className="mt-0.5 shrink-0" aria-hidden="true" /><p><span className="text-ink-300">Follow this advice until </span>{recommendation.until}.</p></div>
      </div>}

      {hasTemperatures && <div className="mt-3 flex items-center gap-3 rounded-xl bg-ink-950/60 px-3 py-2.5" aria-label={`Area street average ${h.average_c!.toFixed(1)} degrees Celsius feels-like; this stretch ${h.feels_c!.toFixed(1)} degrees Celsius feels-like`}>
        <div className="flex-1"><p className="text-[10px] text-ink-300">Area average</p><p className="mt-0.5 text-lg tabular">{h.average_c!.toFixed(1)}<span className="text-xs text-ink-300">°C</span></p></div>
        <ArrowRight size={16} className="text-ink-400" aria-hidden="true" />
        <div className="flex-1"><p className="text-[10px] text-ink-300">This stretch</p><p className="mt-0.5 flex items-center gap-1 text-lg tabular text-[#ffc48a]"><Thermometer size={15} aria-hidden="true" />{h.feels_c!.toFixed(1)}<span className="text-xs">°C</span></p></div>
      </div>}

      <div className="mt-3">
        <p className="text-xs text-ink-200"><span className="text-ink-300">Why warmer: </span>{h.surface || h.cause}{shade !== undefined && shade < 20 ? " · very little shade" : ""}</p>
        {shade !== undefined && <div className="mt-2" role="img" aria-label={`${shade}% shade and ${100 - shade}% exposed to sun on this stretch`}>
          <div aria-hidden="true" className="flex h-1.5 overflow-hidden rounded-full bg-[#e2a44e]/70"><div style={{ width: `${shade}%` }} className="h-full bg-[#a2c98f]" /></div>
          <div className="mt-1.5 flex justify-between gap-2 text-[10px] text-ink-300"><span className="flex items-center gap-1"><TreePine size={11} aria-hidden="true" />{shade}% shade</span><span className="flex items-center gap-1"><Sun size={11} aria-hidden="true" />{100 - shade}% sun</span></div>
        </div>}
      </div>

    </article>
  );
}

export default function CityOpsAdvisory() {
  const advisory = useAdvisory();
  const compare = useMap((s) => s.compare);
  const frame = useNearestFrame();
  if (!advisory.open) return null;
  const hotspots = compare && frame ? hotspotSummary(compare, frame) : [];
  const source = compare && frame ? sourceKey(compare.compare_id, frame.key) : "";
  const result = advisory.source === source ? advisory.result : null;
  const recommendations = result?.recommendations ?? [];
  const stale = advisory.result && advisory.source !== source;
  const heatPending = Boolean(compare && (!frame || !compare.routes.some((r) => r.forecast.some((f) => Date.parse(f.time) === Date.parse(frame.time)))));
  const emptyTitle = !compare ? "Start with a route" : heatPending ? "Waiting for matching heat data" : "Not enough warmer stretches";
  const emptyText = !compare ? "Choose your start and destination, then wait for the heat data." : heatPending ? "Your route is ready. We’re waiting for its heat readings to match the area average. Recommendations will become available when they match." : "This heat snapshot has fewer than two above-average stretches. Try a different time on the forecast timeline.";
  const generate = async () => {
    if (!frame || state.busy || hotspots.length < 2) return;
    update({ busy: true, result: null, source });
    const result = await generateAdvisory(hotspots, frame.time);
    update({ busy: false, result });
  };
  return (
    <section id="city-ops-advisory" aria-label="City Ops Advisory" className="fixed z-[70] top-20 right-3 left-3 md:left-auto md:right-5 md:w-[440px] max-h-[calc(100dvh-160px)] flex flex-col overflow-hidden glass-strong rounded-[24px] text-ink-100 shadow-xl">
      <div className="shrink-0 border-b border-white/10 p-4 md:p-5">
        <div className="flex justify-between items-center gap-2">
          <div><p className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[#b4d9a3]"><Sparkles size={12} aria-hidden="true" />Simple recommendations</p><h2 className="font-semibold text-lg">City Ops Advisory</h2></div>
          <button type="button" onClick={() => update({ open: false })} aria-label="Close City Ops Advisory" className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-white/10"><X size={18} aria-hidden="true" /></button>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-300">See which streets feel hotter and what could help.</p>
        <button type="button" disabled={advisory.busy || hotspots.length < 2} onClick={() => void generate()} className="press mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-cool-400 px-4 py-2.5 text-sm font-semibold text-ink-950 disabled:opacity-50">
          {advisory.busy ? <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden="true" /> : recommendations.length ? <RefreshCw size={15} aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
          {advisory.busy ? "Making recommendations…" : recommendations.length ? "Refresh recommendations" : "Get recommendations"}
        </button>
        <p role="status" className="mt-2 text-xs leading-relaxed text-ink-300">{advisory.busy ? "Reading the heat and shade data for these streets." : stale ? "The heat data changed. Refresh for the latest advice." : result?.error ? result.text : recommendations.length ? "Two suggestions ready for review." : hotspots.length >= 2 ? "Based on the hotter stretches in your planned routes." : ""}</p>
      </div>

      <div tabIndex={0} role="region" aria-label="Hotspot details and recommendations" className="min-h-0 overflow-y-auto overscroll-contain scroll-thin p-4 md:p-5">
        {hotspots.length < 2 ? <div className="rounded-2xl border border-dashed border-white/15 p-5 text-center"><MapPin size={24} className="mx-auto mb-3 text-ink-300" aria-hidden="true" /><h3 className="text-sm font-medium">{emptyTitle}</h3><p className="mt-2 text-xs leading-relaxed text-ink-300">{emptyText}</p><p className="mt-2 text-[11px] text-ink-300">We need at least two warmer stretches to make recommendations.</p></div> : <>
          <p className="mb-3 text-[11px] leading-relaxed text-ink-300">Feels-like °C compared with the area street average.{recommendations.length > 0 && " Suggested actions for city teams."}</p>
          <div className="space-y-3">{hotspots.slice(0, recommendations.length ? 2 : 3).map((h, i) => <HotspotCard key={h.id} hotspot={h} rank={i + 1} recommendation={recommendations.find((r) => r.hotspot_id === h.id)} />)}</div>
          {recommendations.length > 0 && hotspots[2] && <details className="mt-3 rounded-xl border border-white/10 p-3"><summary className="cursor-pointer text-xs text-ink-200">One more warmer stretch · +{hotspots[2].deviation_c.toFixed(1)}°</summary><div className="mt-3"><HotspotCard hotspot={hotspots[2]} rank={3} /></div></details>}
          {recommendations.length > 0 && <details className="mt-3 rounded-xl border border-white/10 p-3"><summary className="cursor-pointer text-xs text-ink-300">Read the full two-sentence advisory</summary><p className="mt-2 text-xs leading-relaxed break-words text-ink-200">{result?.text}</p></details>}
        </>}
        {result?.error && <p className="mt-3 rounded-xl bg-white/5 p-3 text-xs leading-relaxed text-ink-200">{result.error === "quota" ? "The recommendation limit has been reached. Please try again later." : result.error === "configuration" ? "The recommendation service needs its connection checked by the app owner." : result.error === "timeout" ? "The service took too long to respond. Tap Get recommendations to try again." : "The recommendation service could not respond. Please try again."}</p>}
      </div>
      <div className="flex shrink-0 items-start gap-2 border-t border-white/10 px-4 py-3 text-[10px] leading-relaxed text-ink-300"><Info size={13} className="mt-0.5 shrink-0" aria-hidden="true" /><p>Heat and shade come from the app’s model. Suggestions are for review; they don’t confirm a water stop or shade facility is available.</p></div>
    </section>
  );
}

/** Mounted only inside the original route card; no routing call before explicit Yes. */
export function AdvisoryRoutePermission({ route }: { route: Route }) {
  const advisory = useAdvisory();
  const compare = useMap((s) => s.compare);
  const frame = useNearestFrame();
  const [dismissed, setDismissed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const token = `${advisory.source}|${route.id}|${advisory.result?.text ?? ""}`;
  const crosses = frame && compare && advisory.source === sourceKey(compare.compare_id, frame.key) && crossesHotspot(route.segments, advisory.result?.flagged ?? []);
  if (!crosses || dismissed === token) return null;
  const recalculate = async () => {
    const m = useMap.getState();
    const p = usePrefs.getState();
    if (busy || m.loading || !m.origin || !m.destination || !m.compare?.routes.some((r) => r.id === route.id)) return;
    const original = m.compare;
    const origin = m.origin;
    const destination = m.destination;
    setBusy(true);
    setError("");
    try {
      // Reuse existing bench/toilet scoring; Micro-Rest itself is a mock scheduler.
      const result = await api.compare({ origin, destination, persona: p.persona, mode: p.mode, senior: true, scenario: SCENARIO, depart_at: original.depart_at, temp_delta_c: original.temp_delta_c });
      const current = useMap.getState();
      const prefs = usePrefs.getState();
      if (current.compare !== original || current.origin !== origin || current.destination !== destination || prefs.persona !== p.persona || prefs.mode !== p.mode || current.loading) return;
      current.set({ compare: result, anchorCompareId: result.compare_id, selectedRouteId: result.recommended_id });
      setDismissed(token);
    } catch {
      setError("Route recalculation temporarily unavailable");
    } finally {
      setBusy(false);
    }
  };
  return <div className="rounded-xl bg-heat-4/10 p-3 text-sm" onClick={(e) => e.stopPropagation()}>
    <p>This route crosses an advisory hotspot — recalculate a safer route considering bench/water rest points?</p>
    <p className="mt-1 text-xs text-ink-400">Uses existing bench/toilet priority; water scoring stays as supported by the router.</p>
    <div className="flex gap-3 mt-2"><button type="button" disabled={busy} onClick={() => void recalculate()} className="rounded-full px-3 py-1 bg-cool-400 text-ink-950 disabled:opacity-50">{busy ? "Recalculating…" : "Yes"}</button><button type="button" disabled={busy} onClick={() => setDismissed(token)}>No</button></div>
    {error && <p role="status" className="mt-2">{error}</p>}
  </div>;
}
