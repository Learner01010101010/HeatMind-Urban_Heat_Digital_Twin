"use client";

import { BrainCircuit, CheckCircle2 } from "lucide-react";
import type { CompareResult, Route } from "@/lib/api";
import { recommendRoute } from "@/lib/routeRecommendation";
import { useMap } from "@/lib/store";

export default function RouteRecommendationLine({ route, compare, compact = false }: {
  route: Route; compare?: CompareResult; compact?: boolean;
}) {
  const storedComparison = useMap((s) => s.compare);
  const result = recommendRoute(route, compare ?? storedComparison);
  return <div className={`${compact ? "pt-2 mt-2 border-t border-white/10" : "rounded-2xl border p-3"} ${result.recommended ? "border-cool-300/25 bg-cool-300/[0.04]" : "border-white/10"}`}
    aria-label={`Local AI recommendation for ${route.label}`}
    title="Local rule-based expert system; no trained model or external AI request. Explains departure conditions without changing the route choice.">
    <div className="flex items-center gap-1.5 text-[10px] font-semibold text-cool-300 mb-1">
      <BrainCircuit size={12} aria-hidden="true" /><span>Local AI · rule-based</span>
      {result.recommended && <span className="ml-auto inline-flex items-center gap-1"><CheckCircle2 size={11} aria-hidden="true" />Recommended</span>}
    </div>
    {route.objective_roles && <div className="text-[10px] text-ink-400 mb-1">{route.objective_roles.filter((role) => role !== "balanced").map((role) => ({ fastest: "Fastest", shortest: "Shortest", coolest: "Least modelled heat" })[role]).join(" · ")}</div>}
    <p className={`${compact ? "text-[11px]" : "text-[12px]"} leading-relaxed text-ink-200`}>{result.summary}</p>
    {!compact && <p className="text-[10px] text-ink-400 mt-1">Based on departure conditions · timeline previews do not change the recommendation.</p>}
  </div>;
}
