import assert from "node:assert/strict";
import { test } from "node:test";
import { remainingOrigin, sameTrip } from "../lib/liveRoutingRules.ts";
import { capturePosition, checkLiveRoute, cancelLiveCheck, applyRouteChange } from "../lib/liveRouting.ts";
import { useMap, usePrefs } from "../lib/store.ts";
import { useNav } from "../lib/navigation.ts";
import { useGeo } from "../lib/geolocation.ts";
import { useRouteEngine } from "../lib/routeEngineState.ts";

const route = (id, tags = []) => ({ id, tags, mode: "walk", geometry: [[18.46, 73.84], [18.461, 73.84]], duration_min: 10, distance_m: 111 });
const comparison = (id, routes, chosen = routes[0].id) => ({ compare_id: id, persona: "student", scenario: "live", routes,
  origin: {lat:18.46,lon:73.84}, destination:{lat:18.461,lon:73.84}, recommended_id: chosen,
  temp_delta_c: 0, route_engine: { objective: "balanced" } });
function setup(enabled = true) {
  cancelLiveCheck();
  useGeo.getState().set({status:"idle",lat:null,lon:null,accuracyM:null}); capturePosition();
  const original = comparison("old", [route("old-0")]);
  useMap.getState().set({compare:original,selectedRouteId:"old-0",loading:false,tempDelta:0,simOffsetMin:0});
  usePrefs.getState().set({persona:"student"});
  useNav.getState().set({active:true,routeId:"old-0",progressM:40,startedAt:123,forceSimulation:true,simSpeed:4,paused:false});
  useRouteEngine.getState().set({enabled,checking:false,objective:"balanced",demoHeatDelta:0,switches:0,error:null,pending:null});
  return original;
}
function response(should_switch = false) {
  const routes = [route("new-0", ["current"]), route("new-1", ["recommended"])];
  return { arrived:false,should_switch,message:"Updated conditions",changes:[],checked_at:new Date().toISOString(),comparison:comparison("new",routes,"new-1") };
}
async function withFetch(fetcher, body) {
  const saved=globalThis.fetch; globalThis.fetch=fetcher;
  try {await body();} finally {globalThis.fetch=saved;}
}

test("recent accurate GPS flags off-route; stale/noisy GPS uses labelled preview", () => {
  const r = route("r"), now = 100000;
  assert.equal(remainingOrigin(r,40,{lat:18.4603,lon:73.84,accuracy:8,at:now},now).off_route,false);
  assert.equal(remainingOrigin(r,40,{lat:18.4603,lon:73.842,accuracy:8,at:now},now).off_route,true);
  assert.equal(remainingOrigin(r,40,{lat:18.4603,lon:73.842,accuracy:51,at:now},now).source,"preview");
  assert.equal(remainingOrigin(r,40,{lat:18.4603,lon:73.842,accuracy:8,at:now-31000},now).source,"preview");
  assert.equal(sameTrip("a","r","b","r"),false);
});
test("same route refresh advances anchor and preserves navigation clock and playback", async () => {
  setup(); let body;
  await withFetch(async(_,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify(response()));},async()=>{
    await checkLiveRoute(); assert.ok(body.position.lat>18.46);
    assert.equal(useNav.getState().routeId,"new-0"); assert.equal(useMap.getState().anchorCompareId,"new");
    assert.equal(useNav.getState().startedAt,123); assert.equal(useNav.getState().simSpeed,4);
    assert.equal(useRouteEngine.getState().switches,0);
  });
});
test("meaningful improvement automatically switches when enabled", async () => {
  setup(); await withFetch(async()=>new Response(JSON.stringify(response(true))),async()=>{
    await checkLiveRoute(); assert.equal(useNav.getState().routeId,"new-1");
    assert.equal(useRouteEngine.getState().switches,1); assert.equal(useNav.getState().progressM,0);
  });
});
test("disabled monitoring never switches until manual acceptance", async () => {
  setup(false); let calls=0;
  await withFetch(async()=>{calls++;return new Response(JSON.stringify(response(true)));},async()=>{
    await checkLiveRoute(); assert.equal(calls,0); await checkLiveRoute("manual"); assert.equal(calls,1);
    assert.equal(useNav.getState().routeId,"old-0"); applyRouteChange(useRouteEngine.getState().pending);
    assert.equal(useNav.getState().routeId,"new-1");
  });
});
test("stale responses cannot replace a different trip", async () => {
  setup(); let finish;
  await withFetch(()=>new Promise(resolve=>{finish=resolve;}),async()=>{
    const checking=checkLiveRoute();
    useMap.getState().set({compare:comparison("other",[route("other-0")]),selectedRouteId:"other-0"});
    useNav.getState().set({routeId:"other-0"}); finish(new Response(JSON.stringify(response(true)))); await checking;
    assert.equal(useNav.getState().routeId,"other-0"); assert.equal(useRouteEngine.getState().switches,0);
    assert.equal(useRouteEngine.getState().checking,false);
  });
});
test("failure keeps guidance and a later check recovers", async () => {
  setup(); await withFetch(async()=>{throw new Error("offline");},async()=>{
    await checkLiveRoute(); assert.equal(useNav.getState().routeId,"old-0"); assert.ok(useRouteEngine.getState().error);
  });
  await withFetch(async()=>new Response(JSON.stringify(response())),async()=>{
    await checkLiveRoute(); assert.equal(useRouteEngine.getState().error,null); assert.equal(useNav.getState().routeId,"new-0");
  });
});
test("explicit heat simulation is sent to the recheck endpoint", async () => {
  setup(); useRouteEngine.getState().set({demoHeatDelta:5}); let body;
  await withFetch(async(_,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify(response()));},async()=>{
    await checkLiveRoute("temperature"); assert.equal(body.temp_delta_c,5);
  });
});
