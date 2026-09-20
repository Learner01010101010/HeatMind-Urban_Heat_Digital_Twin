"""Urban Heat Digital Twin — a per-cell (10 m) pedestrian feels-like heat surface.

Physics-informed synthetic model (disclosed in the UI, PRD §9):
  T_surface = T_air + gain(surface) · I · sun_exposure  (+ stored heat in thermal mass)
  feels     = NOAA heat index(T_air, RH) + solar body load + ground radiant + traffic
              + canyon − canopy evapotranspiration − lake cooling − wind
"""
from __future__ import annotations

import base64
import math
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np

from ..config import CENTER, HIGH_HEAT_C
from . import geo
from .shadow_engine import sun_exposure
from .solar import solar_position
from .weather import Weather, weather_service
from .zone import Zone, get_zone


def heat_index_c(t_c: np.ndarray | float, rh: float) -> np.ndarray:
    """NOAA / Rothfusz heat index, vectorised, °C in/out."""
    T = np.asarray(t_c, dtype=float) * 9 / 5 + 32
    simple = 0.5 * (T + 61.0 + (T - 68.0) * 1.2 + rh * 0.094)
    full = (-42.379 + 2.04901523 * T + 10.14333127 * rh - 0.22475541 * T * rh - 0.00683783 * T * T
            - 0.05481717 * rh * rh + 0.00122874 * T * T * rh + 0.00085282 * T * rh * rh
            - 0.00000199 * T * T * rh * rh)
    if rh < 13:
        adj = ((13 - rh) / 4) * np.sqrt(np.clip((17 - np.abs(T - 95.0)) / 17, 0, None))
        full = full - np.where((T >= 80) & (T <= 112), adj, 0)
    elif rh > 85:
        full = full + np.where((T >= 80) & (T <= 87), ((rh - 85) / 10) * ((87 - T) / 5), 0)
    hi = np.where((simple + T) / 2 < 80, simple, full)
    # Heat index never reads much below the dry-bulb in hot, dry air for pedestrians in sun.
    hi = np.maximum(hi, T - 2.0)
    return (hi - 32) * 5 / 9


@dataclass
class Frame:
    when: datetime
    scenario: str
    temp_delta: float
    weather: Weather
    elev: float
    az: float
    intensity: float
    exposure: np.ndarray
    building_shadow: np.ndarray
    tree_occ: np.ndarray
    t_surface: np.ndarray
    feels: np.ndarray
    stats: dict = field(default_factory=dict)

    def encode(self) -> dict:
        heat = np.clip((self.feels - 20.0) * 4.0, 0, 255).astype(np.uint8)
        shade = np.clip(self.exposure * 255, 0, 255).astype(np.uint8)
        return {
            "rows": geo.ROWS, "cols": geo.COLS, "cell_m": geo.CELL_M,
            "bbox": [geo.S, geo.W, geo.N, geo.E],
            "encoding": {"heat": "uint8 base64, feels_c = 20 + v/4", "shade": "uint8 base64, sun_exposure = v/255"},
            "heat_b64": base64.b64encode(heat.tobytes()).decode(),
            "shade_b64": base64.b64encode(shade.tobytes()).decode(),
        }


