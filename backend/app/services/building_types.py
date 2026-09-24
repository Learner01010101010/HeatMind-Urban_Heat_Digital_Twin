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

import math

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


# Both indexes below are uniform bucket grids rather than linear scans, and that is
# not premature optimisation: the linear version was O(buildings x road_nodes). Over
# the campus zone that was ~1e3 x 5e3 and invisible, but the zone now spans Narhe to
# Swargate, where it becomes ~3e4 x 6e4 -- close to two billion distance terms, each
# one allocating a full-length array. Bucketing makes both queries local.
_ROAD_BUCKET_M = 50.0
_LANDUSE_BUCKET_M = 100.0
# _infer() only ever asks whether the nearest road is within 45 m, so giving up past
# this radius is exact for every decision that depends on the answer, and stops a
# building in open country from scanning the whole city.
_ROAD_SEARCH_CAP_M = 150.0
# A ring whose bbox covers more buckets than this (a city-wide landuse polygon) is
# held aside and tested on every query, rather than smeared over thousands of cells.
_MAX_BUCKETS_PER_RING = 400


class TypeIndex:
    """Precomputed landuse rings + road nodes, bucketed for cheap per-building queries."""

    def __init__(self, data: dict) -> None:
        self.landuse = [(s["kind"], _ring_xy(s["ring"])) for s in data["surfaces"]]
        # bounding boxes let us reject a ring before running the crossing test
        self.landuse_bbox = [(r[:, 0].min(), r[:, 0].max(), r[:, 1].min(), r[:, 1].max())
                             for _, r in self.landuse]

        self._lu_buckets: dict[tuple[int, int], list[int]] = {}
        self._lu_everywhere: list[int] = []
        b = _LANDUSE_BUCKET_M
        for i, (x0, x1, y0, y1) in enumerate(self.landuse_bbox):
            bx0, bx1 = int(x0 // b), int(x1 // b)
            by0, by1 = int(y0 // b), int(y1 // b)
            if (bx1 - bx0 + 1) * (by1 - by0 + 1) > _MAX_BUCKETS_PER_RING:
                self._lu_everywhere.append(i)
                continue
            for bx in range(bx0, bx1 + 1):
                for by in range(by0, by1 + 1):
                    self._lu_buckets.setdefault((bx, by), []).append(i)

        pts, cls = [], []
        for r in data["roads"]:
            for _, la, lo in r["nodes"]:
                pts.append(geo.to_xy(la, lo))
                cls.append(r["highway"])
        self.road_xy = np.array(pts, dtype=float) if pts else np.zeros((0, 2))
        self.road_class = cls

        self._rd_buckets: dict[tuple[int, int], list[int]] = {}
        r_b = _ROAD_BUCKET_M
        for i, (x, y) in enumerate(self.road_xy):
            self._rd_buckets.setdefault((int(x // r_b), int(y // r_b)), []).append(i)

    def landuse_at(self, x: float, y: float) -> str | None:
        b = _LANDUSE_BUCKET_M
        cand = self._lu_buckets.get((int(x // b), int(y // b)), ())
        for i in (*cand, *self._lu_everywhere):
            kind, ring = self.landuse[i]
            x0, x1, y0, y1 = self.landuse_bbox[i]
            if x0 <= x <= x1 and y0 <= y <= y1 and _point_in_ring(x, y, ring):
                return kind
        return None

    def nearest_road(self, x: float, y: float) -> tuple[str | None, float]:
        """Exact nearest road node within _ROAD_SEARCH_CAP_M; (None, inf) beyond it."""
        if not len(self.road_xy):
            return None, float("inf")
        b = _ROAD_BUCKET_M
        cx, cy = int(x // b), int(y // b)
        best_i, best_d2 = -1, float("inf")
        max_ring = int(_ROAD_SEARCH_CAP_M // b) + 1
        for ring in range(max_ring + 1):
            idxs: list[int] = []
            for dx in range(-ring, ring + 1):
                for dy in range(-ring, ring + 1):
                    # only the shell of this ring; inner rings were already searched
                    if max(abs(dx), abs(dy)) == ring:
                        idxs.extend(self._rd_buckets.get((cx + dx, cy + dy), ()))
            if idxs:
                pts = self.road_xy[idxs]
                d2 = (pts[:, 0] - x) ** 2 + (pts[:, 1] - y) ** 2
                j = int(np.argmin(d2))
                if float(d2[j]) < best_d2:
                    best_d2, best_i = float(d2[j]), idxs[j]
            # A hit in ring N can still be beaten by one in a further ring, so keep
            # going until every bucket that could hold something closer is searched.
            if best_i >= 0 and ring >= int(math.sqrt(best_d2) // b) + 1:
                break
        if best_i < 0:
            return None, float("inf")
        return self.road_class[best_i], math.sqrt(best_d2)


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
