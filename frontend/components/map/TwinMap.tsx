"use client";

import * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { api, type BuildingProps, type EquityIndex, type InterventionKind, type InterventionResult, type PackedBuildings, type Poi } from "@/lib/api";
import { runIntervention, setEndpoint } from "@/lib/actions";
import { useBaseTime, useBusStops, useFrames, useMeta, useNearestFrame, usePois, useZone } from "@/lib/hooks";
import { useGeo } from "@/lib/geolocation";
import { fmtDelta, fmtTemp, heatColor, heatLabel, riskColor } from "@/lib/heatColorScale";
import { INTERVENTION_STYLE } from "@/lib/interventionStyle";
import { POI_STYLE } from "@/lib/poiStyle";
import { solarIntensity, solarPosition } from "@/lib/solar";
import { deviceProfile } from "@/lib/deviceProfile";
import { alongRoute, cumulative, metresBetween, useNav } from "@/lib/navigation";
import { atTime, keyframes, SCENARIO, TIMELINE, useMap, usePrefs } from "@/lib/store";
import { HeatTwinLayer } from "./three/HeatTwinLayer";
import { HeatTwinOverlayLayer, OVERLAY_LAYER_ID } from "./three/overlayLayer";
import { loadFields } from "./three/fields";
import type { SignalRecord } from "./three/signals";
import type { TreeRecord } from "./three/trees";
import { addFlatMapDetails, addWaterStopLayers, setFlatDetailsVisible, setFlatZoneData, setWaterStopData, WATER_LAYERS } from "./flatMapDetails";
import { showFacilityPopup, showBreakPopup } from "./facilityPopup";

// How much of the twin is built around the user's own starting point. Generous
// enough that the first view is a real neighbourhood rather than a keyhole, and
// nothing like the cost of drawing the whole Narhe-to-Swargate zone.
const INITIAL_REVEAL_M = 900;

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
// The convex-hull shadow fills are gone: they over-covered non-convex footprints
// (the true shadow is a Minkowski sum, not a hull) and the GPU sun-exposure field
// in the 3D layer now renders shadows from the same height raster the physics uses.
//
// The glowing cooling-corridor / hot-street lines and the hotspot heatmap are gone
// too: blurred neon over a physically lit scene read as a game overlay rather than
// an instrument. GET /api/heat/layers still serves the data — it is public API and
// listed in the open-data catalog — it is just no longer painted as neon.
const TWIN_LAYERS: string[] = [];

/** The flat map's route rendering. Hidden in the twin, which draws its own. */
const FLAT_ROUTE_LAYERS = ["route-casing", "route-halo", "route-heat", "route-core"];
maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
const equityCache = new Map<string, Promise<EquityIndex>>();

