import assert from "node:assert/strict";
import { test } from "node:test";
import { recommendRoute } from "../lib/routeRecommendation.ts";
import { generateRouteAdvice } from "../lib/generateRouteAdvice.ts";

function route(id, changes = {}) {
  return { id, label: `Route ${id}`, tags: [], mode: "walk", duration_min: 10,
    heat_risk_score: 35, pois_along_route: [],
    metrics: { heat_dose: 200, pct_shaded: 20, pct_shaded_street: 20, shielded: false },
    optimization: { score: 35, industrial: { mean_c: .5 }, traffic: { live: false, coverage_pct: 0, delay_min: 0 } },
    ...changes };
}
const comparison = (routes, recommended_id) => ({ routes, recommended_id });

test("chosen distance/time objectives get matching explanations", () => {
  const a = route("A", { distance_m: 1000 });
  const ctx = { ...comparison([a], a.id), route_engine: { objective: "shortest" } };
  assert.match(recommendRoute(a, ctx).summary, /Shortest choice: 1.00 km/);
  ctx.route_engine.objective = "fastest";
  assert.match(recommendRoute(a, ctx).summary, /Fastest choice/);
  ctx.route_engine.objective = "coolest";
  assert.match(recommendRoute(a, ctx).summary, /Least modelled heat among these routes/);
});

test("explains the planner's detour without mutating its choice or metrics", () => {
  const fast = route("B"), cool = route("A", { duration_min: 12, tags: ["recommended"],
    metrics: { heat_dose: 150, pct_shaded: 50, pct_shaded_street: 50 }, heat_risk_score: 25 });
  const ctx = comparison([cool, fast], cool.id), before = JSON.stringify(ctx);
  const result = recommendRoute(cool, ctx);
  assert.equal(result.recommended, true);
  assert.match(result.summary, /25% less accumulated heat/);
  assert.match(result.summary, /2 extra min versus fastest/);
  assert.equal(JSON.stringify(ctx), before);
});

test("recommended ID is authoritative, independent of stale tags/selection", () => {
  const a = route("A", { tags: ["recommended"] }), b = route("B");
  const ctx = comparison([a, b], "B");
  assert.equal(recommendRoute(a, ctx).recommended, false);
  assert.equal(recommendRoute(b, ctx).recommended, true);
});

test("fastest recommendation does not invent a heat improvement", () => {
  const fast = route("A"), slow = route("B", { duration_min: 12, optimization: { score: 34, industrial: { mean_c: .5 } } });
  const result = recommendRoute(fast, comparison([fast, slow], "A"));
  assert.match(result.summary, /quickest/);
  assert.match(result.summary, /do not improve/);
  assert.doesNotMatch(result.summary, /less accumulated heat|lower heat-risk/);
});

test("car shielding is not described as street shade", () => {
  const a = route("A", { mode: "car", duration_min: 12,
    metrics: { heat_dose: 200, pct_shaded: 100, pct_shaded_street: 20, shielded: true } });
  const b = route("B", { mode: "car" });
  assert.doesNotMatch(recommendRoute(a, comparison([a,b], "A")).summary, /more street shade/);
  assert.match(recommendRoute(a).tips[1], /Vehicle shielding/);
});

test("seeded/private points and shops do not become drinking-water guarantees", () => {
  const facility = { id: "water", source: "osm", detail: "drinking_water" };
  const r = route("A", { pois_along_route: [{...facility, source:"seeded"}, {...facility, id:"private", access:"private"},
    {...facility, id:"shop", detail:"restaurant"}] });
  assert.match(recommendRoute(r).tips[0], /No public drinking-water/);
  r.pois_along_route.push(facility);
  assert.match(recommendRoute(r).tips[0], /1 public drinking-water point/);
  assert.match(recommendRoute(r).tips[0], /confirm access/);
});

test("bus itinerary is described separately with assumed wait", () => {
  const bus = route("bus", {mode:"bus", transit:{walk_m:1200,wait_min:8,board:{shelter:true}}});
  const fast = route("A");
  const result = recommendRoute(bus, comparison([bus,fast], "A"));
  assert.equal(result.recommended, false);
  assert.match(result.summary, /timetable estimated/);
  assert.doesNotMatch(result.summary, /Best balance/);
});

test("a deep link does not borrow another trip's comparison", () => {
  const r = route("own", {tags:["recommended"]});
  const result = recommendRoute(r, comparison([route("other")], "other"));
  assert.equal(result.recommended, true);
  assert.match(result.summary, /Recommended at departure/);
  assert.doesNotMatch(result.summary, /versus/);
});

test("missing traffic/shade values do not invent measurements or output NaN", () => {
  const r = route("A", {duration_min:NaN, optimization:undefined, heat_risk_score:NaN,
    metrics:{heat_dose:NaN,pct_shaded_street:NaN}});
  const result = recommendRoute(r);
  assert.doesNotMatch(JSON.stringify(result), /NaN|undefined|Live traffic samples/);
  assert.match(result.summary, /duration unavailable/);
});

test("repeated local tips need no network or quota", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("A remote request is forbidden in this test"); };
  try {
    const r = route("A");
    for (let i=0; i<100; i++) {
      const tips = await generateRouteAdvice(r);
      assert.equal(tips.length, 3);
      assert.match(tips[0], /Carry your own water/);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("recommended does not mean low heat or complete traffic coverage", () => {
  const r = route("A", {tags:["recommended"], heat_risk_score:72,
    optimization:{score:72,industrial:{mean_c:.4},traffic:{live:true,coverage_pct:25,delay_min:1}}});
  const result = recommendRoute(r);
  assert.match(result.summary, /Heat remains high/);
  assert.match(result.tips[2], /high modelled heat/);
  const low = route("B", {optimization:{score:20,industrial:{mean_c:.4},traffic:{live:true,coverage_pct:25,delay_min:1}}});
  assert.match(recommendRoute(low).tips[2], /cover 25%/);
});
