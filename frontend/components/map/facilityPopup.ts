import * as maplibregl from "maplibre-gl";
import { api, type BreakStop, type Poi } from "@/lib/api";

export function facilityLabel(p: Pick<Poi, "type" | "detail" | "source">) {
  if (p.source === "seeded") return p.type === "water" ? "Estimated water point" : "Estimated rest / shade point";
  if (p.detail === "toilets") return "Toilet / restroom";
  if (p.detail === "bench") return "Bench / rest point";
  if (p.detail === "water_dispenser") return "Water dispenser / cooler";
  if (p.type === "water") return ["drinking_water", "water_point"].includes(p.detail || "") ? "Drinking water" : "Shop / refreshment stop";
  if (p.type === "cooling_center") return "Indoor facility · cooling unverified";
  return p.type === "shade" ? "Shade / shelter" : "Rest point";
}

/** Native popup anchored to the tapped place; text nodes escape OSM / AI content. */
export function showFacilityPopup(map: maplibregl.Map, p: Poi, stop?: BreakStop) {
  const root = document.createElement("div");
  root.style.cssText = "width:240px;max-width:calc(100vw - 65px);max-height:min(310px,32dvh);overflow-y:auto;font-size:12px;line-height:1.45;color:#d7e0e6";
  root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "Facility details");
  const text = (tag: string, value: string, style = "") => {
    const el = document.createElement(tag); el.textContent = value; el.style.cssText = style; return el;
  };
  root.append(text("div", facilityLabel(p), "color:#77d9f5;font-size:10px;text-transform:uppercase;letter-spacing:.05em"));
  root.append(text("strong", p.name, "display:block;font-size:15px;margin:5px 0 8px"));
  const photo = text("div", "Looking for a place photo…", "background:#17232b;min-height:85px;border-radius:10px;display:grid;place-items:center;padding:12px;color:#90a4af;text-align:center");
  photo.setAttribute("aria-live", "polite"); root.append(photo);
  const dl = document.createElement("dl"); dl.style.cssText = "margin:10px 0;display:grid;grid-template-columns:75px 1fr;gap:5px;font-size:11px";
  for (const [label, value] of [
    ["Source", p.source === "osm" ? "Mapped in OpenStreetMap" : "Estimated point · unverified"],
    ["Access", p.access || "Not recorded · confirm locally"], ["Hours", p.opening_hours || "Not recorded"],
    ["Cost", p.fee === "no" ? "No fee recorded" : p.fee === "yes" ? "Fee applies" : p.fee || "Not recorded"],
    ["Accessible", p.wheelchair || "Not recorded"], ["Operator", p.operator || "Not recorded"],
  ]) { dl.append(text("dt", label, "color:#81939e"), text("dd", value, "margin:0;overflow-wrap:anywhere")); }
  root.append(dl);
  if (p.type === "water") root.append(text("p", p.drinking_water === "no" ? "Not drinking water — do not rely on this as a refill stop." : p.source === "seeded" ? "Water availability is unverified. Carry your own water." : ["drinking_water", "water_point", "water_dispenser"].includes(p.detail || "") ? "Mapped water point. Check that it is working and suitable for drinking." : "Water availability is unverified; a purchase may be needed.", "font-size:11px;color:#ffd08a;margin:8px 0"));
  if (stop) root.append(text("p", `${stop.type === "rest" ? "Suggested rest break" : "Suggested drink break"} · ${(stop.at_m / 1000).toFixed(1)} km into your route.`, "color:#8ad8b0;font-size:11px"));
  if (p.osm_ref && /^(node|way|relation)\/\d+$/.test(p.osm_ref)) {
    const link = text("a", "View mapped place ↗", "color:#77d9f5;font-size:10px") as HTMLAnchorElement;
    link.href = `https://www.openstreetmap.org/${p.osm_ref}`; link.target = "_blank"; link.rel = "noopener noreferrer"; root.append(link);
  }
  const popup = new maplibregl.Popup({ maxWidth: "280px", offset: 18, closeOnClick: true, focusAfterOpen: false }).setLngLat([p.lon, p.lat]).setDOMContent(root).addTo(map);
  popup.getElement().style.zIndex = "10";
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); if (popup.isOpen()) photo.textContent = "Photo unavailable for this spot."; }, 9000);
  let closed = false;
  popup.on("close", () => { closed = true; clearTimeout(timer); controller.abort(); });
  api.photosNearby({ lat: p.lat, lon: p.lon, poi_id: p.id || undefined }, controller.signal).then((result) => {
    if (closed) return;
    clearTimeout(timer);
    const image = result.photos[0];
    if (!image) { photo.textContent = "No place photo available yet. Confirm this facility on arrival."; return; }
    const img = document.createElement("img"); img.src = image.url; img.alt = image.kind === "place" ? `Photo linked to ${p.name}` : "Nearby street imagery; may not show the exact facility";
    img.style.cssText = "width:100%;height:130px;object-fit:cover;border-radius:8px"; img.referrerPolicy = "no-referrer";
    img.onerror = () => { if (!closed) photo.textContent = "Photo could not load for this spot."; };
    photo.replaceChildren(img); photo.style.cssText = "margin:0";
    const date = image.captured_at ? ` · ${new Date(image.captured_at).toLocaleDateString()}` : "";
    photo.append(text("div", image.kind === "place" ? "Photo linked to this place" : `Nearby street photo · ${image.distance_m ?? "?"} m away${date}`, "font-size:10px;color:#a5b7c2;margin-top:4px"));
    const credit = text("a", image.attribution || result.attribution || "Photo source", "display:block;color:#77d9f5;font-size:9px;margin-top:3px") as HTMLAnchorElement;
    if (image.source_url?.startsWith("https://")) { credit.href = image.source_url; credit.target = "_blank"; credit.rel = "noopener noreferrer"; }
    photo.append(credit);
  }).catch(() => { clearTimeout(timer); if (!closed) photo.textContent = "Photo temporarily unavailable for this spot."; });
  return popup;
}

export function showBreakPopup(map: maplibregl.Map, stop: BreakStop) {
  if (stop.lat === null || stop.lon === null) return;
  if (stop.poi) return showFacilityPopup(map, { ...stop.poi, source: stop.poi.source === "osm" ? "osm" : "seeded", lat: stop.lat, lon: stop.lon }, stop);
  const root = document.createElement("div");
  root.style.cssText = "width:230px;font-size:12px;color:#d7e0e6";
  const title = document.createElement("strong"); title.textContent = stop.type === "rest" ? "Suggested rest break" : "Suggested water break";
  const info = document.createElement("p"); info.textContent = `At ${(stop.at_m / 1000).toFixed(1)} km. No mapped facility or photo at this spot. Carry water and find somewhere suitable to stop.`;
  const advice = document.createElement("p"); advice.textContent = stop.advice;
  root.append(title, info, advice);
  const popup = new maplibregl.Popup({ maxWidth: "270px", offset: 18 }).setLngLat([stop.lon, stop.lat]).setDOMContent(root).addTo(map);
  popup.getElement().style.zIndex = "10";
  return popup;
}
