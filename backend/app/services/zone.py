"""Loads the zone dataset and rasterises it into the static layers of the digital twin."""
from __future__ import annotations

import json
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

        canopy = np.zeros((R, C))
        for t in self.data["trees"]:
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

    # --- GeoJSON exports -------------------------------------------------
    def buildings_geojson(self) -> dict:
        return {"type": "FeatureCollection", "features": [
            {"type": "Feature", "id": b["id"],
             "properties": {"name": b["name"], "kind": b["kind"], "height_m": b["height_m"],
                            "height_source": b["height_source"]},
             "geometry": {"type": "Polygon", "coordinates": [[[lo, la] for la, lo in b["ring"]]]}}
            for b in self.data["buildings"]]}

    def surfaces_geojson(self) -> dict:
        return {"type": "FeatureCollection", "features": [
            {"type": "Feature", "id": s["id"], "properties": {"kind": s["kind"], "name": s["name"]},
             "geometry": {"type": "Polygon", "coordinates": [[[lo, la] for la, lo in s["ring"]]]}}
            for s in self.data["surfaces"]]}

    def trees_geojson(self) -> dict:
        return {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"r": t["radius_m"], "d": t["density"], "src": t["source"]},
             "geometry": {"type": "Point", "coordinates": [t["lon"], t["lat"]]}} for t in self.data["trees"]]}


@lru_cache(maxsize=1)
def get_zone() -> Zone:
    return Zone()
