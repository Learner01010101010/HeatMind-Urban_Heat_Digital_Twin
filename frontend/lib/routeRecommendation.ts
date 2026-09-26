import type { CompareResult, Poi, Route } from "./api";

/** Local symbolic expert system: facts -> evidence rules -> concise explanation.
 * No learned model, remote inference, API key or changes to the planner's choice.
 * Recommendations explain departure conditions; forecast previews do not rerank.
 */
export interface RouteRecommendation {
  recommended: boolean;
  summary: string;
  evidence: string[];
  tips: string[];
  method: "local_expert_rules";
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const number = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1);
const PUBLIC_DETAILS = new Set(["drinking_water", "water_point", "water_dispenser", "bench", "toilets", "shelter"]);

function publicFacility(p: Poi) {
  return p.source === "osm" && !["private", "no", "customers"].includes(p.access ?? "")
    && p.drinking_water !== "no" && PUBLIC_DETAILS.has(p.detail ?? "");
}

function stops(route: Route) {
  return [...new Map((route.pois_along_route ?? []).filter(publicFacility).map((p) => [p.id, p])).values()];
}

function benefits(route: Route, reference: Route): string[] {
  const evidence: string[] = [];
  const m = route.metrics, f = reference.metrics;
  if (finite(m.heat_dose) && finite(f.heat_dose) && f.heat_dose > 0) {
    const reduction = (f.heat_dose - m.heat_dose) / f.heat_dose * 100;
    if (reduction >= 3) evidence.push(`${Math.round(reduction)}% less accumulated heat`);
  }
  if (finite(route.heat_risk_score) && finite(reference.heat_risk_score)) {
    const reduction = reference.heat_risk_score - route.heat_risk_score;
    if (reduction >= 2) evidence.push(`${Math.round(reduction)} points lower heat-risk score`);
  }
  // Street shade is comparable even when a vehicle shields its occupant.
  if (finite(m.pct_shaded_street) && finite(f.pct_shaded_street)) {
    const gain = m.pct_shaded_street - f.pct_shaded_street;
    if (gain >= 3) evidence.push(`${Math.round(gain)} percentage points more street shade`);
  }
  const facilities = stops(route).length, otherFacilities = stops(reference).length;
  if (facilities > otherFacilities) evidence.push(`${facilities - otherFacilities} more mapped rest/water stop${facilities - otherFacilities === 1 ? "" : "s"}`);
  const industry = route.optimization?.industrial.mean_c, otherIndustry = reference.optimization?.industrial.mean_c;
  if (finite(industry) && finite(otherIndustry) && otherIndustry - industry >= .15) evidence.push("less estimated industrial heat");
  const traffic = route.optimization?.traffic, otherTraffic = reference.optimization?.traffic;
  if (traffic?.live && otherTraffic?.live && traffic.coverage_pct >= 50 && otherTraffic.coverage_pct >= 50
      && finite(traffic.delay_min) && finite(otherTraffic.delay_min) && otherTraffic.delay_min - traffic.delay_min >= .5) {
    evidence.push("less estimated delay on sampled roads");
  }
  const score = route.optimization?.score, otherScore = reference.optimization?.score;
  if (!evidence.length && finite(score) && finite(otherScore) && otherScore - score >= 2) evidence.push("a lower combined route score");
  return evidence;
}

function tripTips(route: Route): string[] {
  const facilities = stops(route);
  const water = facilities.filter((p) => ["drinking_water", "water_point", "water_dispenser"].includes(p.detail ?? ""));
  const tips = [water.length
    ? `${water.length} public drinking-water point${water.length === 1 ? " is" : "s are"} mapped nearby; confirm access and that the water is suitable for drinking.`
    : "No public drinking-water point is mapped along this route. Carry your own water."];
  const shade = route.metrics.pct_shaded_street;
  if (route.transit) {
    tips.push(`Bus wait is estimated at ${number(route.transit.wait_min)} min; ${route.transit.board.shelter ? "the boarding stop has mapped shelter" : "the boarding stop has no mapped shelter"}. Check the actual service.`);
  } else if (route.metrics.shielded) {
    tips.push("Vehicle shielding is different from street shade. Check shade and facilities separately when you step outside.");
  } else if (finite(shade) && shade >= 40) {
    tips.push(`About ${Math.round(shade)}% of the street is modelled as shaded at departure. Shade changes as the sun moves.`);
  } else {
    tips.push("Street shade is limited or unknown. Check the departure forecast before setting off.");
  }
  const traffic = route.optimization?.traffic;
  if (finite(route.heat_risk_score) && route.heat_risk_score >= 60) {
    tips.push("This route still has high modelled heat exposure. Review cooler departure times and mapped rest opportunities.");
  } else if (traffic?.live) {
    tips.push(`Live traffic samples cover ${Math.round(traffic.coverage_pct)}% of this route; other roads and future traffic use estimates.`);
  } else {
    tips.push("Traffic is estimated here. Allow extra time; industrial heat is also modelled, not a pollution measurement.");
  }
  return tips;
}

