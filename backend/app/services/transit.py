"""PMPML bus stops, read from the zone's own OpenStreetMap extract.

What is real here and what is not, because the difference matters for a product
that publishes a provenance table:

  * The **stops** are real. They come from the same Overpass extract every other
    layer is built from — 116 of them across Narhe to Swargate, 34 carrying an
    explicit PMPML operator tag, most of them named in the form riders actually
    use ("Katraj", "Navale Bridge", "Jadhavnagar Galli No.11").

  * The **itinerary** is not. The extract carries no `route=bus` relations and
    there is no public PMPML GTFS feed to attach, so nothing here knows which
    numbered service connects two stops or when it is due. A bus leg is therefore
    routed over the roads a bus can physically use and timed from a headway
    assumption, and every response says so. Inventing a route number would be the
    one thing worse than not having one.

The seam for a real feed is `BusModel`: give it a GTFS shape and the geometry and
timings stop being modelled without anything upstream changing.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import lru_cache

# Stops are extracted from the raw Overpass dump rather than zone.json, which was
# built before transit was modelled and carries no stops of its own. Re-running the
# full OSM ingest would need the network; this needs one file already on disk.
from ..config import BBOX, ZONE_FILE

RAW_FILE = ZONE_FILE.parent / "osm_raw.json"
CACHE_FILE = ZONE_FILE.parent / "bus_stops.json"

# PMPML publishes no headway per route and runs no feed we can read. Pune city
# services on the corridors in this zone sit broadly in the 10-20 minute band off
# peak, so a rider who has not timed their arrival waits about half of that. This is
# the single number that makes a bus ETA a model rather than a timetable, which is
# why it is one named constant and is reported in the response.
HEADWAY_MIN = 15.0
"""Assumed mean headway, minutes. Modelled — see module docstring."""

BUS_SPEED_MS = 5.6
"""~20 km/h: PMPML's effective in-traffic speed including stops, not its top speed."""

DWELL_S = 18.0
"""Seconds lost at each intermediate stop the bus passes."""

WALK_TO_STOP_MAX_M = 1500.0
"""How far someone will walk to reach a stop.

Deliberately generous. The usual planning figure is 400-800 m, but that is the
distance people walk for a *short* trip; for a 6 km journey across south Pune a
15-minute walk to a bus that covers the rest is an ordinary trade. The guard against
silly itineraries is MIN_RIDE_M and the comparison against the walking route sitting
next to it in the results -- not an arbitrarily tight radius that answers "no bus"
for a corridor that plainly has buses on it."""


@dataclass(frozen=True)
class Stop:
    id: str
    name: str
    lat: float
    lon: float
    operator: str
    shelter: bool
    """True where OSM records a shelter — the difference between waiting in shade
    and waiting in full sun, which for a heat product is the whole point of the tag."""
    source: str = "osm"


def _centroid(way: dict, nodes: dict[int, tuple[float, float]]) -> tuple[float, float] | None:
    """Mean of a way's member nodes. Bus stations are mapped as areas, not points."""
    pts = [nodes[n] for n in way.get("nodes", []) if n in nodes]
    if not pts:
        return None
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def _is_stop(tags: dict) -> bool:
    if tags.get("highway") == "bus_stop" or tags.get("amenity") == "bus_station":
        return True
    # `stop_position` is the point on the carriageway where the bus halts and
    # `platform` is the kerb the rider stands on. Either one marks a usable stop;
    # taking both and de-duplicating by position keeps stops mapped only one way.
    return tags.get("public_transport") in ("platform", "stop_position", "station")


def _extract() -> list[dict]:
    raw = json.loads(RAW_FILE.read_text(encoding="utf8"))
    elements = raw.get("elements", [])
    nodes = {e["id"]: (e["lat"], e["lon"]) for e in elements
             if e["type"] == "node" and "lat" in e}

    south, west, north, east = BBOX
    out: list[dict] = []
    for e in elements:
        tags = e.get("tags") or {}
        if not _is_stop(tags):
            continue
        if e["type"] == "node":
            pos = nodes.get(e["id"])
        elif e["type"] == "way":
            pos = _centroid(e, nodes)
        else:
            continue  # relations here are site groupings, already covered by members
        if pos is None:
            continue
        lat, lon = pos
        if not (south <= lat <= north and west <= lon <= east):
            continue
        operator = tags.get("operator", "")
        # OSM carries the operator spelled out as often as abbreviated; both are the
        # same agency and a rider would not distinguish them.
        if operator.lower().startswith("pune mahanagar"):
            operator = "PMPML"
        out.append({
            "id": f"bs{e['type'][0]}{e['id']}",
            "name": tags.get("name") or "Bus stop",
            "lat": round(lat, 7),
            "lon": round(lon, 7),
            "operator": operator,
            "shelter": tags.get("shelter") in ("yes", "true", "1"),
        })

    # Platform and stop_position are frequently mapped as a pair a few metres apart,
    # and a kerb on each side of a road is two stops with one name. Collapse anything
    # closer than 25 m under the same name into one; keep same-name stops further
    # apart, because "Katraj" legitimately names several along the corridor.
    out.sort(key=lambda s: (s["name"], s["lat"], s["lon"]))
    merged: list[dict] = []
    for s in out:
        dup = next(
            (m for m in merged
             if m["name"] == s["name"] and _haversine_m(m["lat"], m["lon"], s["lat"], s["lon"]) < 25.0),
            None,
        )
        if dup is None:
            merged.append(s)
        elif not dup["operator"] and s["operator"]:
            dup["operator"] = s["operator"]  # keep the more specific record
            dup["shelter"] = dup["shelter"] or s["shelter"]
    return merged


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


@lru_cache(maxsize=1)
def stops() -> list[Stop]:
    """Every bus stop in the zone, cached after the first extraction.

    The raw Overpass dump is ~19 MB and parsing it costs a couple of seconds, so the
    extracted stops are written alongside it and read from there afterwards. The
    cache is derived data: deleting it only costs one slow start.
    """
    records: list[dict] | None = None
    if CACHE_FILE.exists():
        try:
            records = json.loads(CACHE_FILE.read_text(encoding="utf8"))
        except (ValueError, OSError):
            records = None  # corrupt cache: fall through and rebuild
    if records is None:
        records = _extract()
        try:
            CACHE_FILE.write_text(json.dumps(records), encoding="utf8")
        except OSError:
            pass  # a read-only data dir is not a reason to fail the request
    return [Stop(**r) for r in records]


def describe() -> dict:
    """Provenance for /api/meta — what is measured and what is assumed."""
    all_stops = stops()
    return {
        "stops": len(all_stops),
        "pmpml_tagged": sum(1 for s in all_stops if s.operator == "PMPML"),
        "sheltered": sum(1 for s in all_stops if s.shelter),
        "headway_min": HEADWAY_MIN,
        "bus_speed_kmh": round(BUS_SPEED_MS * 3.6, 1),
        "schedule_source": "modelled",
        "note": (
            "Stop locations, names and operators are real OpenStreetMap data. No PMPML "
            "timetable or GTFS feed is available for this zone, so the bus leg is routed "
            "over bus-capable roads and timed from an assumed "
            f"{HEADWAY_MIN:.0f}-minute headway — it is not a scheduled service."
        ),
    }
