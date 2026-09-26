import type { Map, ExpressionSpecification, GeoJSONSource } from "maplibre-gl";
import type { Poi, ZoneData } from "@/lib/api";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
export const WATER_LAYERS = ["water-stop-pins", "water-stop-dots"];
const FLAT_LAYERS = ["landcover-2d", "street-edge-2d", "street-fill-2d", "footpaths-2d", "street-names-2d", "place-names-2d", ...WATER_LAYERS];

/** Crisp vector detail from the very same mapped zone used by the twin. */
export function addFlatMapDetails(map: Map) {
  map.addSource("landcover-2d", { type: "geojson", data: EMPTY });
  map.addSource("streets-2d", { type: "geojson", data: EMPTY, tolerance: 0.15 });
  map.addSource("places-2d", { type: "geojson", data: EMPTY });
  map.addLayer({ id: "landcover-2d", type: "fill", source: "landcover-2d", paint: {
    "fill-color": ["match", ["get", "kind"], ["park", "woodland"], "#203e32", "campus", "#263b40", "parking", "#36312b", "ground", "#40392b", "#272a30"],
    "fill-opacity": 0.72, "fill-outline-color": "#465449",
  } }, "buildings-2d");
  const path: ExpressionSpecification = ["in", ["get", "highway"], ["literal", ["footway", "path", "steps", "pedestrian"]]];
  const roadWidth = (edge: number): ExpressionSpecification => ["interpolate", ["exponential", 2], ["zoom"], 14, ["+", ["*", ["get", "width_m"], 0.11], edge], 16, ["+", ["*", ["get", "width_m"], 0.44], edge], 18, ["+", ["*", ["get", "width_m"], 1.76], edge], 20, ["+", ["*", ["get", "width_m"], 7.04], edge]];
  const width = roadWidth(0);
  map.addLayer({ id: "street-edge-2d", type: "line", source: "streets-2d", filter: ["!", path], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#181e24", "line-width": roadWidth(1.6) } }, "pois");
  map.addLayer({ id: "street-fill-2d", type: "line", source: "streets-2d", filter: ["!", path], layout: { "line-cap": "round", "line-join": "round" }, paint: {
    "line-color": ["match", ["get", "highway"], ["motorway", "trunk", "primary"], "#877862", ["secondary", "tertiary"], "#68717c", "#4e5c68"],
    "line-width": width, "line-opacity": 0.95,
  } }, "pois");
  map.addLayer({ id: "footpaths-2d", type: "line", source: "streets-2d", minzoom: 16, filter: path, paint: { "line-color": "#bbba9b", "line-width": 1.4, "line-dasharray": [2, 2], "line-opacity": 0.75 } }, "pois");
  map.addLayer({ id: "street-names-2d", type: "symbol", source: "streets-2d", minzoom: 15.3, filter: ["!=", ["get", "name"], ""], layout: {
    "symbol-placement": "line", "symbol-spacing": 400, "text-field": ["get", "name"], "text-font": ["Arial"],
    "text-size": ["interpolate", ["linear"], ["zoom"], 15, 10, 18, 13], "text-max-angle": 35, "text-padding": 7,
  }, paint: { "text-color": "#e0e5eb", "text-halo-color": "#18222b", "text-halo-width": 1.7 } }, "pois");
  map.addLayer({ id: "place-names-2d", type: "symbol", source: "places-2d", minzoom: 16.5, layout: {
    "text-field": ["get", "name"], "text-font": ["Arial"], "text-size": 11, "text-max-width": 12, "text-padding": 12,
  }, paint: { "text-color": "#b5c9bd", "text-halo-color": "#15251f", "text-halo-width": 1.5 } }, "pois");
}

/** One GPU sprite, rather than hundreds of animated DOM markers. */
export function addWaterStopLayers(map: Map) {
  const canvas = document.createElement("canvas");
  canvas.width = 56; canvas.height = 72;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(2, 2);
  ctx.beginPath(); ctx.moveTo(14, 35); ctx.bezierCurveTo(11, 31, 2, 23, 2, 14);
  ctx.arc(14, 14, 12, Math.PI, 0); ctx.bezierCurveTo(26, 23, 17, 31, 14, 35);
  ctx.fillStyle = "#167ba4"; ctx.fill(); ctx.strokeStyle = "#daf4ff"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(14, 6); ctx.bezierCurveTo(13, 9, 9, 13, 9, 16);
  ctx.bezierCurveTo(9, 23, 19, 23, 19, 16); ctx.bezierCurveTo(19, 13, 15, 9, 14, 6);
  ctx.fillStyle = "#e7f9ff"; ctx.fill();
  map.addImage("water-drop-pin", ctx.getImageData(0, 0, 56, 72), { pixelRatio: 2 });
  map.addSource("water-stops", { type: "geojson", data: EMPTY });
  map.addLayer({ id: "water-stop-dots", type: "circle", source: "water-stops", minzoom: 13.5, maxzoom: 16, paint: {
    "circle-color": "#77d9f5", "circle-radius": ["case", ["get", "on"], 5, 3], "circle-stroke-color": "#0f3345", "circle-stroke-width": 1.5,
  } });
  map.addLayer({ id: "water-stop-pins", type: "symbol", source: "water-stops", minzoom: 16, layout: {
    "icon-image": "water-drop-pin", "icon-anchor": "bottom", "icon-size": ["case", ["get", "on"], 1.1, 0.8],
    "symbol-sort-key": ["case", ["get", "on"], 0, ["==", ["get", "source"], "osm"], 1, 2],
    "icon-padding": 7, "text-field": ["step", ["zoom"], ["case", ["any", ["get", "on"], ["==", ["get", "source"], "osm"]], ["get", "name"], ""], 17.3, ["get", "name"]],
    "text-font": ["Arial"], "text-size": 10, "text-anchor": "top", "text-offset": [0, 0.35], "text-max-width": 11, "text-optional": true,
  }, paint: { "icon-opacity": ["case", ["==", ["get", "source"], "osm"], 1, 0.7], "text-color": "#d6f3ff", "text-halo-color": "#092a39", "text-halo-width": 1.5 } });
}

export function setFlatZoneData(map: Map, zone: ZoneData) {
  (map.getSource("streets-2d") as GeoJSONSource).setData(zone.roads);
  (map.getSource("landcover-2d") as GeoJSONSource).setData({ type: "FeatureCollection", features: zone.surfaces.features.filter((f) => f.properties?.kind !== "water") });
  (map.getSource("places-2d") as GeoJSONSource).setData({ type: "FeatureCollection", features: zone.places.filter((p) => /college|school|hospital|park|garden|campus|university/i.test(`${p.kind} ${p.name}`)).map((p) => ({ type: "Feature", properties: { name: p.name }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })) });
}

export function setWaterStopData(map: Map, pois: GeoJSON.FeatureCollection<GeoJSON.Point, Poi>, along: Set<string>) {
  (map.getSource("water-stops") as GeoJSONSource).setData({ type: "FeatureCollection", features: pois.features.filter((f) => f.properties.type === "water").map((f) => ({ ...f, properties: { ...f.properties, on: along.has(f.properties.id) } })) });
}

export function setFlatDetailsVisible(map: Map, visible: boolean) {
  FLAT_LAYERS.forEach((id) => map.setLayoutProperty(id, "visibility", visible ? "visible" : "none"));
}

export function waterStopDescription(p: Pick<Poi, "source" | "detail">) {
  if (p.source === "seeded") return "Estimated water stop · availability unverified";
  if (["drinking_water", "water_point", "fountain"].includes(p.detail ?? "")) return "Mapped public water point";
  return "Shop / café water access · purchase may be needed";
}
