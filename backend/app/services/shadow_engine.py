"""AI Shadow Engine — physically grounded shade from solar geometry.

Two complementary outputs:
  1. A raster sun-exposure mask (0 = full shade, 1 = full sun) computed by marching a
     ray from every twin cell toward the sun through the building-height and
     tree-canopy fields.  This is what the heat model and risk engine consume.
  2. Building shadow polygons (PRD §10.4: shadow_length = h / tan(elev),
     direction = azimuth + 180°) for crisp map rendering.
"""
from __future__ import annotations

import math

import numpy as np

from . import geo
from .zone import Zone

PEDESTRIAN_HEAD_M = 1.6
MAX_SHADOW_M = 350.0


def sun_exposure(zone: Zone, elev: float, az: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (exposure, building_shadow, tree_occlusion) grids."""
    R, C = zone.shape
    if elev <= 0.5:
        zeros = np.zeros((R, C))
        return zeros, np.ones((R, C)), zeros
    tan_e = math.tan(math.radians(elev))
    dx, dy = math.sin(math.radians(az)), math.cos(math.radians(az))
    step = geo.CELL_M / 2
    max_d = min(MAX_SHADOW_M, max(zone.height.max(), 8.0) / tan_e)
    n = int(max_d / step) + 1

    rows, cols = np.indices((R, C))
    base = np.where(zone.building, zone.height, 0.0) + PEDESTRIAN_HEAD_M
    shadow = np.zeros((R, C), dtype=bool)
    tree_occ = zone.canopy.copy()  # canopy directly overhead
    for k in range(1, n + 1):
        d = k * step
        ri = np.rint(rows - dy * d / geo.CELL_M).astype(np.int32)
        ci = np.rint(cols + dx * d / geo.CELL_M).astype(np.int32)
        ok = (ri >= 0) & (ri < R) & (ci >= 0) & (ci < C)
        ri = np.clip(ri, 0, R - 1)
        ci = np.clip(ci, 0, C - 1)
        ray_h = base + d * tan_e
        shadow |= ok & (zone.height[ri, ci] > ray_h)
        occ = np.where(ok & (zone.tree_height[ri, ci] > ray_h), zone.canopy[ri, ci], 0.0)
        np.maximum(tree_occ, occ, out=tree_occ)
    exposure = (1.0 - shadow) * (1.0 - tree_occ)
    return exposure, shadow.astype(float), tree_occ


def building_shadow_polygons(zone: Zone, elev: float, az: float, min_height: float = 0.0) -> dict:
    feats = []
    if elev > 0.5:
        L = lambda h: min(MAX_SHADOW_M, h / math.tan(math.radians(elev)))  # noqa: E731
        sx, sy = -math.sin(math.radians(az)), -math.cos(math.radians(az))  # away from the sun
        for b in zone.data["buildings"]:
            if b["height_m"] < min_height:
                continue
            xy = [geo.to_xy(*p) for p in b["ring"]]
            ln = L(b["height_m"])
            moved = [(x + sx * ln, y + sy * ln) for x, y in xy]
            hull = geo.convex_hull(xy + moved)
            if len(hull) < 3:
                continue
            ring = [geo.to_latlon(x, y) for x, y in hull]
            feats.append({"type": "Feature", "properties": {"building": b["id"], "height_m": b["height_m"],
                                                            "length_m": round(ln, 1)},
                          "geometry": {"type": "Polygon",
                                       "coordinates": [[[round(lo, 7), round(la, 7)] for la, lo in ring + ring[:1]]]}})
    return {"type": "FeatureCollection", "features": feats}
