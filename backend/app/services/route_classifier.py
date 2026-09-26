"""Explainable preference index for street routes; lower scores are preferable.

This is a rules classifier, not a trained ML model or an air-quality monitor.
Industrial waste heat is already in feels-like; no degrees are added twice.
"""
from __future__ import annotations

import numpy as np


def usable_stop(p):
    return (p.get("source") == "osm" and p.get("access") not in ("private", "no", "customers")
            and p.get("drinking_water") != "no"
            and p.get("detail") in ("drinking_water", "water_point", "water_dispenser", "bench", "toilets", "shelter"))


def classify(route, *, industrial, traffic_heat, seconds, lengths, traffic, free_seconds):
    m = route["metrics"]
    total_s = max(float(np.sum(seconds)), 1)
    total_m = max(float(np.sum(lengths)), 1)
    mean_ind = float(np.average(industrial, weights=seconds))
    peak_ind = float(np.max(industrial))
    ind_minutes = float(np.sum(seconds[np.asarray(industrial) >= .2]) / 60)
    delay = max(0, (float(np.sum(seconds)) - float(np.sum(free_seconds))) / 60)
    live_pct = float(np.sum(lengths[traffic["live"]]) / total_m * 100)
    valid = np.isfinite(traffic["congestion"])
    congestion = float(np.average(traffic["congestion"][valid], weights=lengths[valid])) if valid.any() else None
    traffic_mean = float(np.average(traffic_heat, weights=seconds))
    pressure = np.where(traffic["live"], np.nan_to_num(traffic["congestion"]), np.clip(traffic_heat / 2, 0, 1))
    pressure_score = float(np.average(pressure, weights=seconds)) * 100
    delay_score = min(100, delay / max(total_s / 60, 1) * 200)
    walking = route.get("mode", "walk") == "walk"
    traffic_score = pressure_score if walking else .6 * pressure_score + .4 * delay_score
    traffic_value = (f"{congestion * 100:.0f}% slowdown" if congestion is not None else f"+{traffic_mean:.2f}°C est.") if walking else f"+{delay:.1f} min"
    stops = [p for p in route["pois_along_route"] if usable_stop(p)]
    factors = [
        {"key": "heat", "label": "Feels-like heat", "value": f"{m['mean_feels_c']:.1f}°C avg", "raw": route["heat_risk_score"], "weight": .55, "source": "Weather + twin model"},
        {"key": "traffic", "label": "Road traffic" if walking else "Traffic delay", "value": traffic_value, "raw": traffic_score, "weight": .15, "source": "Live road speeds; remaining road heat estimated" if live_pct else "Modelled road heat / delay · no live reading"},
        {"key": "shade", "label": "Street shade", "value": f"{m['pct_shaded_street']:.0f}%", "raw": 100 - m["pct_shaded_street"], "weight": .15, "source": "Sun + mapped buildings / canopy"},
        {"key": "industry", "label": "Industrial heat", "value": f"+{mean_ind:.2f}°C avg", "raw": min(100, mean_ind / 2.6 * 100), "weight": .10, "source": "Estimated waste heat; premises may be inferred"},
        {"key": "rest", "label": "Mapped rest / water", "value": f"{len(stops)} nearby", "raw": min(100, m["max_gap_min"] / 30 * 100), "weight": .05, "source": "Public OSM amenities within 45 m; access unverified"},
    ]
    score = round(sum(f["raw"] * f["weight"] for f in factors), 1)
    return {"method": "rule_based", "score": score,
            "rating": "Lower exposure" if score < 30 else "Use precautions" if score < 60 else "High exposure",
            "factors": factors, "reasons": [], "mapped_stops": len(stops),
            "industrial": {"mean_c": round(mean_ind, 3), "peak_c": round(peak_ind, 3), "exposure_min": round(ind_minutes, 1),
                           "heat_dose_c_min": round(float(np.sum(industrial * seconds) / 60), 2),
                           "note": "Modelled waste heat, already included in feels-like. No live industrial emissions or air-pollution readings."},
            "traffic": {"live": live_pct > 0, "coverage_pct": round(live_pct, 1), "delay_min": round(delay, 1),
                        "congestion": round(congestion, 3) if congestion is not None else None,
                        "observed_at": traffic.get("observed_at"), "heat_mean_c": round(traffic_mean, 2),
                        "note": "Road-speed samples matched to nearby parallel streets; not direction-specific. Unobserved roads and forecasts use estimates."},
            "note": "Preference index: heat 55%, traffic 15%, shade 15%, industry 10%, rest access 5%. Traffic uses observed congestion where sampled, estimated road heat elsewhere, and vehicle delay. Lower is better; heat risk remains a separate score."}


def explain_choice(route, fastest):
    c, m, f = route["optimization"], route["metrics"], fastest["metrics"]
    reasons = []
    if route is fastest:
        reasons.append("The quickest option balances exposure and travel time within the available routes.")
    else:
        reasons.append(f"Adds {max(0, m['duration_min'] - f['duration_min']):.1f} min compared with the quickest route.")
    if m["pct_shaded_street"] > f["pct_shaded_street"] + 2:
        reasons.append(f"{m['pct_shaded_street'] - f['pct_shaded_street']:.0f} percentage points more street shade.")
    if route["heat_risk_score"] < fastest["heat_risk_score"] - 1:
        reasons.append(f"Heat-risk score is {fastest['heat_risk_score'] - route['heat_risk_score']:.0f} points lower.")
    if c["mapped_stops"]:
        reasons.append(f"Passes {c['mapped_stops']} mapped rest / water facilities within 45 m; confirm opening and access.")
    else:
        reasons.append("No public rest / water facilities mapped nearby. Carry drinking water.")
    ind = c["industrial"]
    reasons.append(f"Estimated industrial heat adds {ind['mean_c']:.2f}°C on average over this route; {ind['exposure_min']:.1f} min above +0.2°C.")
    c["reasons"] = reasons
