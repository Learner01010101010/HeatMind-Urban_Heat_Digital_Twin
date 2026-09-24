"""Heat Vulnerability Index — SDG 10 (Reduced Inequalities).

IMPORTANT — what this is and isn't: there is no census, income or informal-
settlement dataset for this zone, so this is NOT a demographic equity layer.
It is a composite of three factors already computed elsewhere in the twin:

  1. Heat exposure       — how hot it actually feels here right now
  2. Cooling deficit     — lack of canopy/water cooling (who has shade, who doesn't)
  3. Access deficit      — distance to the nearest water/rest/shade/cooling POI

Areas that are simultaneously hot, unshaded, and far from any cooling
infrastructure surface as "high vulnerability" — a genuine environmental-
justice signal (infrastructure equity), even without population data. In a
real deployment this environmental layer would be combined with an actual
demographic vulnerability layer (age, income, housing type); here it stands
alone and is labelled as such everywhere it's shown.
"""
from __future__ import annotations

import numpy as np

from . import geo
from .heat_twin_service import Frame, get_twin
from .zone import get_zone

POI_SATURATION_M = 400.0  # distance beyond which "access deficit" maxes out
WEIGHTS = {"heat": 0.45, "cooling_deficit": 0.30, "access_deficit": 0.25}


def _poi_distance_grid() -> np.ndarray:
    z = get_zone()
    R, C = geo.ROWS, geo.COLS
    if not z.pois:
        return np.full((R, C), POI_SATURATION_M, dtype=float)
    best = np.full((R, C), np.inf)
    for p in z.pois:
        px, py = geo.to_xy(p["lat"], p["lon"])
        d = np.hypot(geo._CX - px, geo._CY - py)
        np.minimum(best, d, out=best)
    return best


def vulnerability_grid(f: Frame) -> dict:
    z = get_zone()
    tw = get_twin()
    heat = np.clip((f.feels - 30.0) / 15.0, 0, 1)  # 0 at 30 C, 1 at 45 C+
    cooling_deficit = 1 - np.clip(z.canopy_cooling + z.water_cooling, 0, 1)
    access_deficit = np.clip(_poi_distance_grid() / POI_SATURATION_M, 0, 1)
    idx = 100 * (WEIGHTS["heat"] * heat + WEIGHTS["cooling_deficit"] * cooling_deficit + WEIGHTS["access_deficit"] * access_deficit)
    idx = np.where(tw.walkable, idx, np.nan)
    return {"index": idx, "heat": heat, "cooling_deficit": cooling_deficit, "access_deficit": access_deficit}


def equity_geojson(f: Frame, agg: int = 4) -> dict:
    tw = get_twin()
    g = vulnerability_grid(f)
    idx = g["index"]
    feats = []
    R, C = idx.shape
    for r in range(0, R, agg):
        for c in range(0, C, agg):
            block = idx[r:r + agg, c:c + agg]
            wk = tw.walkable[r:r + agg, c:c + agg]
            if not wk.any():
                continue
            val = float(np.nanmean(block[wk]))
            if np.isnan(val):
                continue
            x0, x1 = c * geo.CELL_M, min((c + agg), C) * geo.CELL_M
            y1, y0 = geo.HEIGHT_M - r * geo.CELL_M, geo.HEIGHT_M - min(r + agg, R) * geo.CELL_M
            (la0, lo0), (la1, lo1) = geo.to_latlon(x0, y0), geo.to_latlon(x1, y1)
            feats.append({"type": "Feature", "properties": {"vulnerability": round(val, 1)},
                          "geometry": {"type": "Polygon", "coordinates": [[
                              [round(lo0, 6), round(la0, 6)], [round(lo1, 6), round(la0, 6)],
                              [round(lo1, 6), round(la1, 6)], [round(lo0, 6), round(la1, 6)],
                              [round(lo0, 6), round(la0, 6)]]]}})
    return {"type": "FeatureCollection", "features": feats}


def equity_summary(f: Frame) -> dict:
    g = vulnerability_grid(f)
    idx = g["index"]
    valid = idx[~np.isnan(idx)]
    if valid.size == 0:
        return {"mean": 0.0, "p90": 0.0, "pct_high": 0.0, "weights": WEIGHTS, "n_pois": len(get_zone().pois)}
    return {
        "mean": round(float(valid.mean()), 1),
        "p90": round(float(np.percentile(valid, 90)), 1),
        "pct_high": round(float((valid >= 66).mean() * 100), 1),
        "weights": WEIGHTS,
        "n_pois": len(get_zone().pois),
        "note": "Environmental + infrastructure-access proxy. No demographic data is used — see /about for methodology.",
    }
