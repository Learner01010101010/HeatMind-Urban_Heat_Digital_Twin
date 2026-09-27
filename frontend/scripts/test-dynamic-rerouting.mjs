import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptDynamicSuggestion, cancelDynamicCheck, checkDynamicRoute, continueCurrentRoute,
  currentPosition, toggleDynamicRerouting, useDynamicRerouting } from "../lib/dynamicRerouting.ts";
import { useMap } from "../lib/store.ts";
import { useNav } from "../lib/navigation.ts";
import { useGeo } from "../lib/geolocation.ts";

const config = { available:true, check_seconds:60, continue_cooldown_seconds:300 };
const route = {id:"trip-0",geometry:[[18.46,73.84],[18.461,73.84]],distance_m:111,speed_kmh:5};
const comparison = { compare_id:"trip",recommended_id:route.id,routes:[route],
  origin:{lat:18.46,lon:73.84}, destination:{lat:18.461,lon:73.84} };
function reset(enabled=true) {
  cancelDynamicCheck();
  useMap.getState().set({compare:comparison,origin:{...comparison.origin,label:"Start"},destination:{...comparison.destination,label:"Destination"},loading:false,selectedRouteId:route.id});
  useNav.getState().set({active:true,routeId:route.id,startedAt:123,progressM:10,forceSimulation:true,simSpeed:4,paused:false});
  useGeo.getState().set({status:"simulated",lat:18.46,lon:73.84,accuracyM:8});
  useDynamicRerouting.getState().set({enabled,config,pending:null,trip:null,signature:null,cooldownUntil:0,error:null});
}
const reply=(signature="new")=>({suggest:true,arrived:false,reason:"A cooler route is available.",saving_min:0,heat_improvement_percent:20,conditions_signature:signature,comparison:null});
async function withFetch(fn,work){const original=globalThis.fetch;globalThis.fetch=fn;try{await work();}finally{globalThis.fetch=original;cancelDynamicCheck();}}

