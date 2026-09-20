"""Turn a raw Overpass extract into the clean zone dataset used by every engine.

Real (from OpenStreetMap):   road network, building footprints, land use, water,
                             named places, amenities, mapped trees.
Estimated (disclosed in UI): building heights where OSM has no levels tag,
                             street/campus tree canopy, seeded water/rest/shade points.
"""
from __future__ import annotations

import json
import math
import random
from datetime import datetime
from typing import Any

from ..config import BBOX, CENTER, OSM_RAW, ZONE_CITY, ZONE_FILE, ZONE_NAME
from . import geo

WALK_HIGHWAYS = {
    "trunk": (18.0, "asphalt"),
    "trunk_link": (8.0, "asphalt"),
    "primary": (14.0, "asphalt"),
    "primary_link": (7.0, "asphalt"),
    "secondary": (12.0, "asphalt"),
    "tertiary": (9.0, "asphalt"),
    "tertiary_link": (6.0, "asphalt"),
    "unclassified": (6.0, "asphalt"),
    "residential": (6.0, "asphalt"),
    "living_street": (5.0, "concrete"),
    "service": (4.0, "concrete"),
    "pedestrian": (5.0, "paving_stones"),
    "footway": (2.5, "paving_stones"),
    "path": (2.0, "dirt"),
    "track": (3.0, "dirt"),
    "cycleway": (2.5, "asphalt"),
    "steps": (2.0, "concrete"),
}
SURFACE_NORMALISE = {
    "asphalt": "asphalt", "paved": "concrete", "concrete": "concrete", "concrete:plates": "concrete",
    "paving_stones": "paving", "sett": "paving", "compacted": "gravel", "gravel": "gravel",
    "fine_gravel": "gravel", "unpaved": "dirt", "dirt": "dirt", "ground": "dirt", "earth": "dirt",
    "grass": "grass", "sand": "dirt",
}


def _norm_surface(tag: str | None, default: str) -> str:
    return SURFACE_NORMALISE.get(tag or "", SURFACE_NORMALISE.get(default, default))


def _levels(tags: dict) -> float | None:
    for key in ("height",):
        if key in tags:
            try:
                return float(str(tags[key]).split()[0])
            except ValueError:
                pass
    if "building:levels" in tags:
        try:
            return float(str(tags["building:levels"]).split(";")[0]) * 3.2 + 1.0
        except ValueError:
            return None
    return None


def _estimate_height(kind: str, area: float, rng: random.Random) -> float:
    """Heuristic storeys from building type + footprint (Pune peri-urban typology)."""
    if kind in ("apartments", "residential"):
        floors = 7 if area > 500 else 4
    elif kind in ("college", "school", "university", "hospital", "commercial", "office"):
        floors = 4
    elif kind in ("temple", "shed", "garage", "roof", "hut", "kiosk"):
        floors = 1
    elif kind == "house":
        floors = 2
    else:  # building=yes
        floors = 4 if area > 700 else 3 if area > 250 else 2
    floors += rng.choice([-1, 0, 0, 1]) if floors > 2 else 0
    return round(max(floors, 1) * 3.2 + 1.0, 1)


