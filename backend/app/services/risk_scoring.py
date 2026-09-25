"""Personalized Heat Risk Engine — transparent, persona-weighted 0–100 score (PRD §10)."""
from __future__ import annotations

import math

import numpy as np

# NOAA heat-index bands (°C): caution 27, extreme caution 32, danger 39, extreme danger 52
CAUTION_C = 32.0
DANGER_C = 39.0
EXTREME_C = 52.0

LEVEL = {"Low": 0.25, "Medium": 0.5, "High": 0.8, "Very High": 1.0}

FACTORS = [
    ("duration", "Cumulative exposure duration"),
    ("peak", "Peak instantaneous heat index"),
    ("shade", "Shade availability"),
    ("exertion", "Exertion / pace multiplier"),
    ("rest", "Rest / water point proximity"),
    ("surface", "Road surface radiant heat"),
]

PERSONAS = {
    "student": {
        "label": "Student", "speed_ms": 1.35, "pace_factor": 0.55, "vulnerability_shift_c": 0.0,
        "daily_budget_min": 45, "walks_shady_side": True,
        "weights": {"duration": "High", "peak": "Medium", "shade": "Medium", "exertion": "Low", "rest": "Low",
                    "surface": "Low"},
    },
    "worker": {
        "label": "Outdoor Worker", "speed_ms": 1.25, "pace_factor": 1.0, "vulnerability_shift_c": 1.0,
        "daily_budget_min": 90, "walks_shady_side": True,
        "weights": {"duration": "Very High", "peak": "High", "shade": "High", "exertion": "High", "rest": "High",
                    "surface": "Medium"},
    },
    "senior": {
        "label": "Senior Resident", "speed_ms": 0.95, "pace_factor": 0.7, "vulnerability_shift_c": 2.5,
        "daily_budget_min": 20, "walks_shady_side": True,
        "weights": {"duration": "High", "peak": "Very High", "shade": "High", "exertion": "Low", "rest": "Very High",
                    "surface": "Low"},
    },
    "cyclist": {
        "label": "Cyclist", "speed_ms": 4.2, "pace_factor": 0.8, "vulnerability_shift_c": -1.0,
        "daily_budget_min": 40, "walks_shady_side": False,
        "weights": {"duration": "Medium", "peak": "Medium", "shade": "Low", "exertion": "Medium", "rest": "Low",
                    "surface": "High"},
    },
    "gig_worker": {
        # SDG 10 — Pune's large delivery-rider workforce: full shifts outside, on a two-wheeler,
        # with pay tied to trip count rather than rest. Rest-break compliance is tracked
        # separately (see passport_service.rest_compliance) against a NIOSH-style interval.
        "label": "Delivery Rider", "speed_ms": 6.5, "pace_factor": 1.0, "vulnerability_shift_c": 0.5,
        "daily_budget_min": 60, "walks_shady_side": False, "rest_interval_min": 30,
        "weights": {"duration": "Very High", "peak": "High", "shade": "Low", "exertion": "Very High",
                    "rest": "Very High", "surface": "High"},
    },
}


def weights_table() -> dict:
    return {
        "levels": LEVEL,
        "factors": [{"key": k, "label": lbl} for k, lbl in FACTORS],
        "personas": {p: {"label": v["label"], "weights": {k: {"level": lv, "value": LEVEL[lv]} for k, lv in v["weights"].items()},
                         "speed_ms": v["speed_ms"], "vulnerability_shift_c": v["vulnerability_shift_c"],
                         "daily_budget_min": v["daily_budget_min"]} for p, v in PERSONAS.items()},
        "bands": [{"max": 25, "label": "Low"}, {"max": 45, "label": "Moderate"}, {"max": 65, "label": "High"},
                  {"max": 100, "label": "Extreme"}],
        "thresholds_c": {"caution": CAUTION_C, "danger": DANGER_C, "extreme": EXTREME_C},
    }


def band(score: float) -> str:
    return "Low" if score < 25 else "Moderate" if score < 45 else "High" if score < 65 else "Extreme"


