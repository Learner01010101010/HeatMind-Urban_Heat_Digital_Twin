"""Loads the zone dataset and rasterises it into the static layers of the digital twin."""
from __future__ import annotations

import json
import math
from functools import lru_cache

import numpy as np

from ..config import ZONE_FILE
from . import geo
from .osm_ingest import build_zone

# Surface classes -> (code, full-sun surface heating in °C above air, label)
SURFACES = {
    "bare": (0, 16.0, "Open dry ground"),
    "asphalt": (1, 22.0, "Asphalt"),
    "concrete": (2, 15.0, "Concrete"),
    "paving": (3, 14.0, "Paving stones"),
    "grass": (4, 6.0, "Grass / lawn"),
    "water": (5, 1.0, "Water"),
    "roof": (6, 20.0, "Roof"),
    "dirt": (7, 14.0, "Dirt / gravel"),
    "gravel": (7, 14.0, "Dirt / gravel"),
}
# Coarse bucket size for the road-segment index, and how far past the asphalt
# edge a trunk still counts as standing in the road.
_SEG_BUCKET_M = 40.0
_KERB_ALLOWANCE_M = 0.8

CODE_GAIN = np.zeros(8)
CODE_LABEL = [""] * 8
for _k, (_code, _gain, _label) in SURFACES.items():
    CODE_GAIN[_code] = _gain
    CODE_LABEL[_code] = _label

LANDUSE_SURFACE = {
    "residential": "concrete", "commercial": "concrete", "campus": "paving", "park": "grass",
    "woodland": "grass", "ground": "dirt", "water": "water", "parking": "asphalt",
}
TRAFFIC_HEAT = {"trunk": 2.2, "trunk_link": 1.4, "primary": 1.6, "secondary": 1.2, "tertiary": 0.9,
                "unclassified": 0.4, "residential": 0.3, "service": 0.15}


def box_blur(a: np.ndarray, radius_cells: int) -> np.ndarray:
    """Separable mean filter (edge-clamped) via cumulative sums."""
    if radius_cells <= 0:
        return a.astype(float)
    out = a.astype(float)
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (radius_cells + 1, radius_cells)
        p = np.pad(out, pad, mode="edge")
        cs = np.cumsum(p, axis=axis)
        k = 2 * radius_cells + 1
        if axis == 0:
            out = (cs[k:, :] - cs[:-k, :]) / k
        else:
            out = (cs[:, k:] - cs[:, :-k]) / k
    return out