def build_zone() -> dict[str, Any]:
    raw = json.loads(OSM_RAW.read_text(encoding="utf8"))
    els = raw["elements"]
    nodes = {e["id"]: (e["lat"], e["lon"]) for e in els if e["type"] == "node" and "lat" in e}
    rng = random.Random(42)

    roads: list[dict] = []
    buildings: list[dict] = []
    surfaces: list[dict] = []
    trees: list[dict] = []
    pois: list[dict] = []
    places: list[dict] = []
    seen_places: set[str] = set()

    def add_place(name: str, kind: str, lat: float, lon: float) -> None:
        key = name.strip().lower()
        if not name or key in seen_places or not geo.in_bbox(lat, lon):
            return
        seen_places.add(key)
        places.append({"id": f"pl{len(places)}", "name": name.strip(), "kind": kind, "lat": round(lat, 6), "lon": round(lon, 6)})

    pad = 0.0004
    for e in els:
        if e["type"] != "way":
            continue
        t = e.get("tags", {})
        coords = [(n, *nodes[n]) for n in e.get("nodes", []) if n in nodes]
        if len(coords) < 2:
            continue

        hw = t.get("highway")
        if hw in WALK_HIGHWAYS:
            if t.get("access") in ("no",) or t.get("foot") == "no":
                continue
            width, default_surface = WALK_HIGHWAYS[hw]
            # Clip to zone: split the way into runs of in-bbox nodes.
            runs, cur = [], []
            for c in coords:
                if geo.in_bbox(c[1], c[2], pad):
                    cur.append(c)
                else:
                    if len(cur) >= 2:
                        runs.append(cur)
                    cur = []
            if len(cur) >= 2:
                runs.append(cur)
            for run in runs:
                roads.append({
                    "id": f"r{len(roads)}",
                    "osm_id": e["id"],
                    "name": t.get("name") or t.get("ref") or "",
                    "highway": hw,
                    "surface": _norm_surface(t.get("surface"), default_surface),
                    "width_m": float(t.get("width", width)) if str(t.get("width", "")).replace(".", "", 1).isdigit() else width,
                    "walkable": True,
                    "bikeable": hw not in ("steps", "footway") or t.get("bicycle") in ("yes", "designated"),
                    "nodes": [[n, round(la, 7), round(lo, 7)] for n, la, lo in run],
                })
            continue

        closed = coords[0][0] == coords[-1][0] and len(coords) >= 4
        ring = [(la, lo) for _, la, lo in coords]
        if not closed:
            continue
        cla = sum(p[0] for p in ring) / len(ring)
        clo = sum(p[1] for p in ring) / len(ring)
        if not geo.in_bbox(cla, clo, pad):
            continue
        ring_xy = [geo.to_xy(*p) for p in ring]
        area = geo.ring_area_m2(ring_xy)

        if "building" in t:
            kind = t.get("building", "yes")
            h = _levels(t)
            src = "osm"
            if h is None:
                h = _estimate_height(kind, area, rng)
                src = "estimated"
            buildings.append({
                "id": f"b{len(buildings)}", "osm_id": e["id"], "name": t.get("name", ""), "kind": kind,
                "height_m": h, "height_source": src, "area_m2": round(area),
                "ring": [[round(a, 7), round(b, 7)] for a, b in ring],
            })
            if t.get("name"):
                add_place(t["name"], t.get("amenity") or kind, cla, clo)
            if t.get("amenity"):
                _amenity_poi(pois, t, cla, clo)
            continue

        kind = None
        if t.get("natural") == "water" or t.get("water") or t.get("landuse") in ("reservoir", "basin"):
            kind = "water"
        elif t.get("leisure") in ("park", "garden") or t.get("landuse") in ("grass", "meadow", "recreation_ground", "village_green"):
            kind = "park"
        elif t.get("leisure") in ("pitch", "yes", "sports_centre", "playground") or "ground" in t.get("name", "").lower():
            kind = "ground"
        elif t.get("natural") in ("wood", "scrub", "tree_row") or t.get("landuse") in ("forest", "orchard"):
            kind = "woodland"
        elif t.get("landuse") == "education" or t.get("amenity") in ("college", "school", "university"):
            kind = "campus"
        elif t.get("landuse") in ("residential",):
            kind = "residential"
        elif t.get("landuse") in ("commercial", "retail", "industrial"):
            kind = "commercial"
        elif t.get("amenity") == "parking":
            kind = "parking"
        if kind:
            surfaces.append({
                "id": f"s{len(surfaces)}", "kind": kind, "name": t.get("name", ""), "area_m2": round(area),
                "ring": [[round(a, 7), round(b, 7)] for a, b in ring],
            })
            if t.get("name"):
                add_place(t["name"], kind, cla, clo)

    # Nodes: trees, amenities, named points
    for e in els:
        if e["type"] != "node" or "tags" not in e:
            continue
        t = e["tags"]
        lat, lon = e["lat"], e["lon"]
        if not geo.in_bbox(lat, lon):
            continue
        if t.get("natural") == "tree":
            trees.append({"lat": lat, "lon": lon, "radius_m": 5.0, "density": 0.8, "source": "osm"})
        if t.get("amenity") or t.get("shop"):
            _amenity_poi(pois, t, lat, lon)
            if t.get("name") and t.get("amenity"):
                add_place(t["name"], t["amenity"], lat, lon)

    _synthesise_canopy(trees, roads, surfaces, buildings, rng)
    _seed_pois(pois, roads, surfaces, places, rng)

    for i, p in enumerate(pois):
        p["id"] = f"p{i}"

    # Friendly aliases for the demo
    for p in places:
        if p["name"].startswith("TSSM"):
            p["name"] = "TSSM Bhivarabai Sawant College of Engineering (BSCOER)"
            p["featured"] = True
        if p["name"] in ("Zeal College of Engineering and Research", "Jambhulwadi Lake", "School of Fashion Technology",
                         "Swami Narayan Temple", "Vision English Medium School"):
            p["featured"] = True

    zone = {
        "meta": {
            "name": ZONE_NAME, "city": ZONE_CITY, "bbox": list(BBOX), "center": list(CENTER),
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "osm_timestamp": raw.get("osm3s", {}).get("timestamp_osm_base"),
            "counts": {
                "roads": len(roads), "buildings": len(buildings),
                "buildings_height_osm": sum(b["height_source"] == "osm" for b in buildings),
                "surfaces": len(surfaces), "trees_osm": sum(t["source"] == "osm" for t in trees),
                "trees_estimated": sum(t["source"] != "osm" for t in trees),
                "pois_osm": sum(p["source"] == "osm" for p in pois),
                "pois_seeded": sum(p["source"] != "osm" for p in pois), "places": len(places),
            },
        },
        "roads": roads, "buildings": buildings, "surfaces": surfaces,
        "trees": [{**t, "lat": round(t["lat"], 7), "lon": round(t["lon"], 7)} for t in trees],
        "pois": pois, "places": places,
    }
    ZONE_FILE.write_text(json.dumps(zone, separators=(",", ":")), encoding="utf8")
    return zone


