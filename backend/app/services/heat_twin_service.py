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

from ..config import (CANYON_K_DENSITY, CANYON_K_SVF, CENTER, HIGH_HEAT_C, USE_SVF_CANYON)
from . import geo
from .anthropogenic import anthropogenic_field
from .shadow_engine import sun_exposure
from .solar import solar_position
from .weather import Weather, weather_service
from .zone import Zone, get_zone

INTERVENTIONS = {
    "trees": {
        "label": "Plant tree canopy",
        "note": "Simulated as +canopy shade and evapotranspiration cooling in a ~20 m radius "
                "(one to two mature trees' worth of canopy).",
    },
    "cool_pavement": {
        "label": "Apply cool / reflective pavement",
        "note": "Simulated as a lower solar-gain coefficient on road surface within the radius, "
                "consistent with published cool-pavement surface-temperature reductions.",
    },
    "shade_structure": {
        "label": "Install a shade structure",
        "note": "Simulated as near-total sun-exposure blocking in a tight radius — a shade sail, "
                "canopy or bus-stop-style structure at this exact spot.",
    },
}


def canyon_term(z: Zone, rs=None, cs=None) -> np.ndarray:
    """Long-wave heat trapped between buildings.

    Default: a box-blurred built-density proxy (the original hand-tuned model).
    With HEATMIND_SVF_CANYON=1: (1 - sky view factor), the standard urban-canyon
    geometry term, which concentrates trapping in genuinely enclosed streets
    instead of smearing it over every built-up neighbourhood.
    """
    if USE_SVF_CANYON:
        svf = z.svf if rs is None else z.svf[rs, cs]
        return CANYON_K_SVF * (1.0 - svf)
    dens = z.built_density if rs is None else z.built_density[rs, cs]
    return CANYON_K_DENSITY * dens


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


# Per-frame memory budget. A frame holds four float32 grids plus one bool mask,
# so it costs ~17 bytes per cell. The cache size is derived from that rather than
# fixed, because the zone bbox is configurable: at the 4 km2 campus a frame is
# ~0.7 MB and 80 frames cost 54 MB, but over 42 km2 of south Pune the same 80
# frames would need 570 MB. The budget keeps the cache useful at either size.
FRAME_CACHE_BUDGET_BYTES = 256 * 1024 * 1024
BYTES_PER_CELL_PER_FRAME = 17