class HeatTwin:
    def __init__(self) -> None:
        self.zone: Zone = get_zone()
        self._cache: OrderedDict[tuple, Frame] = OrderedDict()
        self._lock = threading.Lock()
        z = self.zone
        self.walkable = ~z.building
        self._road_names = self._road_name_grid()

    def _road_name_grid(self) -> dict:
        names = {}
        for r in self.zone.data["roads"]:
            if not r["name"]:
                continue
            for _, la, lo in r["nodes"]:
                names[geo.latlon_to_cell(la, lo)] = r["name"]
        return names

    def nearest_name(self, r: int, c: int) -> str:
        best, bd = "", 1e9
        for (rr, cc), n in self._road_names.items():
            d = (rr - r) ** 2 + (cc - c) ** 2
            if d < bd:
                best, bd = n, d
        for p in self.zone.places:
            pr, pc = geo.latlon_to_cell(p["lat"], p["lon"])
            d = (pr - r) ** 2 + (pc - c) ** 2
            if d < bd * 0.8:
                best, bd = "near " + p["name"], d
        return best or "open ground"

    def frame(self, when: datetime, scenario: str = "live", temp_delta: float = 0.0) -> Frame:
        key = (scenario, when.replace(second=0, microsecond=0).isoformat(), round(temp_delta * 2) / 2)
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
        f = self._compute(when, scenario, temp_delta)
        with self._lock:
            self._cache[key] = f
            while len(self._cache) > 80:
                self._cache.popitem(last=False)
        return f

    def _compute(self, when: datetime, scenario: str, temp_delta: float) -> Frame:
        z = self.zone
        w = weather_service.at(when, scenario, temp_delta)
        elev, az = solar_position(when, *CENTER)
        clearness = 1 - 0.75 * (w.cloud / 100) ** 3.4
        intensity = clearness * max(0.0, math.sin(math.radians(elev))) ** 1.15 if elev > 0 else 0.0
        exposure, bshadow, tocc = sun_exposure(z, elev, az)

        storage = np.where(np.isin(z.surface, (1, 2, 6)), z.gain * 0.09, 0.0)  # thermal mass after sunset
        t_surf = w.air_c + z.gain * intensity * (0.25 + 0.75 * exposure) + storage * (1 - intensity)
        t_surf = np.where(z.surface == 5, w.air_c - 2.0, t_surf)

        # Feels-like = NOAA heat index of the ambient air + street-level radiant/convective adjustments
        hi_air = float(heat_index_c(w.air_c, w.rh))
        solar_load = 5.6 * intensity * exposure  # direct beam on the body (mean-radiant-temperature proxy)
        ground_rad = 0.15 * (t_surf - w.air_c)  # long-wave from hot ground
        canyon = 1.2 * z.built_density  # heat trapped between buildings
        cooling = 2.2 * z.canopy_cooling + 2.4 * z.water_cooling + 0.35 * max(0.0, w.wind_ms - 1.0)
        feels = hi_air + solar_load + ground_rad + z.traffic + canyon - cooling

        f = Frame(when, scenario, temp_delta, w, elev, az, intensity, exposure, bshadow, tocc, t_surf, feels)
        f.stats = self._stats(f)
        return f

    def _stats(self, f: Frame) -> dict:
        v = f.feels[self.walkable]
        sm = np.where(self.walkable, f.feels, np.nan)
        # hottest / coolest street-level spots (on roads)
        road = self.zone.road & self.walkable
        rv = np.where(road, f.feels, np.nan)
        hr, hc = np.unravel_index(np.nanargmax(rv), rv.shape)
        cr, cc = np.unravel_index(np.nanargmin(np.where(road, sm, np.nan)), rv.shape)

        def spot(r, c):
            la, lo = geo.to_latlon((c + 0.5) * geo.CELL_M, geo.HEIGHT_M - (r + 0.5) * geo.CELL_M)
            return {"lat": round(la, 6), "lon": round(lo, 6), "feels_c": round(float(f.feels[r, c]), 1),
                    "sun_exposure": round(float(f.exposure[r, c]), 2), "label": self.nearest_name(r, c)}

        shaded = float(((f.exposure < 0.35) & self.walkable).sum() / self.walkable.sum()) if f.intensity > 0 else 1.0
        return {
            "city_level_c": round(f.weather.air_c, 1),
            "city_level_feels_c": round(float(heat_index_c(f.weather.air_c, f.weather.rh)), 1),
            "street_min_c": round(float(np.percentile(v, 1)), 1),
            "street_max_c": round(float(np.percentile(v, 99)), 1),
            "street_mean_c": round(float(v.mean()), 1),
            "street_spread_c": round(float(np.percentile(v, 99) - np.percentile(v, 1)), 1),
            "pct_above_high": round(float((v >= HIGH_HEAT_C).mean() * 100), 1),
            "pct_shaded": round(shaded * 100, 1),
            "hottest": spot(hr, hc),
            "coolest": spot(cr, cc),
        }

    def describe(self, f: Frame) -> dict:
        return {
            "time": f.when.isoformat(), "scenario": f.scenario, "temp_delta_c": f.temp_delta,
            "weather": f.weather.as_dict(),
            "sun": {"elevation_deg": round(f.elev, 1), "azimuth_deg": round(f.az, 1),
                    "intensity": round(f.intensity, 2), "is_day": f.elev > 0},
            "stats": f.stats,
        }

    def sample(self, f: Frame, lat: float, lon: float) -> dict:
        r, c = geo.latlon_to_cell(lat, lon)
        z = self.zone
        from .zone import CODE_LABEL
        return {
            "lat": lat, "lon": lon, "feels_c": round(float(f.feels[r, c]), 1),
            "surface_c": round(float(f.t_surface[r, c]), 1), "air_c": round(f.weather.air_c, 1),
            "sun_exposure": round(float(f.exposure[r, c]), 2),
            "building_shadow": bool(f.building_shadow[r, c] > 0.5), "canopy": round(float(z.canopy[r, c]), 2),
            "surface": CODE_LABEL[int(z.surface[r, c])], "traffic_heat_c": round(float(z.traffic[r, c]), 1),
            "near": self.nearest_name(r, c),
        }

    def geojson(self, f: Frame, agg: int = 3) -> dict:
        """PRD-compatible GeoJSON heat surface aggregated to ~30 m cells."""
        feats = []
        R, C = f.feels.shape
        for r in range(0, R, agg):
            for c in range(0, C, agg):
                block = f.feels[r:r + agg, c:c + agg]
                wk = self.walkable[r:r + agg, c:c + agg]
                if not wk.any():
                    continue
                val = float(block[wk].mean())
                x0, x1 = c * geo.CELL_M, min((c + agg), C) * geo.CELL_M
                y1, y0 = geo.HEIGHT_M - r * geo.CELL_M, geo.HEIGHT_M - min(r + agg, R) * geo.CELL_M
                (la0, lo0), (la1, lo1) = geo.to_latlon(x0, y0), geo.to_latlon(x1, y1)
                feats.append({"type": "Feature", "properties": {"feels_c": round(val, 1)},
                              "geometry": {"type": "Polygon", "coordinates": [[
                                  [round(lo0, 6), round(la0, 6)], [round(lo1, 6), round(la0, 6)],
                                  [round(lo1, 6), round(la1, 6)], [round(lo0, 6), round(la1, 6)],
                                  [round(lo0, 6), round(la0, 6)]]]}})
        return {"type": "FeatureCollection", "features": feats}


