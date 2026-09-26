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


# Carriageway geometry. A marked lane in urban India runs about 3.25 m, and a
# classified road carries a shoulder or kerb strip either side.
LANE_M = 3.25
SHOULDER_M = 0.75
CLASSIFIED = frozenset({"trunk", "primary", "secondary", "tertiary", "unclassified",
                        "trunk_link", "primary_link", "tertiary_link"})


def _float(v: object) -> float | None:
    """First number in an OSM value, so `7`, `7.5` and `7 m` all parse."""
    try:
        return float(str(v).strip().split()[0].replace(",", "."))
    except (ValueError, IndexError, AttributeError):
        return None


def _road_width(t: dict, hw: str, default: float) -> tuple[float, str]:
    """Carriageway width in metres, and where the number came from.

    Only 2 ways in the whole zone carry a `width` tag and 321 carry `lanes`, so most
    roads still fall back to the class default -- but a six-lane stretch of the
    Katraj-Dehu bypass is 20 m of asphalt, not the 18 m its class implies, and a
    one-lane service road is 3 m, not 4. Where OSM counted the lanes, the lanes are
    what gets drawn.
    """
    w = _float(t.get("width")) or _float(t.get("carriageway_width"))
    if w and 0.5 <= w <= 60:
        return w, "width_tag"
    lanes = _float(t.get("lanes"))
    if lanes and 1 <= lanes <= 12:
        shoulder = 2 * SHOULDER_M if hw in CLASSIFIED else 0.0
        return round(lanes * LANE_M + shoulder, 1), "lanes_tag"
    return default, "class_default"


BUILDINGS_FILE = OSM_RAW.parent / "buildings.json"
CANOPY_FILE = OSM_RAW.parent / "canopy.json"


def _load_measured_buildings() -> list[dict] | None:
    """Footprints and heights measured from satellite, if scripts/fetch_buildings.py has run.

    Returns None when the file is absent so a fresh checkout still builds a zone from
    OSM alone -- degraded, and the meta counts say so, but not broken.
    """
    if not BUILDINGS_FILE.exists():
        return None
    d = json.loads(BUILDINGS_FILE.read_text(encoding="utf8"))
    out = []
    for i, b in enumerate(d["buildings"]):
        out.append({
            "id": f"b{i}", "osm_id": b.get("oid", ""), "name": b.get("name", ""),
            "kind": b.get("kind") or "yes", "height_m": b["height_m"],
            "height_source": b.get("height_source", "satellite"),
            "area_m2": b.get("area_m2", 0), "ring": b["ring"],
        })
    return out


def _load_canopy() -> dict | None:
    """Trees and land cover measured from satellite, if scripts/fetch_canopy.py has run."""
    if not CANOPY_FILE.exists():
        return None
    d = json.loads(CANOPY_FILE.read_text(encoding="utf8"))
    # Widest crowns first. The renderer draws a budget of instances rather than all
    # 102,877 at once, and taking them off the front of a sorted list means the ones
    # it drops are the smallest -- a scrap of hedge rather than a park's tree line.
    trees = sorted(d["trees"], key=lambda t: -t["radius_m"])
    return {"trees": trees, "landcover_b64": d.get("landcover_b64", "")}


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
    # Measured footprints if the build step has run, otherwise the OSM ones so the
    # twin still builds from a bare checkout.
    measured = _load_measured_buildings()
    buildings: list[dict] = measured or []
    osm_buildings: list[dict] | None = None if measured else []
    surfaces: list[dict] = []
    trees: list[dict] = []
    signals: list[dict] = []
    pois: list[dict] = []
    places: list[dict] = []
    seen_places: set[str] = set()

    def add_place(name: str, kind: str, lat: float, lon: float, featured: bool = False) -> None:
        key = name.strip().lower()
        if not name or key in seen_places or not geo.in_bbox(lat, lon):
            return
        seen_places.add(key)
        rec = {"id": f"pl{len(places)}", "name": name.strip(), "kind": kind,
               "lat": round(lat, 6), "lon": round(lon, 6)}
        if featured:
            rec["featured"] = True
        places.append(rec)

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
            road_w, road_w_src = _road_width(t, hw, width)
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
                    "width_m": road_w,
                    "width_source": road_w_src,
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
            # Geometry and height come from the measured set (see below); OSM is
            # still the only source of a building's *name*, so it is read for that.
            kind = t.get("building", "yes")
            if osm_buildings is not None:
                h = _levels(t)
                src = "osm"
                if h is None:
                    h = _estimate_height(kind, area, rng)
                    src = "estimated"
                osm_buildings.append({
                    "id": f"b{len(osm_buildings)}", "osm_id": e["id"], "name": t.get("name", ""),
                    "kind": kind, "height_m": h, "height_source": src, "area_m2": round(area),
                    "ring": [[round(a, 7), round(b, 7)] for a, b in ring],
                })
            if t.get("name"):
                add_place(t["name"], t.get("amenity") or kind, cla, clo)
            if t.get("amenity"):
                _amenity_poi(pois, t, cla, clo, f"{e['type']}/{e['id']}")
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
        hw_node = t.get("highway")
        if hw_node in _SIGNAL_KINDS:
            signals.append({"lat": round(lat, 7), "lon": round(lon, 7), "kind": hw_node,
                            "crossing": t.get("crossing", ""),
                            "name": t.get("name", "")})
        if t.get("amenity") or t.get("shop"):
            _amenity_poi(pois, t, lat, lon, f"{e['type']}/{e['id']}")
            if t.get("name") and t.get("amenity"):
                add_place(t["name"], t["amenity"], lat, lon)
        # Neighbourhood names. Without these the search box knows shops and colleges
        # but not "Swargate" or "Katraj", so the one destination a Pune user is most
        # likely to type is the one they cannot pick. Settlement-level names are
        # featured so they head the list when the box is empty.
        if t.get("place") and t.get("name"):
            add_place(t["name"], f"place:{t['place']}", lat, lon,
                      featured=t["place"] in _FEATURED_PLACE_KINDS)

    if osm_buildings is not None:
        buildings = osm_buildings

    junctions = _junctions(roads)

    # Canopy is measured, never invented. _synthesise_canopy() used to scatter
    # 33,329 trees down streets a random number called "tree-lined"; those trees
    # shaded the model's streets and none of them existed. Now the only trees are
    # the ones OSM maps individually plus the ones a 1 m canopy-height raster sees.
    landcover_b64 = ""
    canopy = _load_canopy()
    if canopy:
        trees.extend(canopy["trees"])
        landcover_b64 = canopy.get("landcover_b64", "")
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
            "amenities_version": 3,
            "name": ZONE_NAME, "city": ZONE_CITY, "bbox": list(BBOX), "center": list(CENTER),
            "generated_at": datetime.utcnow().isoformat() + "Z",
            "osm_timestamp": raw.get("osm3s", {}).get("timestamp_osm_base"),
            "counts": {
                "roads": len(roads), "buildings": len(buildings),
                "buildings_height_tagged": sum(b.get("height_source") == "tagged" for b in buildings),
                "surfaces": len(surfaces),
                "trees_osm": sum(t["source"] == "osm" for t in trees),
                "trees_measured": sum(t["source"] == "chm" for t in trees),
                "trees_estimated": sum(t["source"] not in ("osm", "chm") for t in trees),
                "buildings_height_measured": sum(
                    b.get("height_source") in ("satellite", "satellite_low", "tagged")
                    for b in buildings),
                "pois_osm": sum(p["source"] == "osm" for p in pois),
                "pois_seeded": sum(p["source"] != "osm" for p in pois), "places": len(places),
                "junctions": len(junctions), "signals": len(signals),
                "roads_width_measured": sum(r["width_source"] != "class_default" for r in roads),
            },
        },
        "roads": roads, "buildings": buildings, "surfaces": surfaces,
        "junctions": junctions, "signals": signals,
        "landcover_b64": landcover_b64,
        "trees": [{**t, "lat": round(t["lat"], 7), "lon": round(t["lon"], 7)} for t in trees],
        "pois": pois, "places": places,
    }
    ZONE_FILE.write_text(json.dumps(zone, separators=(",", ":")), encoding="utf8")
    return zone


