"use client";

import * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { api, type TwinLayers } from "@/lib/api";
import { setEndpoint } from "@/lib/actions";
import { useBaseTime, useFrames, useMeta, useNearestFrame, usePois, useZone } from "@/lib/hooks";
import { fmtTemp, heatColor, heatLabel, riskColor } from "@/lib/heatColorScale";
import { POI_STYLE } from "@/lib/poiStyle";
import { atTime, keyframes, SCENARIO, TIMELINE, useMap, usePrefs } from "@/lib/store";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const HEAT_OPACITY = { map: 0.42, twin: 0.58 };
const TWIN_LAYERS = ["shadows", "corridor-glow", "corridor-core", "hot-streets", "hotspots"];
maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
const layerCache = new Map<string, Promise<TwinLayers>>();
const shadowCache = new Map<string, Promise<GeoJSON.FeatureCollection>>();

function pinEl(color: string, letter: string) {
  const d = document.createElement("div");
  d.className = "hm-pin";
  d.innerHTML = `<svg width="34" height="44" viewBox="0 0 34 44"><defs><linearGradient id="g${letter}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${color}" stop-opacity=".75"/></linearGradient></defs><path d="M17 43s14-14.6 14-26A14 14 0 0 0 3 17c0 11.4 14 26 14 26z" fill="url(#g${letter})" stroke="rgba(3,5,9,.9)" stroke-width="2"/><circle cx="17" cy="17" r="7.5" fill="#030509"/><text x="17" y="21" text-anchor="middle" font-size="10.5" font-weight="800" fill="${color}" font-family="system-ui">${letter}</text></svg>`;
  return d;
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export default function TwinMap() {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // readiness is tied to a specific map instance, so effects never touch a map that is still loading
  const [ready, setReady] = useState<maplibregl.Map | null>(null);
  const heatUrls = useRef<(string | null)[]>(TIMELINE.map(() => null));
  const odMarkers = useRef<maplibregl.Marker[]>([]);
  const chipMarkers = useRef<Map<string, maplibregl.Marker>>(new Map());
  const spotMarkers = useRef<maplibregl.Marker[]>([]);
  const fittedFor = useRef<string | null>(null);

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
  const origin = useMap((s) => s.origin);
  const destination = useMap((s) => s.destination);
  const pickMode = useMap((s) => s.pickMode);
  const flyTo = useMap((s) => s.flyTo);
  const simOffset = useMap((s) => s.simOffsetMin);
  const tempDelta = useMap((s) => s.tempDelta);
  const scenario = SCENARIO;
  const units = usePrefs((s) => s.units);
  const reduceMotion = usePrefs((s) => s.reduceMotion);

  // ───────── init ─────────
  useEffect(() => {
    if (!el.current || !meta.data) return;
    const [s, w, n, e] = meta.data.zone.bbox;
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;inset:0";
    el.current.appendChild(host);
    const map = new maplibregl.Map({
      container: host,
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
      center: [(w + e) / 2 - 0.0015, (s + n) / 2 + 0.0008],
      zoom: 15.4,
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
      map.addLayer({ id: "water", type: "fill", source: "water", paint: { "fill-color": "#0b3350", "fill-opacity": 0.75, "fill-outline-color": "#2b7fb0" } });
      map.addSource("shadows", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "shadows", type: "fill", source: "shadows", layout: { visibility: "none" }, paint: { "fill-color": "#050a1c", "fill-opacity": 0.5, "fill-opacity-transition": { duration: 400 } } });
      map.addLayer({ id: "labels", type: "raster", source: "labels", paint: { "raster-opacity": 0.75 } });
      map.addSource("layers", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "corridor-glow", type: "line", source: "layers", filter: ["==", ["get", "cls"], "cool"], layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#34e2c6", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 6, 18, 22], "line-blur": 8, "line-opacity": 0.45 },
      });
      map.addLayer({
        id: "corridor-core", type: "line", source: "layers", filter: ["==", ["get", "cls"], "cool"], layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#b6fff1", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.2, 18, 3.5], "line-opacity": 0.9 },
      });
      map.addLayer({
        id: "hot-streets", type: "line", source: "layers", filter: ["==", ["get", "cls"], "hot"], layout: { visibility: "none", "line-cap": "round" },
        paint: { "line-color": "#ff5a36", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 2, 18, 8], "line-blur": 3, "line-opacity": 0.55 },
      });
      map.addSource("hotspots", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "hotspots", type: "heatmap", source: "hotspots", layout: { visibility: "none" },
        paint: {
          "heatmap-weight": ["get", "w"],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 14, 0.6, 18, 1.4],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 40],
          "heatmap-opacity": 0.55,
          "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", 0.3, "rgba(251,138,31,0.35)", 0.6, "rgba(239,68,68,0.65)", 1, "rgba(255,210,180,0.95)"],
        },
      });
      map.addSource("buildings", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "buildings-2d", type: "fill", source: "buildings", paint: { "fill-color": "#141a27", "fill-opacity": 0.92, "fill-outline-color": "#232c3e" } });
      map.addLayer({
        id: "buildings-3d", type: "fill-extrusion", source: "buildings", layout: { visibility: "none" },
        paint: {
          "fill-extrusion-color": ["interpolate", ["linear"], ["get", "height_m"], 3, "#1c2436", 12, "#243049", 30, "#33436a"],
          "fill-extrusion-height": 0,
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.93,
          "fill-extrusion-vertical-gradient": true,
        },
      });
      map.addSource("pois", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "pois", type: "circle", source: "pois", minzoom: 14.5,
        paint: {
          "circle-color": ["get", "color"],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, ["case", ["get", "on"], 4.5, 1.8], 18, ["case", ["get", "on"], 8, 4]],
          "circle-opacity": ["case", ["get", "on"], 1, 0.55],
          "circle-stroke-color": "#030509",
          "circle-stroke-width": ["case", ["get", "on"], 2, 0.5],
        },
      });
      map.addSource("routes", { type: "geojson", data: EMPTY });
      map.addSource("route-seg", { type: "geojson", data: EMPTY });
      map.addLayer({ id: "route-casing", type: "line", source: "routes", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#020306", "line-width": ["case", ["get", "sel"], 15, 9], "line-opacity": ["case", ["get", "sel"], 0.9, 0.55] } });
      map.addLayer({ id: "route-halo", type: "line", source: "routes", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": ["case", ["get", "sel"], 12, 6], "line-opacity": ["case", ["get", "sel"], 0.55, 0.28], "line-blur": ["case", ["get", "sel"], 2, 0] } });
      map.addLayer({ id: "route-heat", type: "line", source: "route-seg", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "c"], "line-width": ["case", ["get", "sel"], 6, 3], "line-opacity": ["case", ["get", "sel"], 1, 0.5] } });
      // static centre-line on the selected route (no motion — routes update in place)
      map.addLayer({ id: "route-core", type: "line", source: "routes", filter: ["get", "sel"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 1.5, "line-opacity": 0.85 } });
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
    (map.getSource("buildings") as maplibregl.GeoJSONSource).setData(zone.data.buildings);
    (map.getSource("water") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: zone.data.surfaces.features.filter((f) => f.properties?.kind === "water"),
    });
  }, [ready, zone.data]);

  // ───────── heat keyframe rasters (one image source per keyframe) ─────────
  useEffect(() => {
    const map = ready;
    if (!ready || !map) return;
    frames.forEach((f, i) => {
      if (!f || heatUrls.current[i] === f.heatUrl) return;
      const [s, w, n, e] = f.grid.bbox;
      const id = `heat-${i}`;
      const src = map.getSource(id) as maplibregl.ImageSource | undefined;
      if (src) src.updateImage({ url: f.heatUrl });
      else {
        map.addSource(id, { type: "image", url: f.heatUrl, coordinates: [[w, n], [e, n], [e, s], [w, s]] });
        // keyframes stack in time order so the later frame blends over the earlier one
        const before = TIMELINE.slice(i + 1).map((_, k) => `heat-${i + 1 + k}`).find((x) => map.getLayer(x)) ?? "water";
        map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0, "raster-fade-duration": 0, "raster-resampling": "linear" } }, before);
      }
      heatUrls.current[i] = f.heatUrl;
    });
  }, [ready, frames]);

  // blend the two keyframes around the timeline position
  useEffect(() => {
    const map = ready;
    if (!ready || !map) return;
    const { i0, i1, t } = keyframes(timeMin);
    const O = HEAT_OPACITY[mode];
    TIMELINE.forEach((_, i) => {
      const id = `heat-${i}`;
      if (!map.getLayer(id)) return;
      let o = 0;
      if (i === i0) o = O;
      if (i === i1 && i1 !== i0 && frames[i1]) o = O * t;
      if (i === i0 && !frames[i0]) o = 0;
      map.setPaintProperty(id, "raster-opacity", o);
    });
  }, [ready, timeMin, mode, frames]);

  // ───────── sun-driven lighting + twin overlays for the nearest keyframe ─────────
  useEffect(() => {
    const map = ready;
    if (!ready || !map || !nearest) return;
    const elev = nearest.sun.elevation_deg;
    map.setLight({
      anchor: "map",
      position: [1.4, nearest.sun.azimuth_deg, Math.min(88, Math.max(8, 90 - elev))],
      color: elev > 0 ? "#fff1dc" : "#8aa4ff",
      intensity: elev > 0 ? 0.5 : 0.18,
    });
    if (mode !== "twin" || !base) return;
    const key = `${scenario}|${nearest.time}|${tempDelta}`;
    const ctrl = { dead: false };
    const t = setTimeout(() => {
      if (!layerCache.has(key)) {
        const p = api.layers({ scenario, time: nearest.time, temp_delta: tempDelta });
        p.catch(() => layerCache.delete(key));
        layerCache.set(key, p);
      }
      const sk = `${scenario}|${nearest.time}`;
      if (!shadowCache.has(sk)) {
        const p = api.shadow({ scenario, time: nearest.time }).then((r) => r.shadows);
        p.catch(() => shadowCache.delete(sk));
        shadowCache.set(sk, p);
      }
      layerCache.get(key)!.then((d) => {
        if (ctrl.dead || !mapRef.current) return;
        (map.getSource("layers") as maplibregl.GeoJSONSource).setData(d.corridors);
        (map.getSource("hotspots") as maplibregl.GeoJSONSource).setData(d.hotspots);
      });
      shadowCache.get(sk)!.then((d) => {
        if (ctrl.dead || !mapRef.current) return;
        (map.getSource("shadows") as maplibregl.GeoJSONSource).setData(d);
      });
    }, 90);
    return () => {
      ctrl.dead = true;
      clearTimeout(t);
    };
  }, [ready, nearest, mode, scenario, tempDelta, base]);

  // ───────── mode: Map ↔ Heat Twin ─────────
  useEffect(() => {
    const map = ready;
    if (!ready || !map) return;
    const twin = mode === "twin";
    TWIN_LAYERS.forEach((id) => map.setLayoutProperty(id, "visibility", twin ? "visible" : "none"));
    map.setLayoutProperty("buildings-2d", "visibility", twin ? "none" : "visible");
    map.setLayoutProperty("buildings-3d", "visibility", twin ? "visible" : "none");
    map.setPaintProperty("labels", "raster-opacity", twin ? 0.35 : 0.75);
    map.easeTo({ pitch: twin ? 62 : 0, bearing: twin ? -28 : 0, zoom: twin ? Math.max(map.getZoom(), 16) : map.getZoom(), duration: reduceMotion ? 0 : 1400, easing: (x) => 1 - Math.pow(1 - x, 4) });
    // grow the extrusions out of the ground
    let raf = 0;
    const start = performance.now();
    const dur = reduceMotion ? 1 : 1100;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      const h = twin ? e : 1 - e;
      map.setPaintProperty("buildings-3d", "fill-extrusion-height", ["*", ["get", "height_m"], h]);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    if (twin) raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [ready, mode, reduceMotion]);

  // hottest / coolest beacons in twin mode
  useEffect(() => {
    const map = ready;
    spotMarkers.current.forEach((m) => m.remove());
    spotMarkers.current = [];
    if (!ready || !map || mode !== "twin" || !nearest) return;
    const mk = (spot: typeof nearest.stats.hottest, color: string, title: string) => {
      const d = document.createElement("div");
      d.className = "hm-hotspot";
      d.style.setProperty("--c", color);
      d.title = `${title}: ${fmtTemp(spot.feels_c, units)} · ${spot.label}`;
      spotMarkers.current.push(new maplibregl.Marker({ element: d }).setLngLat([spot.lon, spot.lat]).addTo(map));
    };
    mk(nearest.stats.hottest, "#ef4444", "Hottest street");
    mk(nearest.stats.coolest, "#34e2c6", "Coolest street");
  }, [ready, mode, nearest, units]);

  // ───────── POIs ─────────
  useEffect(() => {
    const map = ready;
    if (!ready || !map || !pois.data) return;
    const route = compare?.routes.find((r) => r.id === selected);
    const along = new Set(route?.pois_along_route.map((p) => p.id) ?? []);
    (map.getSource("pois") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: pois.data.features
        .filter((f) => !route || along.has(f.properties.id))
        .map((f) => ({ ...f, properties: { ...f.properties, color: POI_STYLE[f.properties.type].color, on: along.has(f.properties.id) } })),
    });
  }, [ready, pois.data, compare, selected]);

  // ───────── routes (recoloured continuously with the timeline) ─────────
  useEffect(() => {
    const map = ready;
    if (!ready || !map) return;
    const routes = compare?.routes ?? [];
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
        r.segments.map((s) => ({
          type: "Feature" as const,
          properties: { c: heatColor(atTime(s.feels, timeMin)), sel: r.id === selected },
          geometry: { type: "LineString" as const, coordinates: s.coords.map(([la, lo]) => [lo, la]) },
        })),
      ),
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
      d.style.background = sel ? r.color : "rgba(8,11,18,.82)";
      d.style.color = sel ? "#030509" : r.color;
      d.style.border = `1px solid ${r.color}${sel ? "" : "80"}`;
      d.style.zIndex = sel ? "5" : "1";
      d.innerHTML = `${r.label.replace("Route ", "")} <span style="opacity:.55;margin:0 2px">·</span> <span style="color:${sel ? "#030509" : riskColor(score)}">${Math.round(score)}</span>`;
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
    add("origin", origin, "#34e2c6", "A");
    add("destination", destination, "#f472b6", "B");
  }, [ready, origin, destination]);

  // ───────── camera requests / cursor ─────────
  useEffect(() => {
    const map = ready;
    if (ready && map && flyTo) map.flyTo({ center: [flyTo.lon, flyTo.lat], zoom: flyTo.zoom ?? 17.2, duration: reduceMotion ? 0 : 1400, essential: true });
  }, [ready, flyTo, reduceMotion]);

  useEffect(() => {
    const map = ready;
    if (ready && map) map.getCanvas().style.cursor = pickMode ? "crosshair" : "";
  }, [ready, pickMode]);

  // ───────── click: select route / drop pin / probe the twin ─────────
  useEffect(() => {
    const map = ready;
    if (!ready || !map || !base) return;
    const onClick = async (ev: maplibregl.MapMouseEvent) => {
      const st = useMap.getState();
      if (st.pickMode) {
        setEndpoint(st.pickMode, { lat: ev.lngLat.lat, lon: ev.lngLat.lng, label: `Pinned · ${ev.lngLat.lat.toFixed(4)}, ${ev.lngLat.lng.toFixed(4)}` });
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
        const row = (k: string, v: string) => `<div><div style="color:#6e7a90;font-size:10px;letter-spacing:.06em;text-transform:uppercase">${k}</div><div style="font-weight:600">${v}</div></div>`;
        popup.setHTML(`
          <div style="min-width:230px">
            <div style="font-size:11px;color:#9aa5b8;margin-bottom:4px">${esc(s.near)}</div>
            <div style="display:flex;align-items:baseline;gap:8px">
              <span style="font-size:34px;font-weight:700;letter-spacing:-.03em;color:${heatColor(s.feels_c)};font-variant-numeric:tabular-nums">${fmtTemp(s.feels_c, u)}</span>
              <span style="font-size:12px;color:#c7cfdc">${heatLabel(s.feels_c)}</span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;margin-top:10px;font-size:12.5px;color:#eef2f7">
              ${row("Air", fmtTemp(s.air_c, u))}${row("Ground", fmtTemp(s.surface_c, u))}
              ${row("Sun", sun)}${row("Surface", esc(s.surface))}
            </div>
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
    return () => {
      map.off("click", onClick);
      map.off("mouseenter", "route-halo", enter);
      map.off("mouseleave", "route-halo", leave);
    };
  }, [ready, base]);

  // keep simulated conditions reflected (sim offset / delta) — frames reload via useFrameLoader
  void simOffset;

  return (
    <div className="absolute inset-0 bg-ink-950">
      <div ref={el} className="absolute inset-0" role="application" aria-label="Heat digital twin map" />
      {!ready && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-3 text-ink-400 text-sm fade-in">
            <div className="w-10 h-10 rounded-full border-2 border-white/10 border-t-cool-400" style={{ animation: "spin-slow 0.9s linear infinite" }} />
            {meta.error ? "Waiting for the HeatMind engine on :8000…" : "Booting the digital twin…"}
          </div>
        </div>
      )}
      {/* soft vignette so floating glass reads over the map */}
      <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(120% 90% at 50% 40%, transparent 55%, rgba(3,5,9,.55) 100%)" }} />
    </div>
  );
}
