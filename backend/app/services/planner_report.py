"""Municipal Heat Action Brief — SDG 11 (Sustainable Cities & Communities).

Ranks named streets by a pedestrian-exposure priority score built from the
same per-edge heat/shade values the Heat Twin overlay already computes
(routing_service.StreetGraph.piece_values), so the ranking a city planner
sees is consistent with everything else in the app rather than a separate
one-off calculation.
"""
from __future__ import annotations

import numpy as np

from .heat_twin_service import Frame
from .route_planner import get_planner


def worst_streets(f: Frame, top_n: int = 12) -> list[dict]:
    planner = get_planner()
    graph = planner.graph
    pv = graph.piece_values(f, shady_side=True)
    E = len(graph.eu)
    lens = np.bincount(graph.p_edge, weights=graph.p_len, minlength=E)
    feels_e = np.bincount(graph.p_edge, weights=graph.p_len * pv["feels"], minlength=E) / np.maximum(lens, 1e-6)
    expo_e = np.bincount(graph.p_edge, weights=graph.p_len * pv["exposure"], minlength=E) / np.maximum(lens, 1e-6)

    roads = planner.twin.zone.data["roads"]
    by_name: dict[str, dict] = {}
    for e in range(E):
        if lens[e] <= 0:
            continue
        ri = graph.eroad[e]
        real_name = roads[ri]["name"]
        # Unnamed OSM ways get their own bucket per road index — grouping every
        # unnamed "residential way" under one shared label would silently merge
        # dozens of unrelated streets into one fake multi-kilometre "street".
        key = real_name if real_name else f"__way_{ri}"
        display_name = real_name or f"Unnamed {roads[ri]['highway']} way"
        d = by_name.setdefault(key, {"name": display_name, "length_m": 0.0, "feels_sum": 0.0, "expo_sum": 0.0,
                                      "highway": roads[ri]["highway"], "edge0": e})
        d["length_m"] += float(lens[e])
        d["feels_sum"] += float(feels_e[e]) * float(lens[e])
        d["expo_sum"] += float(expo_e[e]) * float(lens[e])

    out = []
    for d in by_name.values():
        if d["length_m"] < 40:  # skip fragments too short to be a real intervention target
            continue
        mean_feels = d["feels_sum"] / d["length_m"]
        mean_expo = d["expo_sum"] / d["length_m"]
        shaded_pct = (1 - mean_expo) * 100
        # Hot AND unshaded streets rank highest; a shaded hot street ranks lower.
        # A per-metre severity score alone would put a 40 m alley ahead of a
        # 1 km avenue with identical conditions -- scale by how many people it
        # actually affects (length), capped so one mega-street can't dominate.
        severity = max(0.0, mean_feels - 30.0) * (0.4 + 0.6 * mean_expo)
        length_weight = min(1.0, d["length_m"] / 150.0)
        priority = severity * length_weight
        e0 = d["edge0"]
        a = graph.node_ll[graph.eu[e0]]
        out.append({
            "name": d["name"], "highway": d["highway"], "length_m": round(d["length_m"]),
            "mean_feels_c": round(mean_feels, 1), "shaded_pct": round(shaded_pct, 1),
            "priority_score": round(priority, 1),
            "sample": {"lat": round(a[0], 6), "lon": round(a[1], 6)},
        })
    out.sort(key=lambda x: x["priority_score"], reverse=True)
    return out[:top_n]


def report(f: Frame, top_n: int = 12) -> dict:
    return {
        "generated_at": f.when.isoformat(),
        "scenario": f.scenario,
        "weather": f.weather.as_dict(),
        "city_stats": f.stats,
        "methodology": ("priority = severity × min(1, length/150m), where severity = max(0, mean feels-like − 30°C) × "
                         "(0.4 + 0.6 × mean sun exposure) — per named street (≥40 m), from the same per-edge values as "
                         "the Heat Twin overlay. Length weighting keeps a 40 m alley from outranking a 1 km avenue "
                         "with identical conditions."),
        "streets": worst_streets(f, top_n),
    }
