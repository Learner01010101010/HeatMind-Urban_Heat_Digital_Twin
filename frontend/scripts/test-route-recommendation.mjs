import assert from "node:assert/strict";
import { test } from "node:test";
import { routeComparison, publicStops } from "../lib/routeRecommendation.ts";
import { generateJourneyAdvice, adviceKey } from "../lib/generateRouteAdvice.ts";
const route = (id, changes = {}) => ({ id, mode:"walk", tags:[], duration_min:10, metrics:{heat_dose:200,pct_shaded_street:20}, pois_along_route:[], ...changes });
test("comparisons reflect exact metrics without reranking or mutation", () => {
  const fast=route("fast"), cool=route("cool",{duration_min:12,metrics:{heat_dose:150,pct_shaded_street:50}});
  const ctx={compare_id:"trip",routes:[fast,cool],recommended_id:"cool"}, original=JSON.stringify(ctx);
  const r=routeComparison(cool,ctx);
  assert.equal(r.recommended,true); assert.equal(r.timeDelta,2); assert.equal(r.heatReduction,25);
  assert.equal(JSON.stringify(ctx),original);
});
test("no comparisons borrowed from unrelated trips, buses or other travel modes",()=>{
  const a=route("a",{tags:["recommended"]});
  assert.equal(routeComparison(a,{routes:[route("other")],recommended_id:"other"}).reference,null);
  const bus=route("bus",{mode:"bus",transit:{}});
  assert.equal(routeComparison(bus,{routes:[a,bus],recommended_id:"a"}).timeDelta,null);
});
test("public water excludes duplicate, private, seeded, non-drinking and shop points",()=>{
  const p={id:"w",source:"osm",detail:"drinking_water"};
  const r=route("r",{pois_along_route:[p,p,{...p,id:"private",access:"private"},{...p,id:"seed",source:"seeded"},{...p,id:"no",drinking_water:"no"},{...p,id:"shop",detail:"restaurant"}]});
  assert.equal(publicStops(r).length,1); assert.equal(routeComparison(r).water,1);
});
test("missing measurements do not become manufactured improvements",()=>{
  const a=route("a",{duration_min:NaN,metrics:{heat_dose:NaN}}),b=route("b");
  const result=routeComparison(a,{routes:[a,b],recommended_id:"b"});
  assert.equal(result.timeDelta,null);assert.equal(result.heatReduction,null);
});
test("one inference batch serves all route cards and changed data invalidates it",async()=>{
  const original=globalThis.fetch;let calls=0;
  const a=route("dedup-a"),b=route("dedup-b"),ctx={compare_id:"dedup",routes:[a,b],recommended_id:a.id};
  globalThis.fetch=async()=>{calls++;return {ok:true,json:async()=>({routes:{[a.id]:{summary:"A shorter journey.",tips:["Carry water.","Check shade."]},[b.id]:{summary:"A cooler alternative.",tips:["Carry water.","Check shade."]}}})};};
  try{
    const key=adviceKey(a,ctx);
    const [first,second]=await Promise.all([generateJourneyAdvice(a,ctx),generateJourneyAdvice(b,ctx)]);
    assert.equal(calls,1);assert.notEqual(first.summary,second.summary);
    a.duration_min=15;assert.notEqual(adviceKey(a,ctx),key);
    await generateJourneyAdvice(a,ctx);assert.equal(calls,2);
  }finally{globalThis.fetch=original;}
});
test("failed inference can be retried instead of cached as generated text",async()=>{
  const original=globalThis.fetch;const a=route("retry");
  globalThis.fetch=async()=>({ok:false});
  try{
    await assert.rejects(generateJourneyAdvice(a));
    globalThis.fetch=async()=>({ok:true,json:async()=>({routes:{retry:{summary:"Keep your journey comfortable.",tips:["Carry water.","Check shade."]}}})});
    assert.equal((await generateJourneyAdvice(a)).tips.length,2);
  }finally{globalThis.fetch=original;}
});