def _max_cached_frames(cells: int) -> int:
    """How many frames fit the budget at this grid size (at least one timeline)."""
    return max(14, min(80, FRAME_CACHE_BUDGET_BYTES // (cells * BYTES_PER_CELL_PER_FRAME)))


@dataclass
class Frame:
    when: datetime
    scenario: str
    temp_delta: float
    weather: Weather
    elev: float
    az: float
    intensity: float
    # float32 throughout: these grids are cached in bulk and the model's own
    # precision is nowhere near float64, so the second 4 bytes buy nothing.
    exposure: np.ndarray
    building_shadow: np.ndarray  # bool mask, not a float field
    t_surface: np.ndarray
    feels: np.ndarray
    anthro: np.ndarray
    # Fraction of clear-sky irradiance reaching the ground, and whether that came
    # from a measurement or from the cloud-cover model.
    clearness: float = 1.0
    clearness_source: str = "modelled_from_cloud"
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
        self._max_frames = _max_cached_frames(z.shape[0] * z.shape[1])
        self._road_names = self._road_name_grid()
        self._places = self._place_grid()

    def _road_name_grid(self) -> tuple[np.ndarray, list[str]]:
        """Named road nodes as (cells, names), for a vectorised nearest lookup.

        This used to be a dict scanned linearly on every call. Over the campus that
        was a few thousand entries; across 42 km2 of south Pune it is ~130k, and the
        scan runs twice per frame for the hottest/coolest labels plus once per point
        probe. Held as an (N, 2) array so the search is one numpy argmin.
        """
        cells: list[tuple[int, int]] = []
        names: list[str] = []
        seen: dict[tuple[int, int], int] = {}
        for r in self.zone.data["roads"]:
            if not r["name"]:
                continue
            for _, la, lo in r["nodes"]:
                cell = geo.latlon_to_cell(la, lo)
                if cell in seen:
                    names[seen[cell]] = r["name"]
                    continue
                seen[cell] = len(names)
                cells.append(cell)
                names.append(r["name"])
        arr = np.array(cells, dtype=np.int32) if cells else np.zeros((0, 2), dtype=np.int32)
        return arr, names

    def _place_grid(self) -> tuple[np.ndarray, list[str]]:
        cells = [geo.latlon_to_cell(p["lat"], p["lon"]) for p in self.zone.places]
        arr = np.array(cells, dtype=np.int32) if cells else np.zeros((0, 2), dtype=np.int32)
        return arr, [p["name"] for p in self.zone.places]

    def nearest_name(self, r: int, c: int) -> str:
        best, bd = "", float("inf")
        cells, names = self._road_names
        if len(cells):
            d2 = (cells[:, 0] - r) ** 2 + (cells[:, 1] - c) ** 2
            i = int(np.argmin(d2))
            best, bd = names[i], float(d2[i])

        pcells, pnames = self._places
        if len(pcells):
            d2 = (pcells[:, 0] - r) ** 2 + (pcells[:, 1] - c) ** 2
            i = int(np.argmin(d2))
            # a named place only wins if it is clearly closer than the nearest street
            if float(d2[i]) < bd * 0.8:
                best = "near " + pnames[i]
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
            while len(self._cache) > self._max_frames:
                self._cache.popitem(last=False)
        return f

    def _compute(self, when: datetime, scenario: str, temp_delta: float) -> Frame:
        z = self.zone
        w = weather_service.at(when, scenario, temp_delta)
        elev, az = solar_position(when, *CENTER)
        # Clearness comes from measured shortwave irradiance where the provider gives
        # one, and only falls back to the cloud-cover model where it does not. Cloud
        # fraction carries no optical depth, so a hazy Pune afternoon that a satellite
        # scores as clear can still be losing a third of its surface irradiance --
        # which is a third of the direct beam the twin puts on a pedestrian's body.
        # Normalising against clear-sky GHI keeps intensity on exactly the 0..1 scale
        # the gain and solar-load coefficients below were calibrated against.
        clearness, clearness_source = w.clearness(elev)
        intensity = clearness * max(0.0, math.sin(math.radians(elev))) ** 1.15 if elev > 0 else 0.0
        exposure, bshadow, _tree_occ = sun_exposure(z, elev, az)  # tree occlusion is folded into exposure

        storage = np.where(np.isin(z.surface, (1, 2, 6)), z.gain * 0.09, 0.0)  # thermal mass after sunset
        t_surf = w.air_c + z.gain * intensity * (0.25 + 0.75 * exposure) + storage * (1 - intensity)
        t_surf = np.where(z.surface == 5, w.air_c - 2.0, t_surf)

        # Feels-like = NOAA heat index of the ambient air + street-level radiant/convective adjustments
        hi_air = float(heat_index_c(w.air_c, w.rh))
        solar_load = 5.6 * intensity * exposure  # direct beam on the body (mean-radiant-temperature proxy)
        ground_rad = 0.15 * (t_surf - w.air_c)  # long-wave from hot ground
        canyon = canyon_term(z)  # heat trapped between buildings
        # Waste heat people put into the street: congestion-scaled traffic + industrial
        # duty cycle. Replaces the old constant per-road-class weight.
        anthro = anthropogenic_field(z, when)
        cooling = 2.2 * z.canopy_cooling + 2.4 * z.water_cooling + 0.35 * max(0.0, w.wind_ms - 1.0)
        feels = hi_air + solar_load + ground_rad + anthro + canyon - cooling

        f = Frame(when, scenario, temp_delta, w, elev, az, intensity,
                  exposure.astype(np.float32), bshadow.astype(bool),
                  t_surf.astype(np.float32), feels.astype(np.float32), anthro.astype(np.float32),
                  clearness=clearness, clearness_source=clearness_source)
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
                    "intensity": round(f.intensity, 2), "is_day": f.elev > 0,
                    "clearness": round(f.clearness, 3),
                    "clearness_source": f.clearness_source},
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
            "building_shadow": bool(f.building_shadow[r, c]), "canopy": round(float(z.canopy[r, c]), 2),
            "surface": CODE_LABEL[int(z.surface[r, c])], "traffic_heat_c": round(float(f.anthro[r, c]), 1),
            "near": self.nearest_name(r, c),
        }

    # --- Intervention simulator (SDG 13 / 15) ---------------------------
    # "What if we planted trees / cool-paved / shaded this spot?" — reuses the
    # exact _compute() formula on a small locally-patched neighbourhood, so the
    # answer stays physically consistent with the rest of the twin instead of
    # being a separate guess. Shade-structure/tree shading is approximated as a
    # direct reduction of sun_exposure rather than a full shadow re-raymarch
    # (cheap enough for an interactive click, and honestly labelled as such by
    # the API description below / the frontend copy).
    def simulate_intervention(self, f: Frame, lat: float, lon: float, kind: str, radius_m: float = 20.0) -> dict:
        if kind not in INTERVENTIONS:
            raise ValueError(f"unknown intervention kind: {kind}")
        z = self.zone
        x, y = geo.to_xy(lat, lon)
        m = geo.disk_mask(x, y, radius_m)
        if m is None:
            raise ValueError("point is outside the zone")
        rs, cs, d = m
        wk = self.walkable[rs, cs] & ~z.building[rs, cs]
        if not wk.any():
            raise ValueError("no walkable ground within radius of this point")

        weight = np.clip(1 - d / radius_m, 0.0, 1.0)
        exposure = f.exposure[rs, cs].copy()
        gain = z.gain[rs, cs].copy()
        canopy_cooling = z.canopy_cooling[rs, cs].copy()

        if kind == "trees":
            exposure *= (1 - 0.55 * weight)
            canopy_cooling = np.clip(canopy_cooling + 0.6 * weight, 0, 1.5)
        elif kind == "cool_pavement":
            road_w = weight * z.road[rs, cs]
            gain = gain - (gain - 8.0) * road_w  # reflective coating -> lower surface gain
        elif kind == "shade_structure":
            exposure *= (1 - 0.85 * weight)

        storage = np.where(np.isin(z.surface[rs, cs], (1, 2, 6)), gain * 0.09, 0.0)
        t_surf = f.weather.air_c + gain * f.intensity * (0.25 + 0.75 * exposure) + storage * (1 - f.intensity)
        t_surf = np.where(z.surface[rs, cs] == 5, f.weather.air_c - 2.0, t_surf)

        hi_air = float(heat_index_c(f.weather.air_c, f.weather.rh))
        solar_load = 5.6 * f.intensity * exposure
        ground_rad = 0.15 * (t_surf - f.weather.air_c)
        canyon = canyon_term(z, rs, cs)
        cooling = 2.2 * canopy_cooling + 2.4 * z.water_cooling[rs, cs] + 0.35 * max(0.0, f.weather.wind_ms - 1.0)
        feels_after = hi_air + solar_load + ground_rad + f.anthro[rs, cs] + canyon - cooling

        before = f.feels[rs, cs]
        before_mean = float(before[wk].mean())
        after_mean = float(feels_after[wk].mean())
        before_shade = float((f.exposure[rs, cs][wk] < 0.35).mean() * 100)
        after_shade = float((exposure[wk] < 0.35).mean() * 100)

        return {
            "kind": kind, "label": INTERVENTIONS[kind]["label"], "note": INTERVENTIONS[kind]["note"],
            "center": {"lat": lat, "lon": lon}, "radius_m": radius_m,
            "before": {"feels_c": round(before_mean, 1), "shaded_pct": round(before_shade, 1)},
            "after": {"feels_c": round(after_mean, 1), "shaded_pct": round(after_shade, 1)},
            "delta_c": round(after_mean - before_mean, 1),
            "delta_shaded_pct": round(after_shade - before_shade, 1),
            "cells_affected": int(wk.sum()),
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
