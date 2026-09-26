"""Isolated planning and validation tools. Never mutate the twin or route state."""
from __future__ import annotations

import csv
import io
import math
import time
from datetime import datetime, timezone

import numpy as np

from . import geo
from .heat_twin_service import get_twin
from .weather import base_time

AREAS = {
    "narhe": ("Narhe · campus neighbourhood", 18.4427, 73.8318),
    "katraj": ("Katraj · Bharati Vidyapeeth", 18.4537, 73.8563),
    "swargate": ("Swargate · transport hub", 18.5007, 73.8586),
}
KINDS = {
    "trees": {"label": "Mature tree canopy", "cost": 25000, "color": "#8ad8b0"},
    "cool_pavement": {"label": "Cool pavement patch", "cost": 45000, "color": "#a9d7fa"},
    "shade_structure": {"label": "Shade structure", "cost": 60000, "color": "#d0bdfa"},
    "water_refill": {"label": "Proposed water refill", "cost": 30000, "color": "#77d9f5"},
}
METRICS = {"surface_c": "Surface temperature", "air_c": "Air temperature", "feels_c": "Feels-like temperature"}
_catalog_cache = {}


def lab_time(mode):
    now = base_time()
    # A repeatable daytime heatwave demonstration, separate from the live app clock.
    return now.replace(hour=13, minute=30) if mode == "demo" else now.replace(minute=now.minute // 5 * 5)


def catalog(area="narhe", mode="demo"):
    when = lab_time(mode)
    key = area, mode, when.isoformat()
    cached = _catalog_cache.get(key)
    if cached and time.monotonic() - cached[0] < 300:
        return cached[1]
    name, lat, lon = AREAS[area]
    tw = get_twin()
    f = tw.frame(when, mode)
    cx, cy = geo.to_xy(lat, lon)
    roads, candidates, cells = [], [], set()
    for road in tw.zone.data["roads"]:
        points = [[n[1], n[2]] for n in road["nodes"]]
        nearby = [p for p in points if abs(geo.to_xy(*p)[0] - cx) < 520 and abs(geo.to_xy(*p)[1] - cy) < 520]
        if not nearby:
            continue
        roads.append({"name": road["name"], "points": points})
        for p in nearby:
            r, c = geo.latlon_to_cell(*p)
            if (r, c) in cells or not tw.walkable[r, c]:
                continue
            cells.add((r, c))
            candidates.append((float(f.feels[r, c]), p[0], p[1], road["name"] or "Mapped local street"))
    sites = []
    for _, la, lo, street in sorted(candidates, reverse=True):
        # Separate bounding patches as well as the 20 m cooling radii.
        if any(geo.haversine_m((la, lo), (s["lat"], s["lon"])) < 100 for s in sites):
            continue
        choices = {}
        try:
            for kind in KINDS:
                if kind != "water_refill":
                    choices[kind] = tw.simulate_intervention(f, la, lo, kind, 20)
        except ValueError:
            continue
        sample = tw.sample(f, la, lo)
        sites.append({"id": f"site-{len(sites) + 1}", "name": street, "lat": la, "lon": lo,
                      "sample": sample, "before": choices["trees"]["before"], "choices": choices})
        if len(sites) == 12:
            break
    if not sites:
        raise ValueError("No mapped walkable candidate sites in this neighbourhood.")
    # Validation demonstrations span the model's road surface-temperature range,
    # rather than reusing only the hottest investment candidates.
    ordered = sorted(candidates, key=lambda p: float(f.t_surface[geo.latlon_to_cell(p[1], p[2])]))
    validation_sites = []
    for i, idx in enumerate(np.linspace(0, len(ordered) - 1, min(12, len(ordered))).astype(int)):
        _, la, lo, street = ordered[idx]
        validation_sites.append({"id": f"reading-{i + 1}", "name": street, "lat": la, "lon": lo,
                                 "sample": tw.sample(f, la, lo)})
    out = {"area": area, "area_name": name, "mode": mode, "time": when.isoformat(),
           "weather_source": f.weather.source, "center": [lat, lon],
           "bbox": [max(geo.S, lat - 520 / geo.M_PER_DEG_LAT), max(geo.W, lon - 520 / geo.M_PER_DEG_LON),
                    min(geo.N, lat + 520 / geo.M_PER_DEG_LAT), min(geo.E, lon + 520 / geo.M_PER_DEG_LON)],
           "roads": roads[:500], "sites": sites, "validation_sites": validation_sites, "kinds": KINDS,
           "note": "Independent 20 m simulations at separated sites; no changes are applied to the main twin. Costs are editable demonstration assumptions, not quotations. Tree benefits assume mature canopy; siting, land permission and maintenance need assessment."}
    if len(_catalog_cache) >= 8:
        _catalog_cache.clear()
    _catalog_cache[key] = time.monotonic(), out
    return out


def plan(data, budget, costs, projects=None):
    prices = {k: costs.get(k, v["cost"]) for k, v in KINDS.items()}
    lookup = {s["id"]: s for s in data["sites"]}
    if projects is None:
        options = []
        for site in data["sites"]:
            for kind, result in site["choices"].items():
                benefit = max(0, -result["delta_c"]) * result["cells_affected"] * geo.CELL_M ** 2
                if benefit > 0:
                    options.append((benefit / prices[kind], site["id"], kind))
        chosen, spent = set(), 0
        projects = []
        for _, sid, kind in sorted(options, reverse=True):
            if sid not in chosen and spent + prices[kind] <= budget:
                projects.append({"site_id": sid, "kind": kind})
                chosen.add(sid)
                spent += prices[kind]
    selected, seen, spent = [], set(), 0
    for item in projects:
        sid, kind = item["site_id"], item["kind"]
        if sid not in lookup or kind not in KINDS:
            raise ValueError("Choose a site and intervention from the current catalogue.")
        if sid in seen:
            raise ValueError("Use only one project per site; overlapping benefits cannot be added.")
        seen.add(sid)
        site = lookup[sid]
        spent += prices[kind]
        selected.append({"site_id": sid, "kind": kind, "name": site["name"], "cost": prices[kind],
                         "lat": site["lat"], "lon": site["lon"], "result": site["choices"].get(kind)})
    if spent > budget:
        raise ValueError("These projects exceed the budget. Remove a project or increase the budget.")
    thermal = [p["result"] for p in selected if p["result"] is not None]
    count = sum(r["cells_affected"] for r in thermal)
    before = sum(r["before"]["feels_c"] * r["cells_affected"] for r in thermal) / count if count else None
    after = sum(r["after"]["feels_c"] * r["cells_affected"] for r in thermal) / count if count else None
    return {"projects": selected, "spent": spent, "remaining": budget - spent,
            "before_c": round(before, 1) if before is not None else None,
            "after_c": round(after, 1) if after is not None else None,
            "reduction_c": round(before - after, 2) if count else 0,
            "evaluated_ground_m2": round(count * geo.CELL_M ** 2),
            "proposed_water_points": sum(p["kind"] == "water_refill" for p in selected),
            "method": "Greedy ranking by estimated temperature relief × evaluated ground area per rupee; not a global optimum. Temperature averages cover the selected, separate model patches, not the whole neighbourhood. Water proposals improve planned access only; they have no simulated temperature reduction."}


def parse_readings(content):
    if len(content) > 60000:
        raise ValueError("CSV must be under 60 KB and contain at most 60 readings.")
    reader = csv.DictReader(io.StringIO(content.lstrip("\ufeff")), strict=True)
    required = {"lat", "lon", "time", "metric", "observed_c"}
    if not required.issubset(set(reader.fieldnames or [])):
        raise ValueError("Required columns: lat,lon,time,metric,observed_c. Optional: predicted_c,label.")
    rows = []
    for i, row in enumerate(reader, 2):
        if len(rows) >= 60:
            raise ValueError("Use at most 60 readings per comparison.")
        try:
            la, lo, observed = float(row["lat"]), float(row["lon"]), float(row["observed_c"])
            predicted = float(row["predicted_c"]) if row.get("predicted_c", "").strip() else None
            when = datetime.fromisoformat(row["time"].strip().replace("Z", "+00:00"))
            metric = row["metric"].strip()
            if (not all(math.isfinite(x) for x in (la, lo, observed)) or not geo.in_bbox(la, lo)
                    or not -30 <= observed <= 100 or metric not in METRICS or when.tzinfo is None
                    or (predicted is not None and (not math.isfinite(predicted) or not -30 <= predicted <= 100))):
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise ValueError(f"Row {i}: use in-zone coordinates, finite temperatures (-30…100°C), a supported metric and an ISO timestamp with timezone.") from None
        rows.append({"lat": la, "lon": lo, "time": when.astimezone(timezone.utc).isoformat(), "metric": metric,
                     "observed_c": observed, "predicted_c": predicted, "label": (row.get("label") or f"Reading {i - 1}")[:80],
                     "synthetic": row.get("reference_source") == "synthetic_demo"})
    if not rows or len({r["metric"] for r in rows}) != 1:
        raise ValueError("Provide readings of one temperature metric per comparison; air, surface and feels-like cannot be mixed.")
    if len({(r["lat"], r["lon"], r["time"], r["metric"]) for r in rows}) != len(rows):
        raise ValueError("Duplicate place/time readings would distort the metrics. Remove duplicates first.")
    return rows


def validate_readings(rows, tolerance=2.0, *, demo=False):
    # Exported demonstrations retain their provenance when imported again.
    demo = demo or any(r.get("synthetic") for r in rows)
    paired = []
    now = base_time()
    for row in rows:
        predicted = row["predicted_c"]
        source = "synthetic_demo" if demo else "uploaded_reference"
        weather_source = "demo_scenario" if demo else "supplied_with_csv"
        if predicted is None:
            when = datetime.fromisoformat(row["time"])
            if not -86400 <= (when - now).total_seconds() <= 600:
                raise ValueError("Without predicted_c, readings must be from the last 24 hours. For older readings, include a saved model prediction at the same place and time.")
            tw = get_twin()
            frame = tw.frame(when, "live")
            if frame.weather.source != "open_meteo":
                raise ValueError("Matching weather is unavailable. Include predicted_c from a saved model snapshot; climatology cannot establish observation accuracy.")
            predicted = tw.sample(frame, row["lat"], row["lon"])[row["metric"]]
            source, weather_source = "twin_reconstruction", frame.weather.source
        paired.append({**row, "predicted_c": round(predicted, 2), "error_c": round(predicted - row["observed_c"], 3),
                       "reference_source": source, "weather_source": weather_source})
    errors = np.array([r["error_c"] for r in paired])
    return {"source": "synthetic_demo" if demo else "uploaded_observations", "metric": rows[0]["metric"],
            "metric_label": METRICS[rows[0]["metric"]], "rows": paired, "tolerance_c": tolerance,
            "stats": {"count": len(rows), "mae_c": round(float(np.abs(errors).mean()), 3),
                      "rmse_c": round(float(np.sqrt(np.square(errors).mean())), 3),
                      "bias_c": round(float(errors.mean()), 3), "within_tolerance_pct": round(float((np.abs(errors) <= tolerance).mean() * 100), 1)},
            "note": "Synthetic demo readings demonstrate the workflow, not model accuracy." if demo else
                    "Uploaded observations and saved references are supplied by you, not independently verified. Missing references are reconstructed with the current twin and matching weather, not an archived forecast. Comparison never trains or recalibrates the model."}


def demo_readings(area, metric, tolerance=2):
    data = catalog(area, "demo")
    offsets = [.8, -1.2, 2.1, -.4, 1.5, -.9, .2, -1.8, 1.1, -.6, .5, -1.3]
    rows = [{"lat": s["lat"], "lon": s["lon"], "time": data["time"], "metric": metric,
             "predicted_c": s["sample"][metric], "observed_c": round(s["sample"][metric] + offsets[i], 2),
             "label": f"Demo {i + 1} · {s['name']}"} for i, s in enumerate(data["validation_sites"])]
    return validate_readings(rows, tolerance, demo=True)