export function recommendRoute(route: Route, comparison?: CompareResult | null): RouteRecommendation {
  // Never explain against a different trip left in the map store / deep-link page.
  const context = comparison?.routes.some((r) => r.id === route.id) ? comparison : null;
  const recommended = context ? context.recommended_id === route.id : route.tags.includes("recommended");
  const peers = context?.routes.filter((r) => !r.transit && !r.tags.includes("transit")
    && (r.mode ?? "walk") === (route.mode ?? "walk") && finite(r.duration_min)) ?? [];
  const fastest = peers.length ? peers.reduce((a, b) => a.duration_min <= b.duration_min ? a : b) : null;
  const chosen = context?.routes.find((r) => r.id === context.recommended_id);
  const objective = context?.route_engine?.objective ?? "balanced";
  const prefix = recommended ? "Best balance" : "Alternative";
  let summary: string;
  let evidence: string[] = [];

  if (recommended && objective !== "balanced" && !route.transit) {
    const duration = finite(route.duration_min) ? `${number(route.duration_min)} min` : "duration unavailable";
    if (objective === "shortest") summary = `Shortest choice: ${finite(route.distance_m) ? `${(route.distance_m / 1000).toFixed(2)} km on the mapped streets` : "distance unavailable"}; estimated ${duration}.`;
    else if (objective === "fastest") summary = `Fastest choice: estimated ${duration}; prioritizes arrival time with the available traffic data.`;
    else {
      const extra = fastest ? route.duration_min - fastest.duration_min : 0;
      summary = `Least modelled heat among these routes: heat-risk score ${Math.round(route.heat_risk_score)}${extra >= .1 ? `; ${number(extra)} extra min versus fastest` : `; estimated ${duration}`}.`;
    }
  } else if (route.transit) {
    summary = `Bus option: ${(route.transit.walk_m / 1000).toFixed(1)} km walking and ~${number(route.transit.wait_min)} min wait; timetable estimated.`;
  } else if (recommended && fastest && fastest.id === route.id) {
    const score = route.optimization?.score;
    const eligible = peers.filter((r) => r.id !== route.id && r.duration_min <= route.duration_min * 1.5 + 4);
    const noUsefulDetour = eligible.length > 0 && finite(score)
      && eligible.every((r) => finite(r.optimization?.score) && r.optimization!.score > score - 2);
    summary = `Best balance: quickest at ${number(route.duration_min)} min${noUsefulDetour ? "; eligible detours do not improve the combined score enough" : " among these street routes"}.`;
  } else {
    const reference = recommended ? fastest : chosen;
    if (reference && reference.id !== route.id && !reference.transit) {
      evidence = benefits(route, reference);
      const extra = route.duration_min - reference.duration_min;
      const timing = finite(extra) && extra >= .1 ? `${number(extra)} extra min` : finite(extra) && extra <= -.1 ? `${number(-extra)} min quicker` : "similar travel time";
      if (evidence.length) {
        summary = `${prefix}: ${evidence.slice(0, 2).join(" and ")}; ${timing}${recommended ? " versus fastest" : " versus the recommendation"}.`;
      } else {
        summary = `${prefix}: ${timing}${recommended ? " versus fastest" : " versus the recommendation"}; ${finite(route.heat_risk_score) ? `heat-risk score ${Math.round(route.heat_risk_score)}` : "heat-risk data unavailable"}.`;
      }
    } else {
      const duration = finite(route.duration_min) ? `${number(route.duration_min)} min` : "duration unavailable";
      const facilities = stops(route).length;
      summary = `${recommended ? "Recommended at departure" : "Route overview"}: ${duration}${facilities ? ` with ${facilities} mapped rest/water stop${facilities === 1 ? "" : "s"}` : "; no public rest/water stops mapped"}.`;
    }
  }
  if (recommended && finite(route.heat_risk_score) && route.heat_risk_score >= 60) summary += " Heat remains high.";
  return { recommended, summary, evidence, tips: tripTips(route), method: "local_expert_rules" };
}
