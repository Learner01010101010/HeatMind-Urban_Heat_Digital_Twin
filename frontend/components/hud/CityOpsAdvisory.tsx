"use client";

import { useState, useSyncExternalStore } from "react";
import { api, type Route } from "@/lib/api";
import { useNearestFrame } from "@/lib/hooks";
import { SCENARIO, useMap, usePrefs } from "@/lib/store";
import { crossesHotspot, generateAdvisory, hotspotSummary, type Advisory } from "@/lib/generateAdvisory";

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

export default function CityOpsAdvisory() {
  const advisory = useAdvisory();
  const compare = useMap((s) => s.compare);
  const frame = useNearestFrame();
  if (!advisory.open) return null;
  const hotspots = compare && frame ? hotspotSummary(compare, frame) : [];
  const source = compare && frame ? sourceKey(compare.compare_id, frame.key) : "";
  const generate = async () => {
    if (!frame || state.busy || hotspots.length < 2) return;
    update({ busy: true, result: null, source });
    const result = await generateAdvisory(hotspots, frame.time);
    update({ busy: false, result });
  };
  return (
    <section id="city-ops-advisory" aria-label="City Ops Advisory" className="fixed z-[70] top-20 right-3 left-3 md:left-auto md:right-5 md:w-[420px] max-h-[calc(100dvh-160px)] overflow-y-auto glass-strong rounded-[24px] p-5 text-ink-100 shadow-xl">
      <div className="flex justify-between items-center gap-2"><h2 className="font-semibold text-lg">City Ops Advisory</h2><button type="button" onClick={() => update({ open: false })} aria-label="Close City Ops Advisory">✕</button></div>
      <p className="text-xs text-ink-400 mt-2">Computed route segments · deviation from zone street average · feels-like °C</p>
      {hotspots.length < 2 ? <p className="text-sm mt-4">Plan a route and wait for matching heat data. At least two above-average segments are needed.</p> : <ul className="space-y-3 my-4 text-sm">{hotspots.map((h) => <li key={h.id}><strong>{h.location}</strong><div>+{h.deviation_c}° · {h.cause}</div></li>)}</ul>}
      <button type="button" disabled={advisory.busy || hotspots.length < 2} onClick={() => void generate()} className="press rounded-full bg-cool-400 text-ink-950 px-4 py-2 text-sm font-semibold disabled:opacity-50">{advisory.busy ? "Generating…" : "Generate advisory"}</button>
      <p role="status" className="mt-4 text-sm leading-relaxed">{advisory.source === source ? advisory.result?.text : advisory.result ? "Heat data changed — generate a current advisory." : ""}</p>
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
