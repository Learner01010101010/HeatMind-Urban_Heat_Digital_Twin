"""Infer a usable building typology for the 96% of footprints OSM only tags `building=yes`.

Of 998 footprints in the zone, 961 carry no semantic type.  The 3D twin needs a
typology to drive facade generation (floor height, glazing ratio, roof style), and
guessing per-building at render time would be non-deterministic and unexplainable.

So we infer once, from signals that are actually real:
  * footprint area and perimeter        — true OSM geometry
  * compactness 4*pi*A/P^2              — blocky institutional vs. irregular informal
  * containing landuse polygon          — true OSM (campus / commercial / residential ...)
  * class of the nearest road           — true OSM

Deliberately NOT used: `height_m`.  For `building=yes` footprints the height is
itself estimated from the area (osm_ingest._estimate_height), so feeding it back in
would be circular and would invent confidence that is not there.

Every result is labelled `kind_source: "inferred"`, mirroring the existing
`height_source: "estimated"` disclosure — nothing here is presented as surveyed fact.
"""
from __future__ import annotations

import numpy as np

from . import geo

# Render typologies the facade generator understands.
TYPOLOGIES = ("academic", "campus_support", "commercial", "industrial",
              "apartments", "residential", "house", "shed", "temple")

# OSM building tags that already map cleanly onto a typology.
OSM_KIND_MAP = {
    "apartments": "apartments", "residential": "apartments", "terrace": "residential",
    "house": "house", "detached": "house", "bungalow": "house",
    "college": "academic", "school": "academic", "university": "academic",
    "hospital": "academic", "commercial": "commercial", "retail": "commercial",
    "office": "commercial", "industrial": "industrial", "warehouse": "industrial",
    "temple": "temple", "place_of_worship": "temple",
    "shed": "shed", "garage": "shed", "hut": "shed", "kiosk": "shed", "roof": "shed",
}

MAJOR_ROADS = ("trunk", "trunk_link", "primary", "secondary", "tertiary")


def _ring_xy(ring) -> np.ndarray:
    return np.array([geo.to_xy(la, lo) for la, lo in ring], dtype=float)


def _perimeter(xy: np.ndarray) -> float:
    d = np.diff(np.vstack([xy, xy[:1]]), axis=0)
    return float(np.hypot(d[:, 0], d[:, 1]).sum())


def _point_in_ring(x: float, y: float, ring: np.ndarray) -> bool:
    """Even-odd crossing test."""
    inside = False
    xj, yj = ring[-1]
    for xi, yi in ring:
        if (yi > y) != (yj > y):
            xint = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < xint:
                inside = not inside
        xj, yj = xi, yi
    return inside


class TypeIndex:
    """Precomputed landuse rings + road-node KD-ish arrays for cheap per-building queries."""

    def __init__(self, data: dict) -> None:
        self.landuse = [(s["kind"], _ring_xy(s["ring"])) for s in data["surfaces"]]
        # bounding boxes let us skip almost every ring per query
        self.landuse_bbox = [(r[:, 0].min(), r[:, 0].max(), r[:, 1].min(), r[:, 1].max())
                             for _, r in self.landuse]
        pts, cls = [], []
        for r in data["roads"]:
            for _, la, lo in r["nodes"]:
                pts.append(geo.to_xy(la, lo))
                cls.append(r["highway"])
        self.road_xy = np.array(pts, dtype=float) if pts else np.zeros((0, 2))
        self.road_class = cls

    def landuse_at(self, x: float, y: float) -> str | None:
        for (kind, ring), (x0, x1, y0, y1) in zip(self.landuse, self.landuse_bbox):
            if x0 <= x <= x1 and y0 <= y <= y1 and _point_in_ring(x, y, ring):
                return kind
        return None

    def nearest_road(self, x: float, y: float) -> tuple[str | None, float]:
        if not len(self.road_xy):
            return None, float("inf")
        d2 = (self.road_xy[:, 0] - x) ** 2 + (self.road_xy[:, 1] - y) ** 2
        i = int(np.argmin(d2))
        return self.road_class[i], float(np.sqrt(d2[i]))


def _infer(area: float, compactness: float, landuse: str | None,
           road_class: str | None, road_dist: float) -> str:
    on_major = road_class in MAJOR_ROADS and road_dist < 45

    if landuse == "campus":
        return "academic" if area >= 600 else "campus_support"
    if area >= 1500 and compactness > 0.6:
        return "industrial"
    if landuse == "commercial" or (on_major and area >= 200):
        return "commercial"
    if area >= 500:
        return "apartments"
    if area < 60:
        return "shed"
    if area < 150:
        return "house"
    return "residential"


def classify(data: dict) -> dict[str, tuple[str, str]]:
    """building id -> (typology, source)."""
    idx = TypeIndex(data)
    out: dict[str, tuple[str, str]] = {}
    for b in data["buildings"]:
        mapped = OSM_KIND_MAP.get(b["kind"])
        if mapped:
            out[b["id"]] = (mapped, "osm")
            continue
        xy = _ring_xy(b["ring"])
        cx, cy = float(xy[:, 0].mean()), float(xy[:, 1].mean())
        area = max(float(b["area_m2"]), 1.0)
        perim = max(_perimeter(xy), 1.0)
        compactness = min(1.0, 4 * np.pi * area / (perim * perim))
        rc, rd = idx.nearest_road(cx, cy)
        out[b["id"]] = (_infer(area, compactness, idx.landuse_at(cx, cy), rc, rd), "inferred")
    return out


def classify_cached(zone) -> dict[str, tuple[str, str]]:
    if not hasattr(zone, "_building_types"):
        zone._building_types = classify(zone.data)
    return zone._building_types