_twin: HeatTwin | None = None


def get_twin() -> HeatTwin:
    global _twin
    if _twin is None:
        _twin = HeatTwin()
    return _twin


def twin_layers(f: Frame, graph) -> dict:
    """Heat Twin mode overlays: street-level cooling corridors + heat hotspots for one frame."""
    tw = get_twin()
    pv = graph.piece_values(f, shady_side=True)
    E = len(graph.eu)
    lens = np.bincount(graph.p_edge, weights=graph.p_len, minlength=E)
    feels_e = np.bincount(graph.p_edge, weights=graph.p_len * pv["feels"], minlength=E) / np.maximum(lens, 1e-6)
    expo_e = np.bincount(graph.p_edge, weights=graph.p_len * pv["exposure"], minlength=E) / np.maximum(lens, 1e-6)
    cool_t = float(np.percentile(feels_e, 22))
    hot_t = float(np.percentile(feels_e, 88))
    feats = []
    for e in range(E):
        cls = "cool" if feels_e[e] <= cool_t else "hot" if feels_e[e] >= hot_t else "mid"
        if cls == "mid":
            continue
        a, b = graph.node_ll[graph.eu[e]], graph.node_ll[graph.ev[e]]
        feats.append({"type": "Feature",
                      "properties": {"feels": round(float(feels_e[e]), 1), "shade": round(1 - float(expo_e[e]), 2), "cls": cls},
                      "geometry": {"type": "LineString", "coordinates": [[round(a[1], 6), round(a[0], 6)], [round(b[1], 6), round(b[0], 6)]]}})

    # Hotspots: hottest walkable cells, thinned, weighted for a heatmap layer
    v = np.where(tw.walkable, f.feels, np.nan)
    thr = float(np.nanpercentile(v, 90))
    rr, cc = np.where(v >= thr)
    lo, hi = thr, float(np.nanmax(v))
    pts = []
    for r, c in zip(rr[::2], cc[::2]):
        la, lo_ = geo.to_latlon((c + 0.5) * geo.CELL_M, geo.HEIGHT_M - (r + 0.5) * geo.CELL_M)
        w = (float(f.feels[r, c]) - lo) / max(hi - lo, 0.1)
        pts.append({"type": "Feature", "properties": {"w": round(0.25 + 0.75 * w, 2)},
                    "geometry": {"type": "Point", "coordinates": [round(lo_, 6), round(la, 6)]}})
    return {
        "corridors": {"type": "FeatureCollection", "features": feats},
        "hotspots": {"type": "FeatureCollection", "features": pts},
        "thresholds": {"cool_c": round(cool_t, 1), "hot_c": round(hot_t, 1)},
        "sun": {"elevation_deg": round(f.elev, 1), "azimuth_deg": round(f.az, 1)},
    }