# Highway nodes worth drawing. Signals and crossings change how a pedestrian
# actually moves through a junction, which is the point of a walking router; the
# rest are geometry hints that only matter for rendering the junction itself.
_SIGNAL_KINDS = frozenset({"traffic_signals", "crossing", "stop", "give_way", "mini_roundabout"})


def _junctions(roads: list[dict]) -> list[dict]:
    """Nodes where the network actually connects, with the radius that fills them.

    Roads are drawn as independent ribbons, one per OSM way. Two ways meeting at an
    angle leave an unfilled wedge on the outside of the turn, and a narrow way
    T-joining a wide one stops dead at the wide one's kerb -- so at every real
    intersection the network came apart into loose ends. OSM splits ways at
    intersections, so the shared node is exactly where that happens.

    The radius is half the widest road at the node, which is the disc that covers
    every incident carriageway; capped, because a 20 m trunk crossing would otherwise
    paint a 10 m roundabout onto a plain signalised junction.
    """
    seen: dict[int, list[float]] = {}
    for r in roads:
        w = r["width_m"]
        for nid, la, lo in r["nodes"]:
            e = seen.get(nid)
            if e is None:
                seen[nid] = [la, lo, w, 1]
            else:
                e[2] = max(e[2], w)
                e[3] += 1
    out = []
    for nid, (la, lo, w, n) in seen.items():
        if n < 2:
            continue
        out.append({"lat": round(la, 7), "lon": round(lo, 7),
                    "r_m": round(min(w, 22.0) / 2, 2)})
    return out


# place=* values worth surfacing as destinations. Smaller values (isolated_dwelling,
# farm, locality) are kept as searchable places but not promoted.
_FEATURED_PLACE_KINDS = frozenset({"city", "town", "suburb", "neighbourhood", "village"})


def _amenity_poi(pois: list, t: dict, lat: float, lon: float, osm_ref: str = "") -> None:
    a = t.get("amenity", "")
    name = t.get("name") or a.replace("_", " ").title() or t.get("shop", "Shop").title()
    if a in ("drinking_water", "water_point", "water_dispenser"):
        typ = "water"
    elif a in ("restaurant", "cafe", "fast_food", "food_court", "ice_cream") or t.get("shop") in ("convenience", "supermarket", "dairy", "grocery", "grocer", "bakery", "beverages", "water", "general"):
        typ = "water"  # Potential purchase stop; never treated as a public tap.
    elif a in ("hospital", "clinic", "doctors", "pharmacy", "library", "community_centre"):
        typ = "cooling_center"
    elif a in ("place_of_worship", "bench", "shelter", "toilets"):
        typ = "rest"
    else:
        return
    fields = {k: t[k] for k in ("opening_hours", "operator", "access", "fee", "wheelchair", "drinking_water",
                                "capacity", "covered", "wikimedia_commons", "wikidata", "mapillary") if t.get(k)}
    pois.append({"type": typ, "name": name, "lat": round(lat, 7), "lon": round(lon, 7), "source": "osm",
                 "detail": a or t.get("shop", ""), "osm_ref": osm_ref, **fields})


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