def _amenity_poi(pois: list, t: dict, lat: float, lon: float) -> None:
    a = t.get("amenity", "")
    name = t.get("name") or a.replace("_", " ").title() or t.get("shop", "Shop").title()
    if a in ("drinking_water", "water_point"):
        typ = "water"
    elif a in ("restaurant", "cafe", "fast_food", "food_court", "ice_cream") or t.get("shop"):
        typ = "water"  # refreshments / drinking water available
    elif a in ("hospital", "clinic", "doctors", "pharmacy", "library", "community_centre"):
        typ = "cooling_center"
    elif a in ("place_of_worship", "bench", "shelter"):
        typ = "rest"
    else:
        return
    pois.append({"type": typ, "name": name, "lat": round(lat, 7), "lon": round(lon, 7), "source": "osm",
                 "detail": a or t.get("shop", "")})


def _synthesise_canopy(trees, roads, surfaces, buildings, rng) -> None:
    """Estimated canopy: street trees + campus/park perimeter + lake-edge vegetation."""
    b_masks = []
    for b in buildings:
        xy = [geo.to_xy(*p) for p in b["ring"]]
        xs = [p[0] for p in xy]
        ys = [p[1] for p in xy]
        b_masks.append((min(xs), min(ys), max(xs), max(ys)))

    def clear(x, y):
        for x0, y0, x1, y1 in b_masks:
            if x0 - 2 <= x <= x1 + 2 and y0 - 2 <= y <= y1 + 2:
                return False
        return True

    # Canopy character is assigned per street (OSM way): tree-lined avenues vs. bare roads,
    # which is how real neighbourhoods look — and why parallel streets differ so much in heat.
    avenue_p = {"residential": 0.45, "service": 0.55, "tertiary": 0.35, "unclassified": 0.4, "living_street": 0.6,
                "footway": 0.7, "path": 0.6, "track": 0.45, "trunk": 0.05, "trunk_link": 0.05}
    way_rng: dict[int, float] = {}
    for r in roads:
        wr = random.Random(r["osm_id"])
        if r["osm_id"] not in way_rng:
            way_rng[r["osm_id"]] = 0.85 if wr.random() < avenue_p.get(r["highway"], 0.3) else 0.1
        p = way_rng[r["osm_id"]]
        pts = [geo.to_xy(la, lo) for _, la, lo in r["nodes"]]
        for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
            L = math.hypot(bx - ax, by - ay)
            if L < 1:
                continue
            nx, ny = -(by - ay) / L, (bx - ax) / L
            steps = int(L // 12)
            for k in range(steps + 1):
                if rng.random() > p:
                    continue
                t = (k + rng.random() * 0.5) / max(steps, 1)
                side = rng.choice((-1, 1))
                off = r["width_m"] / 2 + rng.uniform(1.0, 3.0)
                x = ax + (bx - ax) * min(t, 1) + nx * off * side
                y = ay + (by - ay) * min(t, 1) + ny * off * side
                if clear(x, y) and 0 < x < geo.WIDTH_M and 0 < y < geo.HEIGHT_M:
                    la, lo = geo.to_latlon(x, y)
                    trees.append({"lat": la, "lon": lo, "radius_m": round(rng.uniform(4.0, 7.0), 1),
                                  "density": round(rng.uniform(0.7, 0.92), 2), "source": "estimated"})

    for s in surfaces:
        if s["kind"] not in ("campus", "park", "water", "woodland", "ground"):
            continue
        xy = [geo.to_xy(*p) for p in s["ring"]]
        spacing = {"water": 9, "park": 10, "woodland": 8}.get(s["kind"], 14)
        pr = {"water": 0.75, "park": 0.8, "woodland": 0.9, "campus": 0.6, "ground": 0.35}[s["kind"]]
        for (ax, ay), (bx, by) in zip(xy, xy[1:] + xy[:1]):
            L = math.hypot(bx - ax, by - ay)
            for k in range(int(L // spacing) + 1):
                if rng.random() > pr:
                    continue
                t = k * spacing / max(L, 1)
                x, y = ax + (bx - ax) * t, ay + (by - ay) * t
                # push slightly inside/outside for lake-edge vegetation
                x += rng.uniform(-3, 3)
                y += rng.uniform(-3, 3)
                if clear(x, y) and 0 < x < geo.WIDTH_M and 0 < y < geo.HEIGHT_M:
                    la, lo = geo.to_latlon(x, y)
                    trees.append({"lat": la, "lon": lo, "radius_m": round(rng.uniform(4.5, 7.5), 1),
                                  "density": round(rng.uniform(0.6, 0.9), 2), "source": "estimated"})


def _seed_pois(pois, roads, surfaces, places, rng) -> None:
    """Seed water points, rest benches and shade shelters (clearly marked as seeded)."""
    # Water points + rest area at every campus / school
    for s in surfaces:
        if s["kind"] in ("campus",) or (s["kind"] == "ground" and s["name"]):
            xy = [geo.to_xy(*p) for p in s["ring"]]
            cx = sum(p[0] for p in xy) / len(xy)
            cy = sum(p[1] for p in xy) / len(xy)
            la, lo = geo.to_latlon(cx, cy)
            nm = s["name"] or "Campus"
            pois.append({"type": "water", "name": f"Drinking water · {nm}", "lat": la, "lon": lo, "source": "seeded"})
            la2, lo2 = geo.to_latlon(cx + 25, cy - 15)
            pois.append({"type": "rest", "name": f"Shaded benches · {nm}", "lat": la2, "lon": lo2, "source": "seeded"})
        if s["kind"] == "water":
            xy = [geo.to_xy(*p) for p in s["ring"]]
            for i in range(0, len(xy), max(len(xy) // 4, 1)):
                la, lo = geo.to_latlon(*xy[i])
                pois.append({"type": "rest", "name": f"Lakeside rest point · {s['name'] or 'Lake'}", "lat": la, "lon": lo,
                             "source": "seeded"})

    # Bus-stop shelters (shade) along major roads + water kiosks along residential streets
    acc = {"shade": 0.0, "water": 0.0}
    for r in sorted(roads, key=lambda r: r["id"]):
        pts = [geo.to_xy(la, lo) for _, la, lo in r["nodes"]]
        major = r["highway"] in ("trunk", "tertiary", "primary", "secondary")
        for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
            L = math.hypot(bx - ax, by - ay)
            if major:
                acc["shade"] += L
                if acc["shade"] > 330:
                    acc["shade"] = 0
                    la, lo = geo.to_latlon((ax + bx) / 2, (ay + by) / 2)
                    nm = r["name"] or "main road"
                    pois.append({"type": "shade", "name": f"Bus shelter · {nm}", "lat": la, "lon": lo, "source": "seeded"})
            elif r["highway"] in ("residential", "service", "unclassified"):
                acc["water"] += L
                if acc["water"] > 420:
                    acc["water"] = 0
                    la, lo = geo.to_latlon((ax + bx) / 2, (ay + by) / 2)
                    kind = rng.choice(["water", "water", "rest", "shade"])
                    label = {"water": "Water kiosk", "rest": "Rest bench", "shade": "Shade canopy"}[kind]
                    nm = r["name"] or "lane"
                    pois.append({"type": kind, "name": f"{label} · {nm}", "lat": la, "lon": lo, "source": "seeded"})

    # A designated cooling centre on the TSSM campus
    for p in places:
        if p["name"].startswith("TSSM"):
            pois.append({"type": "cooling_center", "name": "TSSM Library · designated cooling room",
                         "lat": p["lat"] + 0.00012, "lon": p["lon"] - 0.0002, "source": "seeded"})