class Zone:
    def __init__(self) -> None:
        if not ZONE_FILE.exists():
            build_zone()
        self.data = json.loads(ZONE_FILE.read_text(encoding="utf8"))
        R, C = geo.ROWS, geo.COLS
        self.shape = (R, C)

        surface = np.zeros((R, C), dtype=np.int8)  # default: open dry ground
        for s in sorted(self.data["surfaces"], key=lambda s: -s["area_m2"]):
            m = geo.polygon_mask([geo.to_xy(*p) for p in s["ring"]])
            if m:
                rs, cs, mask = m
                surface[rs, cs][mask] = SURFACES[LANDUSE_SURFACE[s["kind"]]][0]
        water = surface == SURFACES["water"][0]

        traffic = np.zeros((R, C))
        road_mask = np.zeros((R, C), dtype=bool)
        for r in sorted(self.data["roads"], key=lambda r: r["width_m"]):
            xy = [geo.to_xy(la, lo) for _, la, lo in r["nodes"]]
            code = SURFACES.get(r["surface"], SURFACES["asphalt"])[0]
            for rs, cs, mask in geo.line_mask(xy, r["width_m"] / 2):
                surface[rs, cs][mask] = code
                road_mask[rs, cs] |= mask
            th = TRAFFIC_HEAT.get(r["highway"], 0.0)
            if th:
                for rs, cs, mask in geo.line_mask(xy, r["width_m"] / 2 + 15):
                    sub = traffic[rs, cs]
                    sub[mask] = np.maximum(sub[mask], th)

        height = np.zeros((R, C))
        building = np.zeros((R, C), dtype=bool)
        for b in self.data["buildings"]:
            m = geo.polygon_mask([geo.to_xy(*p) for p in b["ring"]])
            if m:
                rs, cs, mask = m
                sub = height[rs, cs]
                sub[mask] = np.maximum(sub[mask], b["height_m"])
                building[rs, cs] |= mask
        surface[building] = SURFACES["roof"][0]

        # Street trees are seeded beside road centrelines with only a 1-3 m offset
        # (osm_ingest), and that seeding only checked building footprints -- never the
        # carriageway -- so trunks ended up standing in the road.
        #
        # The test is geometric, against the true carriageway half-width, NOT against
        # road_mask: that mask is inflated to a 10 m minimum (line_mask floors the
        # half-width at half a cell) so every 3 m service lane rasterises 10 m wide, and
        # testing against it rejected 54% of the zone's trees -- including every tree
        # correctly standing on a verge.
        #
        # Only the TRUNK is filtered. Canopy is still free to overhang the road, because
        # that overhang is exactly what shades a street; removing it would delete the
        # cooling effect the whole product exists to show.
        self.trees = [t for t in self.data["trees"] if not self._on_carriageway(t["lat"], t["lon"])]
        self.trees_dropped_on_road = len(self.data["trees"]) - len(self.trees)

        canopy = np.zeros((R, C))
        for t in self.trees:
            x, y = geo.to_xy(t["lat"], t["lon"])
            m = geo.disk_mask(x, y, t["radius_m"] + geo.CELL_M * 0.5)
            if m:
                rs, cs, d = m
                cov = np.clip(1.35 - d / (t["radius_m"] + geo.CELL_M * 0.5), 0, 1) * t["density"]
                sub = canopy[rs, cs]
                np.maximum(sub, np.minimum(1.0, sub + cov), out=sub)
        canopy[building] = 0
        canopy = np.clip(canopy, 0, 0.95)

        self.surface = surface
        self.height = height
        self.building = building
        self.road = road_mask
        self.canopy = canopy
        self.tree_height = np.where(canopy > 0.12, 8.0, 0.0)
        self.traffic = box_blur(traffic, 1)
        # Neighbourhood effects
        self.water_cooling = np.clip(box_blur(water.astype(float), 6) * 3.0, 0, 1)  # ~60 m reach
        self.canopy_cooling = box_blur(canopy, 2)  # ~20 m evapotranspiration reach
        self.built_density = box_blur(building.astype(float), 3)  # urban canyon heat retention
        self.gain = CODE_GAIN[surface]

        self.places = self.data["places"]
        self.pois = self.data["pois"]
        self._svf: np.ndarray | None = None

    @property
    def svf(self) -> np.ndarray:
        """Sky view factor (0 = deep canyon, 1 = open sky), from services.svf.

        Lazy + disk-cached: the horizon scan costs ~10-20 s on a cold boot and is
        independent of time and weather, so it is computed at most once per zone.
        """
        if self._svf is None:
            from .svf import load
            self._svf = load(self.height, self.building)
        return self._svf


    def _on_carriageway(self, lat: float, lon: float) -> bool:
        """True when this point lies within the real carriageway of any road.

        Uses the OSM width, with a 1.2 m half-width floor so zero-width paths still
        register, and a small kerb allowance so trunks are not left overhanging the
        asphalt edge.
        """
        if not hasattr(self, "_seg_index"):
            self._build_seg_index()
        x, y = geo.to_xy(lat, lon)
        cell = int(x // _SEG_BUCKET_M), int(y // _SEG_BUCKET_M)
        for dc in (-1, 0, 1):
            for dr in (-1, 0, 1):
                for ax, ay, bx, by, half in self._seg_index.get((cell[0] + dc, cell[1] + dr), ()):
                    dx, dy = bx - ax, by - ay
                    L2 = dx * dx + dy * dy
                    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / L2))
                    if math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= half:
                        return True
        return False

    def _build_seg_index(self) -> None:
        """Bucket road segments by a coarse grid so the trunk test stays O(1) per tree."""
        idx: dict[tuple[int, int], list] = {}
        for r in self.data["roads"]:
            half = max(r["width_m"] / 2, 1.2) + _KERB_ALLOWANCE_M
            pts = [geo.to_xy(la, lo) for _, la, lo in r["nodes"]]
            for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
                seg = (ax, ay, bx, by, half)
                c0 = int(min(ax, bx) // _SEG_BUCKET_M)
                c1 = int(max(ax, bx) // _SEG_BUCKET_M)
                r0 = int(min(ay, by) // _SEG_BUCKET_M)
                r1 = int(max(ay, by) // _SEG_BUCKET_M)
                for cc in range(c0, c1 + 1):
                    for rr in range(r0, r1 + 1):
                        idx.setdefault((cc, rr), []).append(seg)
        self._seg_index = idx

    # --- GeoJSON exports -------------------------------------------------
    def buildings_geojson(self) -> dict:
        """Footprints + the metadata the 3D facade generator needs.

        `typology` is the render-time building class: taken from the OSM tag when
        there is one, otherwise inferred from geometry and surroundings and
        labelled `typology_source: "inferred"` (see services.building_types).
        `seed` is a stable per-building integer so procedural facade variation is
        deterministic across reloads rather than reshuffling on every render.
        """
        from .building_types import classify_cached
        types = classify_cached(self)
        feats = []
        for b in self.data["buildings"]:
            typology, src = types.get(b["id"], ("residential", "inferred"))
            feats.append({
                "type": "Feature", "id": b["id"],
                "properties": {"name": b["name"], "kind": b["kind"], "height_m": b["height_m"],
                               "height_source": b["height_source"], "area_m2": b["area_m2"],
                               "typology": typology, "typology_source": src,
                               "seed": int(b["osm_id"]) & 0xFFFF},
                "geometry": {"type": "Polygon", "coordinates": [[[lo, la] for la, lo in b["ring"]]]}})
        return {"type": "FeatureCollection", "features": feats}

    def surfaces_geojson(self) -> dict:
        return {"type": "FeatureCollection", "features": [
            {"type": "Feature", "id": s["id"], "properties": {"kind": s["kind"], "name": s["name"]},
             "geometry": {"type": "Polygon", "coordinates": [[[lo, la] for la, lo in s["ring"]]]}}
            for s in self.data["surfaces"]]}

    def roads_geojson(self) -> dict:
        """The real OSM street network, for the 3D renderer to build road ribbons from.

        Carries the width and class the heat model already uses, so the carriageway
        drawn on screen is the same one that carries the traffic-heat term.
        """
        return {"type": "FeatureCollection", "features": [
            {"type": "Feature", "id": r["id"],
             "properties": {"name": r["name"], "highway": r["highway"], "surface": r["surface"],
                            "width_m": r["width_m"], "walkable": r["walkable"], "bikeable": r["bikeable"],
                            "traffic_heat_c": TRAFFIC_HEAT.get(r["highway"], 0.0)},
             "geometry": {"type": "LineString",
                          "coordinates": [[round(lo, 7), round(la, 7)] for _, la, lo in r["nodes"]]}}
            for r in self.data["roads"]]}

    def trees_geojson(self) -> dict:
        return {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"r": t["radius_m"], "d": t["density"], "src": t["source"]},
             "geometry": {"type": "Point", "coordinates": [t["lon"], t["lat"]]}} for t in self.trees]}


@lru_cache(maxsize=1)
def get_zone() -> Zone:
    return Zone()
