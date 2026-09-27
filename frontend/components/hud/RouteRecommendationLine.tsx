"use client";

import { Clock3, Droplets, Sparkles, Sun, TreePine } from "lucide-react";
import { useEffect, useState } from "react";
import type { CompareResult, Route } from "@/lib/api";
import { adviceKey, generateJourneyAdvice, type JourneyAdvice } from "@/lib/generateRouteAdvice";
import { routeComparison } from "@/lib/routeRecommendation";
import { useMap } from "@/lib/store";

export default function RouteRecommendationLine({ route, compare, compact = false }: {
  route: Route; compare?: CompareResult; compact?: boolean;
}) {
  const stored = useMap((s) => s.compare);
  const context = compare ?? stored;
  const key = adviceKey(route, context);
  const [response, setResponse] = useState<{ key: string; advice?: JourneyAdvice; error?: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void generateJourneyAdvice(route, context).then((advice) => { if (active) setResponse({ key, advice }); })
      .catch(() => { if (active) setResponse({ key, error: true }); });
    return () => { active = false; };
    // The key fingerprints all measurements used by the model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);
  const result = routeComparison(route, context);
  const current = response?.key === key ? response : null;
  const delta = result.timeDelta, heat = result.heatReduction, shade = route.metrics.pct_shaded_street;
  const items = [
    { icon: Clock3, value: delta != null && Math.abs(delta) >= .5 ? `${Math.round(Math.abs(delta))} min` : result.reference?.id === route.id ? "Fastest" : delta != null ? "Similar" : `${Math.round(route.duration_min)} min`,
      label: delta != null && delta >= .5 ? "longer" : delta != null && delta <= -.5 ? "quicker" : "travel time",
      good: delta != null && delta <= 0 },
    { icon: heat != null && Math.abs(heat) >= 1 ? Sun : TreePine,
      value: heat != null && Math.abs(heat) >= 1 ? `${Math.round(Math.abs(heat))}%` : Number.isFinite(shade) ? `${Math.round(shade)}%` : "—",
      label: heat != null && Math.abs(heat) >= 1 ? heat > 0 ? "less heat" : "more heat" : "street shade",
      good: heat != null && heat >= 1 },
    { icon: Droplets, value: String(result.water), label: "water points", good: result.water > 0 },
  ];
  return <div className={`${compact ? "pt-1.5 mt-1.5 border-t border-white/10" : "rounded-2xl border border-white/10 p-3"}`} aria-label={`Journey recommendation for ${route.label}`}
    title={result.reference && result.reference.id !== route.id ? `Time and estimated heat compared with the ${result.recommended ? "fastest" : "recommended"} route. Water points are mapped; confirm access.` : "Street shade and heat are estimated. Water points are mapped; confirm access."}>
    <div className="grid grid-cols-3 gap-1.5 mb-1.5">
      {items.map(({ icon: Icon, value, label, good }) => <div key={label} className="rounded-xl bg-black/15 px-2 py-1">
        <div className={`flex items-center gap-1 text-[11px] font-semibold ${good ? "text-cool-300" : "text-ink-200"}`}><Icon size={12} aria-hidden />{value}</div>
        <div className="text-[9px] text-ink-400 mt-0.5">{label}</div>
      </div>)}
    </div>
    {!compact && result.reference && result.reference.id !== route.id && <p className="text-[9px] text-ink-500 mb-1">Compared with {result.recommended ? "the fastest route" : "the recommended route"} · heat estimated</p>}
    <div className="flex items-start gap-1.5">
      <Sparkles size={12} className="text-cool-300 shrink-0 mt-0.5" aria-hidden />
      <p aria-live="polite" className={`text-[11px] text-ink-200 ${compact ? "leading-[1.35] line-clamp-2" : "leading-relaxed"}`}>{current?.advice?.summary ?? (current?.error
        ? "Journey advice is temporarily unavailable." : "Preparing your journey recommendation…")}</p>
    </div>
    {current?.error && <button onKeyDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setResponse(null); setRetry((n) => n + 1); }}
      className="mt-1 text-[10px] underline text-cool-300">Try again</button>}
    {!compact && current?.advice && <div className="mt-3 space-y-2">{current.advice.tips.map((tip, i) => <div key={tip} className="flex gap-2 text-[11px] text-ink-300 bg-white/5 rounded-xl p-2.5"><span className="text-cool-300 font-semibold">{i + 1}</span>{tip}</div>)}</div>}
  </div>;
}
