import type { CompareResult, Poi, Route } from "./api";

/** Exact visual measurements. Prose is generated separately by the local model. */
export function publicStops(route: Route): Poi[] {
  const kinds = new Set(["drinking_water", "water_point", "water_dispenser", "bench", "toilets", "shelter"]);
  return [...new Map((route.pois_along_route ?? []).filter((p) => p.source === "osm"
    && !["private", "no", "customers"].includes(p.access ?? "") && p.drinking_water !== "no"
    && kinds.has(p.detail ?? "")).map((p) => [p.id, p])).values()];
}

export function routeComparison(route: Route, comparison?: CompareResult | null) {
  const context = comparison?.routes.some((r) => r.id === route.id) ? comparison : null;
  const recommended = context ? context.recommended_id === route.id : route.tags.includes("recommended");
  const peers = (context?.routes ?? []).filter((r) => !r.transit && (r.mode ?? "walk") === (route.mode ?? "walk"));
  const fastest = peers.reduce<Route | null>((best, r) => !best || r.duration_min < best.duration_min ? r : best, null);
  const reference = recommended ? fastest : peers.find((r) => r.id === context?.recommended_id);
  const timeDelta = reference && Number.isFinite(route.duration_min) && Number.isFinite(reference.duration_min)
    ? route.duration_min - reference.duration_min : null;
  const heat = route.metrics.heat_dose, base = reference?.metrics.heat_dose;
  const heatReduction = Number.isFinite(heat) && base != null && Number.isFinite(base) && base > 0
    ? (base - heat) / base * 100 : null;
  return { recommended, reference, timeDelta, heatReduction,
    water: publicStops(route).filter((p) => ["drinking_water", "water_point", "water_dispenser"].includes(p.detail ?? "")).length };
}