def score_route(*, persona: str, seconds: np.ndarray, lengths: np.ndarray, feels: np.ndarray, exposure: np.ndarray,
                surface_excess: np.ndarray, asphalt: np.ndarray, intensity: float, poi_positions_m: list[float],
                total_m: float, speed_ms: float | None = None, mode_exposure: float = 1.0,
                mode_exertion: float = 1.0) -> dict:
    """Score one route from its per-piece arrays (time-weighted aggregation, PRD §10.1 step 3).

    `speed_ms`, `mode_exposure` and `mode_exertion` carry the travel mode. All three
    default to the pedestrian values, so a walking route scores exactly as it did
    before modes existed and the PRD model is unchanged for it.

    What the mode legitimately changes:
      * `speed_ms` — the pace the rest-gap between water points is measured at. A
        1.2 km gap is a 15-minute exposure on foot and under three minutes on a
        two-wheeler.
      * `mode_exposure` — how much of the direct sun reaches the traveller. A sealed
        cabin does not receive the radiant street load a pedestrian does, so scoring
        a car by the sun on the asphalt overstates its risk badly.
      * `mode_exertion` — metabolic load. A driver sitting still is not exerting, and
        the exertion factor is weighted "Very High" for a delivery rider.
    """
    P = PERSONAS[persona]
    mins = seconds / 60.0
    dur = float(mins.sum())
    f_p = feels + P["vulnerability_shift_c"]
    day = min(1.0, intensity * 1.6) if intensity > 0.03 else 0.0

    dose = float((mins * np.clip(f_p - CAUTION_C, 0, None)).sum())  # °C·min above caution
    minutes_danger = float(mins[f_p >= DANGER_C].sum())
    # Shielding acts on the sun that lands on the person, not on the street: the
    # street is as sunlit as it ever was, the traveller is simply under a roof.
    eff_exposure = exposure * mode_exposure
    shaded = (eff_exposure < 0.35) if day > 0 else np.ones_like(exposure, dtype=bool)
    pct_shaded = float((mins * shaded).sum() / max(dur, 1e-6))
    peak = float(np.percentile(f_p, 95))
    mean_f = float((mins * f_p).sum() / max(dur, 1e-6))
    heat_mod = float(np.clip((mean_f - 30) / 16, 0, 1))
    speed = speed_ms if speed_ms is not None else P["speed_ms"]

    stops = sorted([0.0, *poi_positions_m, total_m])
    max_gap_m = max((b - a for a, b in zip(stops[:-1], stops[1:])), default=total_m)
    max_gap_min = max_gap_m / speed / 60
    surf = float((mins * surface_excess).sum() / max(dur, 1e-6))

    raw = {
        "duration": 1 - math.exp(-dose / 220.0),
        "peak": float(np.clip((peak - 34.0) / 20.0, 0, 1)),
        "shade": (1 - pct_shaded) * day,
        "exertion": P["pace_factor"] * mode_exertion * min(1.0, dur / 35.0) * heat_mod,
        "rest": float(np.clip(max_gap_min / 12.0, 0, 1)) * heat_mod,
        "surface": float(np.clip(surf / 18.0, 0, 1)) * mode_exposure,
    }
    w = {k: LEVEL[lv] for k, lv in P["weights"].items()}
    wsum = sum(w.values())
    contrib = {k: w[k] * raw[k] / wsum * 100 for k in raw}
    score = float(sum(contrib.values()))

    factors = [{
        "key": k, "label": lbl, "raw": round(raw[k], 3), "weight": w[k], "weight_level": P["weights"][k],
        "contribution": round(contrib[k], 1),
    } for k, lbl in FACTORS]

    metrics = {
        "duration_min": round(dur, 1), "distance_m": round(float(lengths.sum())),
        "heat_dose": round(dose, 1), "minutes_danger": round(minutes_danger, 1),
        "pct_shaded": round(pct_shaded * 100, 1), "peak_feels_c": round(peak - P["vulnerability_shift_c"], 1),
        "mean_feels_c": round(mean_f - P["vulnerability_shift_c"], 1),
        "pct_asphalt": round(float((mins * asphalt).sum() / max(dur, 1e-6)) * 100, 1),
        "max_gap_min": round(max_gap_min, 1), "surface_excess_c": round(surf, 1),
    }
    return {"score": round(score, 1), "band": band(score), "factors": factors, "metrics": metrics}