test("feature is opt-in; monitoring and ignoring a suggestion never change navigation",async()=>{
  reset(false);let calls=0;
  await withFetch(async()=>{calls++;return {ok:true,json:async()=>reply()};},async()=>{
    await checkDynamicRoute();assert.equal(calls,0);
    toggleDynamicRerouting(true);useDynamicRerouting.getState().set({config});
    const beforeMap=useMap.getState().compare,beforeId=useNav.getState().routeId;
    await checkDynamicRoute();assert.equal(useDynamicRerouting.getState().pending,null);
    useDynamicRerouting.getState().set({signature:"old"});
    await checkDynamicRoute();assert.ok(useDynamicRerouting.getState().pending);
    assert.equal(useMap.getState().compare,beforeMap);assert.equal(useNav.getState().routeId,beforeId);
  });
});
test("Continue keeps the current route and suppresses immediate requests",async()=>{
  reset();useDynamicRerouting.getState().set({pending:{result:reply(),trip:"123:trip:trip-0",expires:Date.now()+90000,source:"preview"}});
  const before=useMap.getState().compare;continueCurrentRoute();let calls=0;
  await withFetch(async()=>{calls++;return {ok:true,json:async()=>reply()};},async()=>{await checkDynamicRoute();});
  assert.equal(calls,0);assert.equal(useNav.getState().routeId,route.id);assert.equal(useMap.getState().compare,before);
  assert.ok(useDynamicRerouting.getState().cooldownUntil>=Date.now()+299000);
});
test("only confirmation accepts a freshly computed route from current position",async()=>{
  reset();const pos=currentPosition(route),next={...route,id:"new-0",geometry:[[pos.lat,pos.lon],[18.461,73.84]]};
  const updated={...comparison,compare_id:"new",recommended_id:next.id,routes:[next],origin:{lat:pos.lat,lon:pos.lon}};
  const calls=[];
  useDynamicRerouting.getState().set({pending:{result:reply(),trip:"123:trip:trip-0",expires:Date.now()+90000,source:"preview"}});
  await withFetch(async(url,opts)=>{calls.push([url,JSON.parse(opts.body)]);return {ok:true,json:async()=>({...reply(),comparison:updated})};},async()=>{await acceptDynamicSuggestion();});
  assert.match(calls[0][0],/\/accept$/);assert.equal(calls[0][1].consent,true);assert.deepEqual(calls[0][1].position,{lat:pos.lat,lon:pos.lon});
  assert.equal(useNav.getState().routeId,next.id);assert.equal(useNav.getState().simSpeed,4);assert.equal(useMap.getState().destination.label,"Destination");
});
test("expired consent and requests from an old trip cannot switch routes",async()=>{
  reset();useDynamicRerouting.getState().set({pending:{result:reply(),trip:"123:trip:trip-0",expires:Date.now()-1,source:"preview"}});
  let calls=0;await withFetch(async()=>{calls++;return {ok:true,json:async()=>reply()};},async()=>{await acceptDynamicSuggestion();});assert.equal(calls,0);
  reset();useDynamicRerouting.getState().set({signature:"old",trip:"123:trip:trip-0"});
  let finish;
  await withFetch(()=>new Promise(resolve=>{finish=resolve;}),async()=>{
    const work=checkDynamicRoute();useNav.getState().set({routeId:"other",startedAt:456});
    finish({ok:true,json:async()=>reply()});await work;
    assert.equal(useNav.getState().routeId,"other");assert.equal(useDynamicRerouting.getState().pending,null);
  });
});
test("poor GPS and failed checks keep existing guidance",async()=>{
  reset();useNav.getState().set({forceSimulation:false});useGeo.getState().set({status:"inside",lat:18.46,lon:73.84,accuracyM:100});
  assert.equal(currentPosition(route),null);
  reset();await withFetch(async()=>{throw new Error("offline");},async()=>{await checkDynamicRoute();});
  assert.equal(useNav.getState().routeId,route.id);assert.equal(useDynamicRerouting.getState().checking,false);
  assert.match(useDynamicRerouting.getState().error,/guidance continues/);
});
test("temporary check failures recover without changing the current route",async()=>{
  reset();useDynamicRerouting.getState().set({config:null});
  const before=useMap.getState().compare;let settingsCalls=0,checks=0;
  await withFetch(async(url)=>{
    if(url.endsWith("/settings")){settingsCalls++;return {ok:true,json:async()=>({...config,check_seconds:30})};}
    checks++;return checks===1?{ok:false}:{ok:true,json:async()=>reply("recovered")};
  },async()=>{
    await checkDynamicRoute();assert.match(useDynamicRerouting.getState().error,/guidance continues/);
    await checkDynamicRoute();assert.equal(useDynamicRerouting.getState().error,null);
    assert.equal(useDynamicRerouting.getState().signature,"recovered");
    assert.equal(settingsCalls,1);assert.equal(checks,2);
    assert.equal(useDynamicRerouting.getState().pending,null);
    assert.equal(useMap.getState().compare,before);assert.equal(useNav.getState().routeId,route.id);
  });
});
test("a new trip discards the previous trip's suggestion and condition baseline",async()=>{
  reset();useDynamicRerouting.getState().set({trip:"old-trip",signature:"old",cooldownUntil:Date.now()+300000,
    pending:{result:reply(),trip:"old-trip",expires:Date.now()+90000,source:"preview"}});
  let calls=0;
  await withFetch(async()=>{calls++;return {ok:true,json:async()=>reply()};},async()=>{await checkDynamicRoute();});
  assert.equal(calls,1);assert.equal(useDynamicRerouting.getState().pending,null);
  assert.equal(useDynamicRerouting.getState().trip,"123:trip:trip-0");
  assert.equal(useNav.getState().routeId,route.id);
});
