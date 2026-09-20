"""Future Heat Prediction — physics-informed nowcast for +30 m / +1 h / +2 h (PRD §10.3).

Sun-angle progression re-runs the Shadow Engine for each horizon; ambient air
temperature/humidity are interpolated from the hourly forecast (Open-Meteo) or
the demo scenario curve. Phase 2 replaces the ambient step with a model trained
on historical LST + weather series.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import numpy as np

from .heat_twin_service import get_twin

HORIZONS = {"now": 0, "30m": 30, "1h": 60, "2h": 120, "3h": 180}
TIMELINE_OFFSETS = list(range(0, 181, 15))  # Now → +3h, every 15 min


def parse_horizon(h: str) -> int:
    if h in HORIZONS:
        return HORIZONS[h]
    h = h.strip().lower().lstrip("+")
    if h.endswith("m"):
        return int(h[:-1])
    if h.endswith("h"):
        return int(float(h[:-1]) * 60)
    return int(h)


def predict(base: datetime, horizon_min: int, scenario: str, temp_delta: float = 0.0) -> dict:
    twin = get_twin()
    f0 = twin.frame(base, scenario, temp_delta)
    f1 = twin.frame(base + timedelta(minutes=horizon_min), scenario, temp_delta)
    delta = f1.feels - f0.feels
    wk = twin.walkable
    return {
        "horizon_min": horizon_min,
        "from": twin.describe(f0),
        "to": twin.describe(f1),
        "change": {
            "mean_delta_c": round(float(delta[wk].mean()), 2),
            "pct_warming": round(float((delta[wk] > 0.5).mean() * 100), 1),
            "pct_cooling": round(float((delta[wk] < -0.5).mean() * 100), 1),
            "shade_change_pct": round(f1.stats["pct_shaded"] - f0.stats["pct_shaded"], 1),
            "max_warming_c": round(float(np.percentile(delta[wk], 99)), 1),
            "max_cooling_c": round(float(np.percentile(delta[wk], 1)), 1),
        },
        "method": "physics_informed_nowcast",
    }
