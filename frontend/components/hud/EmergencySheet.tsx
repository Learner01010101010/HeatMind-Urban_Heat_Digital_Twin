"use client";

import { Droplets, LifeBuoy, Phone, TreePine, TriangleAlert, Umbrella, X } from "lucide-react";
import { useMemo } from "react";
import type { Poi } from "@/lib/api";
import { useNearestFrame, usePois } from "@/lib/hooks";
import { useGeo } from "@/lib/geolocation";
import { fmtTemp, heatColor } from "@/lib/heatColorScale";
import { useMap, usePrefs } from "@/lib/store";

/**
 * The one screen for someone who is in trouble right now.
 *
 * Everything else in this app is planning: where to go later, which route is cooler,
 * what the next three hours look like. This is the opposite — the user is already
 * overheating and the only question is where the nearest cold water and shade are.
 * So it answers that first, in the first line, with a distance and a walking time,
 * and everything else on the panel is below the fold.
 *
 * Two decisions worth stating plainly:
 *
 * **Only mapped sources.** The POI set mixes real OpenStreetMap records with seeded
 * points, and for water the seeded share is the majority. Planning around a seeded
 * point is a small inaccuracy; sending a dehydrated person to a kiosk that does not
 * exist is not. This panel shows `source === "osm"` only, and says so when that
 * leaves it with nothing rather than quietly padding the list.
 *
 * **It does not diagnose.** Heat stroke is a medical emergency and the panel says
 * to call 108 rather than offering a checklist that invites someone to decide they
 * are probably fine. The first-aid lines below are the standard cool-and-hydrate
 * measures, not a triage tool.
 */

const KIND: Record<string, { icon: React.ElementType; label: string; color: string }> = {
  water: { icon: Droplets, label: "Water", color: "#6fd0ff" },
  shade: { icon: Umbrella, label: "Shade", color: "#9ee7a8" },
  rest: { icon: TreePine, label: "Rest", color: "#ffd08a" },
  cooling_center: { icon: Umbrella, label: "Cooling centre", color: "#c4b5fd" },
};

/**
 * What a "water" POI actually is.
 *
 * The zone's water layer is generous by design — anywhere you might get a drink,
 * which for planning purposes is reasonable, since the corridor has three mapped
 * public taps and the honest answer is usually "a shop will sell you a bottle".
 * Unfiltered it also contains opticians, tailors, jewellers and, three entries
 * down the nearest list, a liquor shop. On a planning panel that is noise. On this
 * panel it is worse than noise: someone in trouble does not need to be sent 604 m
 * to a shop that sells spectacles.
 *
 * So this is an allowlist, not a blacklist. Somewhere unrecognised is left out
 * rather than guessed at, and the ordering below puts a real tap above a hospital
 * above a shop.
 */
const TAP = new Set(["drinking_water", "water_point", "fountain"]);
const INDOOR = new Set([
  "hospital", "clinic", "doctors", "pharmacy", "chemist", "library",
  "community_centre", "townhall", "place_of_worship",
]);
const SELLS_DRINKS = new Set([
  "convenience", "supermarket", "cafe", "restaurant", "fast_food", "bakery",
  "confectionery", "ice_cream", "dairy", "kiosk", "greengrocer", "beverages", "water",
]);

type WaterKind = "tap" | "indoor" | "buy" | "none";

function waterKind(detail?: string): WaterKind {
  const d = (detail ?? "").toLowerCase();
  if (TAP.has(d)) return "tap";
  if (INDOOR.has(d)) return "indoor";
  if (SELLS_DRINKS.has(d)) return "buy";
  return "none";
}

const WATER_LABEL: Record<Exclude<WaterKind, "none">, string> = {
  tap: "Public tap — free water",
  indoor: "Indoors, and someone to ask",
  buy: "Shop — you will need to buy a bottle",
};

/** Metres between two lat/lon points (equirectangular — exact enough under 10 km). */
function metresBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = (((bLon - aLon) * Math.PI) / 180) * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon) * R;
}