function pinEl(color: string, letter: string) {
  const d = document.createElement("div");
  d.className = "hm-pin";
  d.innerHTML = `<svg width="34" height="44" viewBox="0 0 34 44"><defs><linearGradient id="g${letter}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${color}" stop-opacity=".75"/></linearGradient></defs><path d="M17 43s14-14.6 14-26A14 14 0 0 0 3 17c0 11.4 14 26 14 26z" fill="url(#g${letter})" stroke="rgba(6,6,6,.9)" stroke-width="2"/><circle cx="17" cy="17" r="7.5" fill="#060606"/><text x="17" y="21" text-anchor="middle" font-size="10.5" font-weight="800" fill="${color}" font-family="system-ui">${letter}</text></svg>`;
  return d;
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function interventionEl(r: InterventionResult) {
  const s = INTERVENTION_STYLE[r.kind];
  const d = document.createElement("div");
  d.className = "hm-intervene-pin";
  d.style.setProperty("--c", s.color);
  d.title = `${s.short}: ${r.delta_c > 0 ? "+" : ""}${r.delta_c}°C here`;
  d.textContent = s.icon;
  return d;
}

function interventionPopupHtml(r: InterventionResult, units: "C" | "F") {
  const s = INTERVENTION_STYLE[r.kind];
  const cooler = r.delta_c < 0;
  return `
    <div style="min-width:230px">
      <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#adaaa5;margin-bottom:6px">
        <span>${s.icon}</span><span>${esc(r.label)} · ${r.radius_m|0} m radius</span>
      </div>
      <div style="display:flex;align-items:center;gap:14px">
        <div>
          <div style="font-size:9.5px;color:#858179;letter-spacing:.06em;text-transform:uppercase">Before</div>
          <div style="font-size:22px;font-weight:700;letter-spacing:-.02em;color:${heatColor(r.before.feels_c)}">${fmtTemp(r.before.feels_c, units)}</div>
        </div>
        <div style="color:#5d5a55;font-size:16px">→</div>
        <div>
          <div style="font-size:9.5px;color:#858179;letter-spacing:.06em;text-transform:uppercase">After</div>
          <div style="font-size:22px;font-weight:700;letter-spacing:-.02em;color:${heatColor(r.after.feels_c)}">${fmtTemp(r.after.feels_c, units)}</div>
        </div>
        <div style="margin-left:auto;text-align:right">
          <div style="font-size:9.5px;color:#858179;letter-spacing:.06em;text-transform:uppercase">Change</div>
          <div style="font-size:18px;font-weight:700;color:${cooler ? "#9dc06a" : "#fb8a1f"}">${fmtDelta(r.delta_c, units)}</div>
        </div>
      </div>
      <div style="font-size:11px;color:#908c84;margin-top:8px;line-height:1.4">${esc(r.note)}</div>
    </div>`;
}


/**
 * Rebuild GeoJSON features from the packed building arrays.
 *
 * Memoised on the payload object: the 2D fill source and the 3D extrusion layer
 * both need these, and over 56,276 footprints doing the work twice is a second of
 * main-thread time for nothing.
 */
const buildingCache = new WeakMap<PackedBuildings, GeoJSON.FeatureCollection<GeoJSON.Polygon, BuildingProps>>();

function unpackBuildings(p: PackedBuildings): GeoJSON.FeatureCollection<GeoJSON.Polygon, BuildingProps> {
  const hit = buildingCache.get(p);
  if (hit) return hit;
  const features: GeoJSON.Feature<GeoJSON.Polygon, BuildingProps>[] = new Array(p.n);
  for (let i = 0; i < p.n; i++) {
    const a = p.off[i], b = p.off[i + 1];
    const ring: GeoJSON.Position[] = new Array(b - a);
    for (let k = a; k < b; k++) ring[k - a] = [p.xy[k * 2], p.xy[k * 2 + 1]];
    features[i] = {
      type: "Feature",
      id: i,
      properties: {
        height_m: p.h[i],
        typology: p.typologies[p.t[i]] as BuildingProps["typology"],
        height_source: p.height_sources[p.hs[i]] as BuildingProps["height_source"],
        seed: p.seed[i],
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    };
  }
  const fc: GeoJSON.FeatureCollection<GeoJSON.Polygon, BuildingProps> = {
    type: "FeatureCollection", features,
  };
  buildingCache.set(p, fc);
  return fc;
}

export default function TwinMap() {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // readiness is tied to a specific map instance, so effects never touch a map that is still loading
  const [ready, setReady] = useState<maplibregl.Map | null>(null);
  const layerRef = useRef<HeatTwinLayer | null>(null);
  const [layerEpoch, setLayerEpoch] = useState(0);
  const odMarkers = useRef<maplibregl.Marker[]>([]);
  const chipMarkers = useRef<Map<string, maplibregl.Marker>>(new Map());
  const spotMarkers = useRef<maplibregl.Marker[]>([]);
  const interventionMarkersRef = useRef<maplibregl.Marker[]>([]);
  const communityMarkersRef = useRef<maplibregl.Marker[]>([]);
  const breakMarkersRef = useRef<maplibregl.Marker[]>([]);
  const meMarker = useRef<maplibregl.Marker | null>(null);
  const arrowMarker = useRef<maplibregl.Marker | null>(null);
  const fittedFor = useRef<string | null>(null);
  const segmentColors = useRef(new Map<string, string>());

  const meta = useMeta();
  const zone = useZone();
  const pois = usePois();
  const base = useBaseTime();
  const frames = useFrames((s) => s.frames);
  const nearest = useNearestFrame();
  const mode = useMap((s) => s.mode);
  const timeMin = useMap((s) => s.timeMin);
  const compare = useMap((s) => s.compare);
  const selected = useMap((s) => s.selectedRouteId);
  const travelMode = usePrefs((s) => s.mode);
  const timeScrubbing = useMap((s) => s.timeScrubbing);
  const navActive = useNav((s) => s.active);
  const navRouteId = useNav((s) => s.routeId);
  const busStops = useBusStops();
  const origin = useMap((s) => s.origin);
  const destination = useMap((s) => s.destination);
  const pickMode = useMap((s) => s.pickMode);
  const flyTo = useMap((s) => s.flyTo);
  const simOffset = useMap((s) => s.simOffsetMin);
  const tempDelta = useMap((s) => s.tempDelta);
  const interventionResults = useMap((s) => s.interventionResults);
  const revealOn = useMap((s) => s.revealOn);
  const equityOn = useMap((s) => s.equityOn);
  const [approvedPois, setApprovedPois] = useState<Awaited<ReturnType<typeof api.communityPois>> | null>(null);
  const scenario = SCENARIO;
  const units = usePrefs((s) => s.units);
  const reduceMotion = usePrefs((s) => s.reduceMotion);

  // ───────── init ─────────
  useEffect(() => {
    if (!el.current || !meta.data) return;
    const [s, w, n, e] = meta.data.zone.bbox;
    const start = useMap.getState().startAt;
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;inset:0";
    el.current.appendChild(host);
    const map = new maplibregl.Map({
      container: host,
      // Every fragment cost in the scene — ground heat, buildings, canopy, the sun
      // march's consumers — scales with this. A phone at DPR 3 renders nine times
      // the fragments of DPR 1 for a difference almost nobody can resolve on a
      // 6-inch panel, so mobile is capped at 2 and desktop is left untouched.
      pixelRatio: Number.isFinite(deviceProfile().maxPixelRatio)
        ? Math.min(window.devicePixelRatio || 1, deviceProfile().maxPixelRatio)
        : undefined,
      style: {
        version: 8,
        sources: {
          base: { type: "raster", tiles: [`${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 16, attribution: "© OpenStreetMap contributors · Esri" },
          labels: { type: "raster", tiles: [`${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`], tileSize: 256, maxzoom: 16 },
        },
        layers: [
          { id: "bg", type: "background", paint: { "background-color": "#04060b" } },
          { id: "base", type: "raster", source: "base", paint: { "raster-saturation": -0.4, "raster-brightness-max": 0.8, "raster-contrast": 0.1 } },
        ],
      },
      // Open on the user's own starting point, not the middle of the zone. The
      // zone centre is Dhankawadi, which is nowhere in particular if you are in
      // Narhe or Swargate, and opening there would show an empty basemap because
      // nothing is revealed until the twin is built around where you actually are.
      center: start
        ? [start.lon, start.lat]
        : [(w + e) / 2 - 0.0015, (s + n) / 2 + 0.0008],
      zoom: start ? 16.4 : 15.4,
      minZoom: 13.5,
      maxZoom: 19.5,
      maxPitch: 72,
      maxBounds: [
        [w - 0.02, s - 0.015],
        [e + 0.02, n + 0.015],
      ],
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.on("load", () => {
      map.addSource("water", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "water", type: "fill", source: "water", paint: { "fill-color": "#16201f", "fill-opacity": 0.75, "fill-outline-color": "#3d4f4a" } });
      map.addLayer({ id: "labels", type: "raster", source: "labels", paint: { "raster-opacity": 0.75 } });
      map.addSource("equity", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "equity", type: "fill", source: "equity", layout: { visibility: "none" },
        paint: {
          "fill-color": [
            "interpolate", ["linear"], ["get", "vulnerability"],
            0, "rgba(40,42,38,0)", 25, "rgba(178,166,82,.28)", 50, "rgba(232,162,56,.42)", 75, "rgba(241,108,44,.6)", 100, "rgba(223,52,44,.72)",
          ],
          // The surface is a grid of abutting translucent squares. Antialiasing each
          // one separately double-blends every shared edge, which drew a visible mesh
          // of seams over the whole city — an artefact of the tiling, not a feature of
          // the data. These polygons share exact edges, so they need no antialiasing.
          "fill-antialias": false,
          "fill-opacity-transition": { duration: 400 },
        },
      });
      map.addSource("buildings", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "buildings-2d", type: "fill", source: "buildings", minzoom: 15, paint: { "fill-color": ["interpolate", ["linear"], ["get", "height_m"], 0, "#303d46", 15, "#43525c", 40, "#5c686c"], "fill-opacity": 0.9, "fill-outline-color": "#718087" } });
      map.addSource("pois", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "pois", type: "circle", source: "pois", minzoom: 14.5, layout: { visibility: "none" },
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, ["case", ["get", "on"], 4.5, 1.8], 18, ["case", ["get", "on"], 8, 4]],
          "circle-opacity": ["case", ["get", "on"], 1, 0.55],
          "circle-stroke-color": "#060606",
          "circle-stroke-width": ["case", ["get", "on"], 2, 0.5],
        },
      });
      // Bus stops. Two layers so the boarding and alighting stops of the chosen
      // itinerary read as chosen, rather than as two of ninety-eight identical dots.
      map.addSource("bus-stops", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "bus-stops", type: "circle", source: "bus-stops", minzoom: 12,
        paint: {
          "circle-color": ["case", ["get", "on"], "#5bb8d4", "#2c6a7d"],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, ["case", ["get", "on"], 5, 2], 17, ["case", ["get", "on"], 11, 5]],
          "circle-opacity": ["case", ["get", "on"], 1, 0.7],
          "circle-stroke-color": "#060606",
          "circle-stroke-width": ["case", ["get", "on"], 2.5, 0.6],
        },
      });
      map.addLayer({
        id: "bus-stop-labels", type: "symbol", source: "bus-stops",
        filter: ["get", "on"],
        layout: {
          "text-field": ["get", "name"],
          "text-size": 12,
          "text-offset": [0, 1.5],
          "text-anchor": "top",
          "text-max-width": 9,
        },
        paint: { "text-color": "#cfe9f2", "text-halo-color": "#060606", "text-halo-width": 1.6 },
      });
      map.addSource("routes", { type: "geojson", data: EMPTY });
      map.addSource("route-seg", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "route-casing", type: "line", source: "routes", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#020306", "line-width": ["case", ["get", "sel"], 15, 9], "line-opacity": ["case", ["get", "sel"], 0.9, 0.55] } });
      map.addLayer({ id: "route-halo", type: "line", source: "routes", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": ["case", ["get", "sel"], 12, 6], "line-opacity": ["case", ["get", "sel"], 0.55, 0.28], "line-blur": ["case", ["get", "sel"], 2, 0] } });
      map.addLayer({ id: "route-heat", type: "line", source: "route-seg", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["coalesce", ["feature-state", "c"], ["get", "c"]], "line-width": ["case", ["get", "sel"], 6, 3], "line-opacity": ["case", ["get", "sel"], 1, 0.5] } });
      // static centre-line on the selected route (no motion — routes update in place)
      map.addLayer({ id: "route-core", type: "line", source: "routes", filter: ["get", "sel"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 1.5, "line-opacity": 0.85 } });
      addFlatMapDetails(map);
      addWaterStopLayers(map);
      setReady(map);
    });

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      setReady(null);
      mapRef.current = null;
      map.remove();
      host.remove();
    };
  }, [meta.data]);

  // ───────── static zone data ─────────
  useEffect(() => {
    const map = ready;
    if (!ready || !map || !zone.data) return;
    (map.getSource("buildings") as maplibregl.GeoJSONSource).setData(unpackBuildings(zone.data.buildings));
    setFlatZoneData(map, zone.data);
    (map.getSource("water") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: zone.data.surfaces.features.filter((f) => f.properties?.kind === "water"),
    });
  }, [ready, zone.data]);

  // ───────── the 3D twin: one custom layer inside MapLibre's own GL context ─────────
  // Replaces thirteen PNG image sources whose opacity was cross-faded. That blended
  // COLOURS: mixing the teal of "now" with the orange of "+1h" landed on an olive that
  // matches no temperature on the scale. The layer mixes the two keyframes in encoded
  // temperature space and applies the colour ramp afterwards.
  useEffect(() => {
    const map = ready;
    if (!ready || !map || !zone.data) return;
    let dead = false;
    let added: HeatTwinLayer | null = null;

    loadFields()
      .then((fields) => {
        if (dead || !mapRef.current) return;
        const flat = zone.data!.trees;
        const trees: TreeRecord[] = new Array(flat.length / 4);
        for (let i = 0, j = 0; i < flat.length; i += 4, j++) {
          trees[j] = { lon: flat[i], lat: flat[i + 1], radiusM: flat[i + 2], density: flat[i + 3] };
        }
        const signals: SignalRecord[] = (zone.data!.signals?.features ?? []).map((f) => {
          const c = (f.geometry as GeoJSON.Point).coordinates;
          return { lat: c[1], lon: c[0], kind: f.properties.kind, crossing: f.properties.crossing };
        });
        const layer = new HeatTwinLayer(
          fields,
          unpackBuildings(zone.data!.buildings).features,
          trees,
          zone.data!.roads.features,
          zone.data!.junctions ?? [],
          signals,
        );
        // above the basemap, below the labels and every vector overlay
        map.addLayer(layer, "labels");
        // ...and the twin's annotations above all of them. The route line is drawn
        // after the twin by design, which also put it over the temperature plaques
        // describing that very route; this second pass puts them back on top.
        map.addLayer(new HeatTwinOverlayLayer(layer));
        layerRef.current = layer;
        added = layer;

        // Build the twin where the user actually is, and nowhere else.
        //
        // Onboarding resolves `startAt` before anyone reaches this screen, so there is
        // always a real place to start from -- a position fix where the browser gave
        // one, otherwise a start the user picked. Seeding from the map centre instead
        // would put a circle of city in the middle of the zone regardless of where the
        // user stands, which is exactly what this replaces. If startAt is somehow
        // missing, nothing is revealed: "Use my location" and planning a trip are both
        // still there, and an honest empty map beats a plausible wrong one.
        const at = useMap.getState().startAt;
        if (at) layer.addPositionFix(at.lat, at.lon, INITIAL_REVEAL_M);

        setLayerEpoch((n) => n + 1);
      })
      .catch(() => {});

    return () => {
      dead = true;
      const m = mapRef.current;
      // The overlay borrows the twin's renderer, so it has to go first: left behind,
      // it would keep asking a disposed renderer for another pass.
      if (m && m.getLayer(OVERLAY_LAYER_ID)) m.removeLayer(OVERLAY_LAYER_ID);
      if (added && m && m.getLayer(added.id)) m.removeLayer(added.id);
      layerRef.current = null;
    };
  }, [ready, zone.data]);

  // the two keyframes bracketing the scrub position, blended in temperature space
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const { i0, i1, t } = keyframes(timeMin);
    layer.setKeyframes(frames[i0] ?? null, frames[i1] ?? null, t);
  }, [frames, timeMin, layerEpoch]);

  // ───────── follow the user: reveal the twin along the path walked ─────────
  // Each fix paints into the reveal field, and ground already covered stays visible,
  // so the twin builds up along the route rather than pulsing around a moving disc.
  useEffect(() => {
    const map = ready;
    if (!map) return;
    let lastReveal: [number, number] | null = null;
    const updatePosition = () => {
      const { lat, lon, status } = useGeo.getState();
      if (lat === null || lon === null) {
        meMarker.current?.remove();
        meMarker.current = null;
        return;
      }
      // Reveal need only be painted after a few metres, not on every video frame.
      if (!lastReveal || metresBetween(lastReveal, [lat, lon]) >= 5) {
        layerRef.current?.addPositionFix(lat, lon);
        lastReveal = [lat, lon];
      }
      // Keep the planned origin fixed during guidance; moving it used to rebuild
      // endpoint markers and notify the whole app as the simulation advanced.
      const cur = useMap.getState().origin;
      if (!useNav.getState().active && (!cur || Math.abs(cur.lat - lat) > 1e-4 || Math.abs(cur.lon - lon) > 1e-4)) {
        useMap.getState().set({ origin: { lat, lon, label: status === "simulated" ? "Simulated position" : "My location" } });
      }
      if (!meMarker.current) {
        const d = document.createElement("div");
        d.className = "hm-me";
        meMarker.current = new maplibregl.Marker({ element: d }).setLngLat([lon, lat]).addTo(map);
      } else meMarker.current.setLngLat([lon, lat]);
      meMarker.current.getElement().dataset.sim = status === "simulated" ? "1" : "0";
    };
    updatePosition();
    // Position moves imperative map objects, without rerendering the scene tree.
    return useGeo.subscribe(updatePosition);
  }, [ready, layerEpoch]);

  useEffect(() => {
    layerRef.current?.setRevealEnabled(revealOn);
  }, [revealOn, layerEpoch]);

  // ───────── reveal the corridor the trip actually goes through ─────────
  // Planning a trip is the strongest statement a user makes about which part of the
  // city they care about, so it is what loads the twin there: the selected route's
  // band lights up with its buildings, canopy, road surface and heat, and the rest
  // of the zone stays dark rather than rendering a whole city nobody asked to see.
  // Reveal accumulates, so switching between alternatives adds their corridors
  // instead of wiping the one already shown.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !compare?.routes?.length) return;
    const route = compare.routes.find((r) => r.id === selected) ?? compare.routes[0];
    if (!route?.geometry?.length) return;
    layer.revealRoute(route.geometry);
    // Inspect temperature by clicking the map; reserve pins for useful places.
    layer.setRoutePins([]);
    // The route as geometry in the twin. MapLibre's own line layers sit on the
    // basemap plane, which stopped being the ground the moment the twin started
    // standing on real elevation.
    layer.setRouteLines(
      compare.routes
        .filter((r) => r.geometry?.length)
        .map((r) => ({ geometry: r.geometry, color: r.color, selected: r.id === route.id })),
    );
    if (!useMap.getState().revealOn) useMap.getState().set({ revealOn: true });
  }, [compare, selected, layerEpoch]);

  // A cleared trip takes its pins with it, otherwise the last route's profile is
  // left standing on a map that no longer has a route on it.
  useEffect(() => {
    if (!compare) {
      layerRef.current?.setRoutePins([]);
      layerRef.current?.setRouteLines([]);
    }
  }, [compare, layerEpoch]);

  useEffect(() => {
    return () => {
      meMarker.current?.remove();
      meMarker.current = null;
    };
  }, []);

  // canopy planted by the intervention simulator becomes real geometry, which the
  // next sun march then casts a real shadow from
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.setPlantedTrees(
      interventionResults
        .filter((r) => r.kind === "trees")
        .map((r) => ({
          lat: r.center.lat,
          lon: r.center.lon,
          radiusM: Math.max(4, r.radius_m * 0.45),
          density: 0.85,
        })),
    );
  }, [interventionResults, layerEpoch]);

  // ───────── continuous sun ─────────
  // The backend reports sun position per 15-minute keyframe, so driving the light from
  // the nearest keyframe made shadows jump a quarter hour at a time while scrubbing.
  // solarPosition() is a straight port of the backend's NOAA algorithm, so evaluating
  // it at the exact scrub time is free, gives continuously moving shadows, and cannot
  // drift from the model that produced the temperatures.
  useEffect(() => {
    const map = ready;
    if (!ready || !map || !meta.data || !base) return;
    const when = new Date(new Date(base).getTime() + (simOffset + timeMin) * 60_000);
    const [lat, lon] = meta.data.zone.center;
    const { elevationDeg, azimuthDeg } = solarPosition(when, lat, lon);
    // Prefer the backend's measured clearness so the GPU sun and the physics that
    // produced the temperatures cannot disagree about how bright the sky is.
    const intensity = solarIntensity(elevationDeg, nearest?.weather.cloud_pct ?? 0, nearest?.sun?.clearness);

    map.setLight({
      anchor: "map",
      position: [1.4, azimuthDeg, Math.min(88, Math.max(8, 90 - elevationDeg))],
      color: elevationDeg > 0 ? "#fff1dc" : "#c9c2b4",
      intensity: elevationDeg > 0 ? 0.5 : 0.18,
    });
    layerRef.current?.setSun({
      elevationDeg,
      azimuthDeg,
      intensity,
      airC: nearest?.weather.air_c ?? 30,
    });
  }, [ready, meta.data, base, simOffset, timeMin, nearest, layerEpoch]);

  // ───────── mode: Map ↔ Heat Twin ─────────
  useEffect(() => {
    const map = ready;
    if (!ready || !map) return;
    const twin = mode === "twin";
    TWIN_LAYERS.forEach((id) => map.setLayoutProperty(id, "visibility", twin ? "visible" : "none"));
    // The route swaps representation with the mode. MapLibre's line layers are
    // right on the flat map and wrong in the twin: they are painted on the basemap
    // plane, so with the ground standing on real elevation they sit under the hill
    // instead of on the street. The twin draws the route as geometry through the
    // same lift the roads use, and these come off so the two are never both up.
    FLAT_ROUTE_LAYERS.forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", twin ? "none" : "visible");
    });
    // MAP mode keeps its flat footprints; the 3D layer eases its own extrusions in and
    // out of the ground from inside the render loop, so there is no RAF to drive here.
    map.setLayoutProperty("buildings-2d", "visibility", twin ? "none" : "visible");
    setFlatDetailsVisible(map, !twin);
    map.setPaintProperty("labels", "raster-opacity", twin ? 0.35 : 0.25);
    map.setPaintProperty("base", "raster-opacity", twin ? 1 : ["interpolate", ["linear"], ["zoom"], 14, 0.9, 16, 0.35, 18, 0.15]);
    // While guidance is running the chase camera owns pitch, bearing and zoom.
    // Entering the twin is part of starting navigation, so this easeTo would fire at
    // exactly the wrong moment and yank the view back to the fixed -28 degrees.
    if (!useNav.getState().active) {
      map.easeTo({ pitch: twin ? 62 : 0, bearing: twin ? -28 : 0, zoom: twin ? Math.max(map.getZoom(), 16) : map.getZoom(), duration: reduceMotion ? 0 : 1400, easing: (x) => 1 - Math.pow(1 - x, 4) });
    }
    layerRef.current?.setMode(twin);
  }, [ready, mode, reduceMotion, layerEpoch]);

  // ───────── shadow march: coarse while scrubbing, exact at rest ─────────
  useEffect(() => {
    layerRef.current?.setSunMoving(timeScrubbing);
  }, [timeScrubbing, layerEpoch]);

  // ───────── navigation: the chase camera ─────────
  // Follows the same progress value the HUD reads, so the instruction on screen and
  // the street under the camera can never disagree. The camera is driven per frame
  // rather than by easeTo: easing to each new position would queue animations that
  // fight the next one and make the view swim.
  useEffect(() => {
    const map = ready;
    if (!ready || !map || !navActive) return;
    const route = compare?.routes.find((r) => r.id === navRouteId);
    if (!route?.geometry?.length) return;

    const cum = cumulative(route.geometry);
    let raf = 0;
    let bearing = map.getBearing();
    let previousTime = performance.now();
    let shown = map.getCenter();
    let pitch = map.getPitch();
    let zoom = map.getZoom();
    map.stop();
    const step = (time: number) => {
      const { progressM } = useNav.getState();
      // Look a little ahead of the traveller: aiming the camera exactly at them puts
      // the turn they are being told about off the bottom of the screen.
      const lead = alongRoute(route.geometry, cum, progressM + 28);
      // Shortest-arc damping, or the camera spins the long way round through north.
      const dt = Math.min(0.1, (time - previousTime) / 1000);
      previousTime = time;
      const damping = reduceMotion ? 1 : 1 - Math.exp(-10 * dt);
      const twin = mode === "twin";
      const delta = (((twin ? lead.bearing : 0) - bearing + 540) % 360) - 180;
      bearing += delta * damping;
      const lat = shown.lat + (lead.position[0] - shown.lat) * damping;
      const lon = shown.lng + (lead.position[1] - shown.lng) * damping;
      const nextPitch = pitch + ((twin ? 60 : 0) - pitch) * damping;
      const nextZoom = zoom + ((twin ? 17.4 : 16.9) - zoom) * damping;
      // Paused and completed trips settle without repeatedly repainting a still map.
      if (Math.abs(lat - shown.lat) + Math.abs(lon - shown.lng) > 1e-9 || Math.abs(delta) > 0.02 || Math.abs(nextPitch - pitch) + Math.abs(nextZoom - zoom) > 0.002) {
        shown = new maplibregl.LngLat(lon, lat);
        pitch = nextPitch;
        zoom = nextZoom;
        map.jumpTo({ center: shown, bearing, pitch, zoom });
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [ready, navActive, navRouteId, compare, reduceMotion, mode]);

  // Temperature is available through map inspection; keep place pins uncluttered.
  useEffect(() => {
    spotMarkers.current.forEach((m) => m.remove());
    spotMarkers.current = [];
  }, [ready, mode, nearest, units]);

  // ───────── intervention simulator pins (SDG 13/15) ─────────
  useEffect(() => {
    const map = ready;
    interventionMarkersRef.current.forEach((m) => m.remove());
    interventionMarkersRef.current = [];
    if (!ready || !map) return;
    interventionResults.forEach((r) => {
      const m = new maplibregl.Marker({ element: interventionEl(r), anchor: "center" })
        .setLngLat([r.center.lon, r.center.lat])
        .setPopup(new maplibregl.Popup({ maxWidth: "280px", offset: 14 }).setHTML(interventionPopupHtml(r, units)))
        .addTo(map);
      interventionMarkersRef.current.push(m);
    });
  }, [ready, interventionResults, units]);

  // ───────── heat vulnerability overlay (SDG 10) ─────────
  useEffect(() => {
    const map = ready;
    if (!ready || !map) return;
    // In the 3D twin the index is rendered as lit relief on the GPU instead, at the
    // full 10 m grid. Showing the flat polygon surface underneath it as well would
    // double-tint the same number and z-fight with the terrain it sits on.
    const flat = equityOn && mode !== "twin";
    map.setLayoutProperty("equity", "visibility", flat ? "visible" : "none");
    layerRef.current?.setEquity(equityOn);
    if (!equityOn || !nearest || !base) return;
    const key = `${scenario}|${nearest.time}|${tempDelta}`;
    const ctrl = { dead: false };
    if (!equityCache.has(key)) {
      const p = api.equity({ scenario, time: nearest.time, temp_delta: tempDelta });
      p.catch(() => equityCache.delete(key));
      equityCache.set(key, p);
    }
    equityCache.get(key)!.then((d) => {
      if (ctrl.dead || !mapRef.current) return;
      (map.getSource("equity") as maplibregl.GeoJSONSource).setData(d.surface);
    });
    return () => {
      ctrl.dead = true;
    };
  }, [ready, equityOn, mode, nearest, scenario, tempDelta, base, layerEpoch]);

  // ───────── community-verified hydration/rest points (SDG 6) ─────────
  useEffect(() => {
    let dead = false;
    api.communityPois().then((r) => !dead && setApprovedPois(r)).catch(() => {});
    return () => {
      dead = true;
    };
  }, []);

  useEffect(() => {
    const map = ready;
    communityMarkersRef.current.forEach((m) => m.remove());
    communityMarkersRef.current = [];
    if (!ready || !map) return;
    const addMarker = (lat: number, lon: number, kind: string, name: string) => {
      const color = POI_STYLE[kind as keyof typeof POI_STYLE]?.color ?? "#9dc06a";
      const d = document.createElement("div");
      d.className = "hm-community-pin";
      d.style.setProperty("--c", color);
      d.title = `${esc(name)} (${kind}) — community-verified`;
      communityMarkersRef.current.push(new maplibregl.Marker({ element: d, anchor: "center" }).setLngLat([lon, lat]).addTo(map));
    };
    approvedPois?.features.forEach((f) => addMarker(f.geometry.coordinates[1], f.geometry.coordinates[0], f.properties.kind, f.properties.name));
  }, [ready, approvedPois]);

  // ───────── hydration and rest stops on the selected route ─────────
  //
  // These are not POIs. A POI is a place that exists; a break is a moment in the
  // walk where this person, at this pace, in today's heat and humidity, will have
  // sweated out enough to need a drink. Some of them land on a mapped tap and some
  // of them land nowhere at all, and the pin says which -- a hollow ring where
  // there is no source is the most useful thing the map can show about the stretches
  // of this city that have no public water.
  useEffect(() => {
    const map = ready;
    breakMarkersRef.current.forEach((m) => m.remove());
    breakMarkersRef.current = [];
    if (!ready || !map) return;
    const route = compare?.routes.find((r) => r.id === selected) ?? compare?.routes[0];
    const stops = route?.breaks?.stops ?? [];
    // The twin draws these as standing beacons instead; see breakBeacons.ts. The DOM
    // marker stays in place either way because it is the click target, but it is
    // made transparent in the twin so a flat sticker is not laid over the beacon.
    layerRef.current?.setBreakStops(
      stops.filter((st) => st.lat !== null && st.lon !== null)
        .map((st) => ({ lat: st.lat!, lon: st.lon!, type: st.type, hasSource: st.has_source })),
    );
    for (const st of stops) {
      if (st.lat === null || st.lon === null) continue;
      const d = document.createElement("div");
      d.className = `hm-break-pin${st.has_source ? "" : " dry"}${mode === "twin" ? " in-twin" : ""}`;
      d.dataset.kind = st.type;
      d.innerHTML = st.type === "rest" ? "&#9612;" : "";
      d.title = `${st.type === "rest" ? "Rest" : "Drink"} at ${(st.at_m / 1000).toFixed(1)} km`;
      // MapLibre detects a map click from mousedown/pointerdown on the canvas
      // container, and markers are children of it, so stopping only the click event
      // still let the tap fall through and open the map's own inspect popup over
      // this sheet. Every step of the gesture has to be stopped.
      for (const type of ["pointerdown", "mousedown", "touchstart"]) {
        d.addEventListener(type, (ev) => ev.stopPropagation());
      }
      d.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        showBreakPopup(map, st);
      });
      breakMarkersRef.current.push(
        new maplibregl.Marker({ element: d, anchor: "center" }).setLngLat([st.lon, st.lat]).addTo(map),
      );
    }
  }, [ready, compare, selected, mode, layerEpoch]);

  // ───────── the traveller's arrow on the selected route ─────────
  //
  // A route drawn as a line says where to go but not which end you are at, and once
  // guidance starts the chase camera moves the whole world under a view that has
  // nothing in it standing for the person. The arrow is that: it sits at the start
  // of the selected route the moment one is picked, points along the first leg, and
  // slides and turns with the route as the trip progresses.
  //
  // Driven from the same `progressM` the HUD instruction reads, per animation frame
  // rather than through React state. A setState per frame would re-render the whole
  // map component sixty times a second to move one element; and easing the marker
  // in CSS instead would leave it trailing the camera that is following it.
  useEffect(() => {
    const map = ready;
    if (arrowMarker.current) {
      arrowMarker.current.remove();
      arrowMarker.current = null;
    }
    if (!ready || !map) return;
    const route = compare?.routes.find((r) => r.id === selected);
    const geometry = route?.geometry;
    if (!route || !geometry || geometry.length < 2) return;

    const el = document.createElement("div");
    el.className = "hm-travel-arrow";
    el.innerHTML =
      `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">` +
      `<circle cx="12" cy="12" r="11" fill="#060606" fill-opacity=".72"/>` +
      `<circle cx="12" cy="12" r="11" stroke="${route.color}" stroke-width="1.6"/>` +
      `<path d="M12 5.4 L17.2 17.4 L12 14.3 L6.8 17.4 Z" fill="${route.color}"/>` +
      `</svg>`;
    const inner = el.firstElementChild as SVGElement;
    const marker = new maplibregl.Marker({ element: el, anchor: "center", pitchAlignment: "map", rotationAlignment: "map" })
      // Seated at the route's first vertex before it is added. addTo() reads the
      // marker's own LngLat to place it, and the per-frame loop below does not run
      // until the next frame, so adding it unpositioned throws on `undefined.lng`.
      .setLngLat([geometry[0][1], geometry[0][0]]);
    arrowMarker.current = marker;

    const cum = cumulative(geometry);
    let raf = 0;
    let shownBearing: number | null = null;
    let lastProgress = -1;
    const place = () => {
      const nav = useNav.getState();
      const progress = nav.active && nav.routeId === route.id ? nav.progressM : 0;
      const along = alongRoute(geometry, cum, progress);
      if (progress !== lastProgress) {
        marker.setLngLat([along.position[1], along.position[0]]);
        lastProgress = progress;
      }
      // Damp the heading the same way the camera does, so the two do not disagree
      // by a few degrees every frame on a curving street.
      if (shownBearing === null) shownBearing = along.bearing;
      else shownBearing += (((along.bearing - shownBearing + 540) % 360) - 180) * (reduceMotion ? 1 : 0.18);
      inner.style.transform = `rotate(${shownBearing}deg)`;
      if (nav.active && nav.routeId === route.id) raf = requestAnimationFrame(place);
    };
    marker.addTo(map);
    raf = requestAnimationFrame(place);
    return () => {
      cancelAnimationFrame(raf);
      marker.remove();
      if (arrowMarker.current === marker) arrowMarker.current = null;
    };
  }, [ready, compare, selected, reduceMotion, navActive, navRouteId]);

  // ───────── bus stops ─────────
  // Only while the bus is in play. Ninety-eight dots over a walking route would be
  // noise; the same dots while planning a bus trip are the thing being chosen
  // between, and the boarding and alighting stops are named.
  useEffect(() => {
    const map = ready;
    if (!ready || !map) return;
    const src = map.getSource("bus-stops") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const busRoute = compare?.routes.find((r) => r.tags.includes("transit"));
    const show = travelMode === "bus" && !!busStops.data;
    if (!show) {
      src.setData(EMPTY);
      return;
    }
    const chosen = new Set([busRoute?.transit?.board.id, busRoute?.transit?.alight.id].filter(Boolean));
    src.setData({
      type: "FeatureCollection",
      features: busStops.data!.features.map((f) => ({
        ...f,
        properties: { ...f.properties, on: chosen.has(f.properties.id) },
      })),
    });
  }, [ready, travelMode, busStops.data, compare]);

  // ───────── POIs ─────────
  useEffect(() => {
    const map = ready;
    if (!ready || !map || !pois.data) return;
    const route = compare?.routes.find((r) => r.id === selected);
    const along = new Set(route?.pois_along_route.map((p) => p.id) ?? []);
    // Water remains visible across the zone even after selecting a route.
    setWaterStopData(map, pois.data, along);
    (map.getSource("pois") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: pois.data.features
        .filter((f) => f.properties.source === "osm" || along.has(f.properties.id))
        .map((f) => ({ ...f, properties: { ...f.properties, color: POI_STYLE[f.properties.type].color, on: along.has(f.properties.id) } })),
    });
  }, [ready, pois.data, compare, selected]);

  // Route geometry changes only when planning or selecting, not during playback.
  useEffect(() => {
    const map = ready;
    if (!ready || !map) return;
    const routes = compare?.routes ?? [];
    const time = useMap.getState().timeMin;
    map.removeFeatureState({ source: "route-seg" });
    segmentColors.current.clear();
    const order = [...routes].sort((a, b) => (a.id === selected ? 1 : 0) - (b.id === selected ? 1 : 0));
    (map.getSource("routes") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: order.map((r) => ({
        type: "Feature",
        properties: { id: r.id, color: r.color, sel: r.id === selected },
        geometry: { type: "LineString", coordinates: r.geometry.map(([la, lo]) => [lo, la]) },
      })),
    });
    (map.getSource("route-seg") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: order.flatMap((r) =>
        r.segments.map((s, i) => ({
          type: "Feature" as const,
          id: `${r.id}:${i}`,
          properties: { c: heatColor(atTime(s.feels, time)), sel: r.id === selected },
          geometry: { type: "LineString" as const, coordinates: s.coords.map(([la, lo]) => [lo, la]) },
        })),
      ),
    });
  }, [ready, compare, selected]);

  // Only update paint state during the timeline; avoid repeatedly serialising and
  // sending the entire route geometry to MapLibre's worker.
  useEffect(() => {
    const map = ready;
    if (!map) return;
    const routes = compare?.routes ?? [];
    for (const route of routes) route.segments.forEach((segment, i) => {
      const id = `${route.id}:${i}`;
      const color = heatColor(atTime(segment.feels, timeMin));
      if (segmentColors.current.get(id) !== color) {
        map.setFeatureState({ source: "route-seg", id }, { c: color });
        segmentColors.current.set(id, color);
      }
    });
    // score chips
    const seen = new Set<string>();
    for (const r of routes) {
      seen.add(r.id);
      const score = atTime(r.forecast.map((f) => f.score), timeMin);
      const sel = r.id === selected;
      let m = chipMarkers.current.get(r.id);
      if (!m) {
        const d = document.createElement("div");
        d.className = "hm-route-chip";
        d.addEventListener("click", (ev) => {
          ev.stopPropagation();
          useMap.getState().set({ selectedRouteId: r.id });
        });
        const mid = r.geometry[Math.floor(r.geometry.length * 0.45)];
        m = new maplibregl.Marker({ element: d }).setLngLat([mid[1], mid[0]]).addTo(map);
        chipMarkers.current.set(r.id, m);
      }
      const d = m.getElement();
      d.style.background = sel ? r.color : "rgba(14,13,12,.82)";
      d.style.color = sel ? "#060606" : r.color;
      d.style.border = `1px solid ${r.color}${sel ? "" : "80"}`;
      d.style.zIndex = sel ? "5" : "1";
      d.innerHTML = `${r.label.replace("Route ", "")} <span style="opacity:.55;margin:0 2px">·</span> <span style="color:${sel ? "#060606" : riskColor(score)}">${Math.round(score)}</span>`;
    }
    chipMarkers.current.forEach((m, id) => {
      if (!seen.has(id)) {
        m.remove();
        chipMarkers.current.delete(id);
      }
    });
  }, [ready, compare, selected, timeMin]);

  // fit to a new comparison
  useEffect(() => {
    const map = ready;
    if (!ready || !map || !compare || fittedFor.current === compare.compare_id) return;
    fittedFor.current = compare.compare_id;
    const b = new maplibregl.LngLatBounds();
    compare.routes.forEach((r) => r.geometry.forEach(([la, lo]) => b.extend([lo, la])));
    const wide = window.innerWidth >= 768;
    // Frame the routes inside the free map area — never under the route sheet, timeline or nav.
    map.fitBounds(b, {
      padding: wide ? { top: 110, bottom: 140, left: 410, right: 110 } : { top: 130, bottom: 300, left: 36, right: 76 },
      maxZoom: 17.5,
      duration: reduceMotion ? 0 : 1200,
      pitch: map.getPitch(),
      bearing: map.getBearing(),
    });
  }, [ready, compare, reduceMotion]);

  // ───────── origin / destination pins ─────────
  useEffect(() => {
    const map = ready;
    odMarkers.current.forEach((m) => m.remove());
    odMarkers.current = [];
    if (!ready || !map) return;
    const add = (which: "origin" | "destination", p: { lat: number; lon: number } | null, color: string, letter: string) => {
      if (!p) return;
      const m = new maplibregl.Marker({ element: pinEl(color, letter), anchor: "bottom", draggable: true }).setLngLat([p.lon, p.lat]).addTo(map);
      m.on("dragend", () => {
        const ll = m.getLngLat();
        setEndpoint(which, { lat: ll.lat, lon: ll.lng, label: `Pinned · ${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)}` });
      });
      odMarkers.current.push(m);
    };
    add("origin", origin, "#d8c65a", "A");
    add("destination", destination, "#f472b6", "B");
  }, [ready, origin, destination]);

  // ───────── camera requests / cursor ─────────
  useEffect(() => {
    const map = ready;
    if (!ready || !map || !flyTo || useNav.getState().active) return;
    // Carry the tilt when the request also switches into the twin. Asking to see a
    // stop in 3D sets mode and flyTo in the same update, so this animation and the
    // mode change's easeTo start together and the later one wins -- which landed the
    // camera flat on a scene whose whole point is that it is not. Only applied when
    // the pitch is inconsistent with the mode, so a tilt the user chose is kept.
    const flat = map.getPitch() < 10;
    map.flyTo({
      center: [flyTo.lon, flyTo.lat],
      zoom: flyTo.zoom ?? 17.2,
      ...(mode === "twin" && flat ? { pitch: 62, bearing: -28 } : {}),
      duration: reduceMotion ? 0 : 1400,
      essential: true,
    });
  }, [ready, flyTo, reduceMotion, mode]);

  useEffect(() => {
    const map = ready;
    if (ready && map) map.getCanvas().style.cursor = pickMode ? "crosshair" : "";
  }, [ready, pickMode]);

  // ───────── click: select route / drop pin / probe the twin ─────────
  useEffect(() => {
    const map = ready;
    if (!ready || !map || !base) return;
    const onClick = async (ev: maplibregl.MapMouseEvent) => {
      // Markers live inside the canvas container, and MapLibre reads a map click
      // from the container, so a tap on a break pin arrives here as well and would
      // open the "what is it like here" popup on top of the pin's own sheet.
      // Stopping the DOM event at the marker does not help: the map's listener runs
      // first. Asking where the click came from does.
      const from = ev.originalEvent?.target as HTMLElement | null;
      if (from?.closest?.(".hm-break-pin")) return;
      const st = useMap.getState();
      if (st.pickMode === "origin" || st.pickMode === "destination") {
        setEndpoint(st.pickMode, { lat: ev.lngLat.lat, lon: ev.lngLat.lng, label: `Pinned · ${ev.lngLat.lat.toFixed(4)}, ${ev.lngLat.lng.toFixed(4)}` });
        return;
      }
      if (st.pickMode === "trees" || st.pickMode === "cool_pavement" || st.pickMode === "shade_structure") {
        const kind = st.pickMode;
        const popup = new maplibregl.Popup({ maxWidth: "280px", offset: 12 })
          .setLngLat(ev.lngLat)
          .setHTML('<div class="skeleton" style="width:220px;height:78px;border-radius:12px"></div>')
          .addTo(map);
        const r = await runIntervention(ev.lngLat.lat, ev.lngLat.lng, kind as InterventionKind);
        if (r) popup.setHTML(interventionPopupHtml(r, usePrefs.getState().units));
        else popup.setHTML('<div style="font-size:12px">Could not simulate that here — try a spot on open ground or a street.</div>');
        return;
      }
      const water = map.queryRenderedFeatures(ev.point, { layers: WATER_LAYERS })[0];
      if (water?.geometry.type === "Point") {
        const [lon, lat] = water.geometry.coordinates;
        showFacilityPopup(map, { ...water.properties, lat, lon } as Poi);
        return;
      }
      const hit = map.queryRenderedFeatures(ev.point, { layers: ["route-halo"] })[0];
      if (hit) {
        st.set({ selectedRouteId: hit.properties.id as string });
        return;
      }
      const p = usePrefs.getState();
      const popup = new maplibregl.Popup({ maxWidth: "280px", offset: 12 })
        .setLngLat(ev.lngLat)
        .setHTML('<div class="skeleton" style="width:220px;height:92px;border-radius:12px"></div>')
        .addTo(map);
      try {
        const off = st.simOffsetMin + TIMELINE[Math.round(st.timeMin / 15)];
        const s = await api.point({ lat: ev.lngLat.lat, lon: ev.lngLat.lng, scenario: SCENARIO, time: base, offset_min: off, temp_delta: st.tempDelta });
        const u = p.units;
        const sun = s.sun_exposure < 0.35 ? "In shade" : s.sun_exposure < 0.7 ? "Partial shade" : "Full sun";
        const row = (k: string, v: string) => `<div><div style="color:#858179;font-size:10px;letter-spacing:.06em;text-transform:uppercase">${k}</div><div style="font-weight:600">${v}</div></div>`;
        popup.setHTML(`
          <div style="min-width:230px">
            <div style="font-size:11px;color:#adaaa5;margin-bottom:4px">${esc(s.near)}</div>
            <div style="display:flex;align-items:baseline;gap:8px">
              <span style="font-size:34px;font-weight:700;letter-spacing:-.03em;color:${heatColor(s.feels_c)};font-variant-numeric:tabular-nums">${fmtTemp(s.feels_c, u)}</span>
              <span style="font-size:12px;color:#d4d2cf">${heatLabel(s.feels_c)}</span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;margin-top:10px;font-size:12.5px;color:#f3f3f2">
              ${row("Air", fmtTemp(s.air_c, u))}${row("Ground", fmtTemp(s.surface_c, u))}
              ${row("Sun", sun)}${row("Surface", esc(s.surface))}
              ${row("Traffic heat · estimate", `+${s.traffic_heat_c.toFixed(2)}°C`)}${row("Industry · estimate", `+${(s.industrial_heat_c ?? 0).toFixed(2)}°C`)}
            </div>
            <p style="font-size:10px;color:#858179;margin-top:8px">Estimated waste heat · no live radiation or pollution measurements</p>
          </div>`);
      } catch {
        popup.setHTML('<div style="font-size:12px">Could not sample the twin here.</div>');
      }
    };
    const enter = () => (map.getCanvas().style.cursor = "pointer");
    const leave = () => (map.getCanvas().style.cursor = useMap.getState().pickMode ? "crosshair" : "");
    map.on("click", onClick);
    map.on("mouseenter", "route-halo", enter);
    map.on("mouseleave", "route-halo", leave);
    WATER_LAYERS.forEach((id) => { map.on("mouseenter", id, enter); map.on("mouseleave", id, leave); });
    return () => {
      map.off("click", onClick);
      map.off("mouseenter", "route-halo", enter);
      map.off("mouseleave", "route-halo", leave);
      WATER_LAYERS.forEach((id) => { map.off("mouseenter", id, enter); map.off("mouseleave", id, leave); });
    };
  }, [ready, base]);

  // keep simulated conditions reflected (sim offset / delta) — frames reload via useFrameLoader
  void simOffset;

  return (
    <div className="absolute inset-0 bg-ink-950">
      <div ref={el} className="absolute inset-0" role="application" aria-label="Heat digital twin map" />
      {ready && <div className="pointer-events-none absolute right-4 bottom-[145px] md:bottom-[130px] rounded-xl bg-ink-950/85 border border-white/10 px-3 py-2 text-[10px] text-ink-200 max-w-[190px]">
        <div className="font-semibold">Tap a place pin for photos & details</div>
        <div className="mt-1"><span className="text-[#77d9f5]">● Water</span> · <span className="text-[#ffd08a]">● Rest</span> · <span className="text-[#c4b5fd]">WC</span></div>
        <div className="mt-1 text-ink-400">Faded pins are estimates · verify access</div>
      </div>}
      {!ready && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-3 text-ink-400 text-sm fade-in">
            <div className="w-10 h-10 rounded-full border-2 border-white/10 border-t-cool-400" style={{ animation: "spin-slow 0.9s linear infinite" }} />
            {meta.error ? "Waiting for the HeatMind engine on :8000…" : "Booting the digital twin…"}
          </div>
        </div>
      )}
      {/* soft vignette so floating glass reads over the map */}
      <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(120% 90% at 50% 40%, transparent 55%, rgba(6,6,6,.55) 100%)" }} />
    </div>
  );
}