export default function EmergencySheet() {
  const open = useMap((s) => s.emergencyOpen);
  const set = useMap((s) => s.set);
  const units = usePrefs((s) => s.units);
  const geo = useGeo();
  const pois = usePois();
  const frame = useNearestFrame();

  // Where to measure from: the live fix if there is one, otherwise the trip's start
  // point, otherwise nothing — in which case the panel says so instead of measuring
  // distances from a default that is not where the user is standing.
  const startAt = useMap((s) => s.startAt);
  const from = useMemo(
    () =>
      geo.lat !== null && geo.lon !== null
        ? { lat: geo.lat, lon: geo.lon, label: "your location" }
        : startAt
          ? { lat: startAt.lat, lon: startAt.lon, label: startAt.label }
          : null,
    [geo.lat, geo.lon, startAt],
  );

  const nearest = useMemo(() => {
    const feats = pois.data?.features ?? [];
    if (!from) return [] as (Poi & { distM: number })[];
    const all = feats
      .map((f): Poi & { distM: number } => {
        const p = f.properties as Omit<Poi, "lat" | "lon">;
        const [lon, lat] = f.geometry.coordinates;
        return { ...p, lat, lon, distM: metresBetween(from.lat, from.lon, lat, lon) };
      })
      // Mapped records only — see the note at the top of this file.
      .filter((p) => p.source === "osm")
      // ...and, for water, only somewhere a drink actually comes from.
      .filter((p) => p.type !== "water" || waterKind(p.detail) !== "none")
      .sort((a, b) => {
        // A free tap beats a hospital beats a shop, but only within reach: an extra
        // 400 m to save buying a bottle is not a trade worth making in this state,
        // so the preference only reorders things within the same 250 m band.
        const band = (m: number) => Math.floor(m / 250);
        if (band(a.distM) !== band(b.distM)) return a.distM - b.distM;
        const rank = (p: Poi) => (p.type !== "water" ? 1 : { tap: 0, indoor: 1, buy: 2, none: 3 }[waterKind(p.detail)]);
        return rank(a) - rank(b) || a.distM - b.distM;
      });

    // One of each kind first, so a panel opened in a hurry always shows water AND
    // shade rather than the five nearest taps and no shelter.
    const picked: (Poi & { distM: number })[] = [];
    for (const k of ["water", "shade", "rest", "cooling_center"]) {
      const hit = all.find((p) => p.type === k);
      if (hit) picked.push(hit);
    }
    for (const p of all) {
      if (picked.length >= 6) break;
      if (!picked.includes(p)) picked.push(p);
    }
    return picked;
  }, [pois.data, from]);

  if (!open) return null;

  const close = () => set({ emergencyOpen: false });

  const feels = frame?.stats.street_mean_c ?? null;
  // Walking pace here is deliberately slow: someone who has opened this panel is not
  // walking at 1.35 m/s.
  const minutesFor = (m: number) => Math.max(1, Math.round(m / 60));

  return (
    <div className="fixed inset-0 z-[80] grid place-items-end sm:place-items-center p-3 pointer-events-none">
      <div className="fixed inset-0 bg-black/55" onClick={close} aria-hidden />
      <div
        className="glass-strong pointer-events-auto relative w-full sm:w-[400px] max-h-[88dvh] overflow-y-auto rounded-[26px] p-4 pop-in"
        role="dialog"
        aria-label="Emergency — nearest water, shade and rest"
        style={{ borderColor: "rgba(224,59,47,.45)" }}
      >
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <span className="hm-sos grid place-items-center w-9 h-9 rounded-full">
              <LifeBuoy size={18} />
            </span>
            <div>
              <div className="text-[17px] font-semibold text-ink-100 leading-tight">Get out of the heat</div>
              <div className="text-[11.5px] text-ink-400">
                {from ? `Nearest mapped help from ${from.label}` : "Set a start point to measure from"}
              </div>
            </div>
          </div>
          <button onClick={close} className="press grid place-items-center w-7 h-7 rounded-full hover:bg-white/10 text-ink-300 shrink-0" aria-label="Close">
            <X size={14} />
          </button>
        </div>

        {/* Call first. A panel that buries this under a list of taps has its priorities
            wrong: confusion, collapse or hot dry skin is an ambulance, not a walk. */}
        <a
          href="tel:108"
          className="press hm-sos flex items-center justify-center gap-2 w-full h-12 rounded-full font-semibold text-[15px] mb-3"
        >
          <Phone size={17} />
          Call 108 — medical emergency
        </a>
        <p className="text-[11.5px] text-ink-400 leading-snug mb-3 -mt-1">
          Call if someone is confused, has stopped sweating, is vomiting or will not wake
          properly. Heat stroke is not something to walk off.
        </p>

        {feels !== null && (
          <div className="flex items-center gap-2 rounded-2xl px-3 py-2 mb-3 bg-white/[0.04]">
            <TriangleAlert size={14} style={{ color: heatColor(feels) }} />
            <span className="text-[12px] text-ink-200">
              Streets nearby are averaging{" "}
              <strong style={{ color: heatColor(feels) }}>{fmtTemp(feels, units)}</strong> right now.
            </span>
          </div>
        )}

        <div className="text-[10.5px] font-bold uppercase tracking-wider text-ink-400 mb-2">Nearest mapped help</div>

        {!from ? (
          <p className="text-[12.5px] text-ink-300 leading-snug">
            The app does not know where you are, so it cannot rank anything by distance.
            Allow location, or set a start point on the map, and this list fills in.
          </p>
        ) : nearest.length === 0 ? (
          <p className="text-[12.5px] leading-snug" style={{ color: "#ffc48a" }}>
            Nothing is mapped near you in OpenStreetMap. That is a gap in the street data,
            not a sign there is nothing there — head for a shop, a petrol pump or any
            building with air conditioning.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {nearest.map((p) => {
              const k = KIND[p.type] ?? KIND.rest;
              return (
                <li key={p.id}>
                  <button
                    onClick={() =>
                      set({ flyTo: { lat: p.lat, lon: p.lon, zoom: 18, nonce: Date.now() }, emergencyOpen: false })
                    }
                    className="press w-full flex items-center gap-3 text-left rounded-2xl px-2.5 py-2.5 bg-white/[0.04] hover:bg-white/[0.08]"
                  >
                    <span
                      className="grid place-items-center w-9 h-9 rounded-full shrink-0"
                      style={{ background: `${k.color}22`, color: k.color }}
                    >
                      <k.icon size={16} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13.5px] font-semibold text-ink-100 truncate">{p.name}</span>
                      <span className="block text-[11px] text-ink-400 truncate">
                        {p.type === "water"
                          ? WATER_LABEL[waterKind(p.detail) as Exclude<WaterKind, "none">]
                          : `${k.label}${p.detail ? ` · ${p.detail.replace(/_/g, " ")}` : ""}`}
                      </span>
                    </span>
                    <span className="text-right shrink-0">
                      <span className="block text-[14px] font-semibold text-ink-100 tabular">
                        {p.distM < 950 ? `${Math.round(p.distM)} m` : `${(p.distM / 1000).toFixed(1)} km`}
                      </span>
                      <span className="block text-[10.5px] text-ink-400 tabular">~{minutesFor(p.distM)} min</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-4 pt-3 border-t border-white/10">
          <div className="text-[10.5px] font-bold uppercase tracking-wider text-ink-400 mb-1.5">While you get there</div>
          <ul className="text-[12px] text-ink-300 leading-relaxed list-disc pl-4 space-y-0.5">
            <li>Get into shade or indoors before anything else.</li>
            <li>Sip water steadily — small amounts often, not one large drink.</li>
            <li>Loosen clothing; wet the skin and keep air moving over it.</li>
            <li>Sit or lie down with the legs raised if light-headed.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
