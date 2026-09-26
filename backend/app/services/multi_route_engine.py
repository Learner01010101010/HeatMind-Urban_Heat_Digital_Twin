"""Exact distance/time searches, candidate Pareto comparison and local training log.

The classifier is explainable rules, not a trained ML model. Exposure is modelled;
the log contains rule-derived labels, not measured trip outcomes or health labels.
"""
from __future__ import annotations

import heapq
import json
import math
import sqlite3
from contextlib import closing
from pathlib import Path as FilePath

import numpy as np

from ..config import DATA_DIR
from . import geo
from .routing_service import Path

OBJECTIVES = {"balanced", "fastest", "shortest", "coolest"}
TRAINING_FILE = DATA_DIR / "route_training.sqlite3"


def astar(graph, src, dst, costs, allowed):
    """A* over existing edges, with an admissible great-circle lower bound.

    No new graph, access rules or speed model. A zero lower bound falls back to
    Dijkstra's ordering. Disallowed/closed edges are skipped, never penalised.
    """
    valid = allowed & np.isfinite(costs) & (graph.elen > 0)
    rate = max(0.0, float(np.min(costs[valid] / graph.elen[valid]))) * .999 if valid.any() else 0.0
    if (costs[valid] < 0).any():
        raise ValueError("A* requires nonnegative edge costs")
    target = graph.node_ll[dst]
    heuristic = lambda n: geo.haversine_m(graph.node_ll[n], target) * rate
    distances, previous = {src: 0.0}, {}
    queue = [(heuristic(src), 0.0, src)]
    while queue:
        _, distance, node = heapq.heappop(queue)
        if distance != distances.get(node):
            continue
        if node == dst:
            nodes, edges = [dst], []
            while nodes[-1] != src:
                parent, edge = previous[nodes[-1]]
                nodes.append(parent)
                edges.append(edge)
            return Path(nodes[::-1], edges[::-1])
        for neighbour, edge, direction in graph.adj[node]:
            if not valid[edge]:
                continue
            candidate = distance + float(costs[edge])
            if candidate < distances.get(neighbour, math.inf):
                distances[neighbour] = candidate
                previous[neighbour] = (node, edge if direction == 1 else -(edge + 1))
                heapq.heappush(queue, (candidate + heuristic(neighbour), candidate, neighbour))
    return None


def legal_edges(graph, mode, traffic=None):
    allowed = graph.mode_mask(mode).copy()
    if traffic is not None and mode.key in ("car", "bike"):
        closed = np.bincount(graph.p_edge, weights=traffic["closed"].astype(float), minlength=len(graph.eu)) > 0
        allowed &= ~closed
    return allowed


def augment_candidates(graph, src, dst, seconds, paths, mode, traffic=None):
    """Keep heat-search alternatives; explicitly add shortest and fastest paths."""
    allowed = legal_edges(graph, mode, traffic)
    time_cost = np.bincount(graph.p_edge, weights=seconds, minlength=len(graph.eu))
    shortest = graph.dijkstra(src, dst, np.where(allowed, graph.elen, np.inf))
    fastest = astar(graph, src, dst, time_cost, allowed)
    result, seen = [], set()
    for path in [*paths, shortest, fastest]:
        if path is None or not all(allowed[e] for e in graph.edge_ids(path)):
            continue
        key = tuple(path.edges)
        if key not in seen:
            seen.add(key)
            result.append(path)
    return result


def objective_choices(routes):
    street = [r for r in routes if not r.get("transit") and "transit" not in r["tags"]]
    fastest = min(street, key=lambda r: (r["duration_min"], r["heat_risk_score"]))
    shortest = min(street, key=lambda r: (r["distance_m"], r["duration_min"]))
    coolest = min(street, key=lambda r: (r["metrics"]["heat_dose"], r["heat_risk_score"], r["duration_min"]))
    eligible = [r for r in street if r["duration_min"] <= fastest["duration_min"] * 1.5 + 4]
    best = min(eligible, key=lambda r: (r["optimization"]["score"], r["duration_min"]))
    balanced = best if best["optimization"]["score"] <= fastest["optimization"]["score"] - 2 else fastest
    return {"fastest": fastest, "shortest": shortest, "coolest": coolest, "balanced": balanced}


def pareto_ids(routes):
    """Non-dominated generated candidates, not a globally exhaustive Pareto front."""
    street = [r for r in routes if not r.get("transit") and "transit" not in r["tags"]]
    values = lambda r: (r["duration_min"], r["distance_m"], r["metrics"]["heat_dose"], r["optimization"]["score"])
    return [r["id"] for r in street if not any(
        all(a <= b for a, b in zip(values(other), values(r)))
        and any(a < b for a, b in zip(values(other), values(r))) for other in street if other is not r)]


def describe_engine(routes, objective):
    choices = objective_choices(routes)
    frontier = pareto_ids(routes)
    for route in routes:
        route["objective_roles"] = [key for key, value in choices.items() if value is route]
        route["pareto"] = route["id"] in frontier
    return {"objective": objective, "method": "multi_algorithm_rules", "trained_ml": False,
            "choices": {key: value["id"] for key, value in choices.items()}, "pareto_ids": frontier,
            "algorithms": ["Dijkstra · distance", "A* · travel time", "Heat-weighted Dijkstra", "Pareto candidate comparison"],
            "note": "Shortest and fastest use the mapped graph and estimated edge costs. Least heat is among generated candidates. Balanced limits detours; no trained ML model.",
            "monitor": {"check_seconds": 60, "traffic_cache_seconds": 300, "weather_cache_seconds": 1800}}


def record_examples(result, path: FilePath = TRAINING_FILE):
    """Bounded local-only examples; no coordinates, user IDs, names or API keys."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(path, timeout=.3)) as db, db:
            db.execute("CREATE TABLE IF NOT EXISTS examples (id INTEGER PRIMARY KEY, route_key TEXT UNIQUE, features TEXT, labels TEXT)")
            for route in result["routes"]:
                c = route.get("optimization")
                if not c:
                    continue
                features = {**route["metrics"], "heat_risk_score": route["heat_risk_score"],
                            "combined_score": c["score"], "industrial_heat_c": c["industrial"]["mean_c"],
                            "traffic_delay_min": c["traffic"]["delay_min"], "traffic_live_pct": c["traffic"]["coverage_pct"],
                            "public_stops": c["mapped_stops"], "mode": route["mode"], "persona": result["persona"],
                            "scenario": result["scenario"], "temp_delta_c": result["temp_delta_c"],
                            "weather_source": result["conditions"]["weather"]["source"]}
                labels = {"source": "rule_derived", "roles": route.get("objective_roles", []), "risk_band": route["band"],
                          "observed_trip_time_min": None, "measured_heat_exposure": None}
                db.execute("INSERT OR IGNORE INTO examples(route_key, features, labels) VALUES (?, ?, ?)",
                           (route["id"], json.dumps(features, allow_nan=False), json.dumps(labels)))
            db.execute("DELETE FROM examples WHERE id <= (SELECT COALESCE(MAX(id), 0) - 10000 FROM examples)")
            count = db.execute("SELECT COUNT(*) FROM examples").fetchone()[0]
        return {"available": True, "examples": count, "label_source": "rule_derived", "file": path.name}
    except (OSError, sqlite3.Error, ValueError):
        return {"available": False, "examples": None, "label_source": "rule_derived", "file": path.name}


def switch_decision(current, chosen, objective, *, off_route=False, blocked=False):
    if blocked:
        return True, "A sampled road on your route is closed."
    if off_route:
        return True, "Your position is off the planned route."
    if current is None:
        return False, "Could not match the remaining route; keeping your current guidance."
    if current["id"] == chosen["id"]:
        return False, "Your remaining route is still the best choice."
    gain = current["optimization"]["score"] - chosen["optimization"]["score"]
    time_gain = current["duration_min"] - chosen["duration_min"]
    distance_gain = current["distance_m"] - chosen["distance_m"]
    dose = current["metrics"]["heat_dose"]
    heat_gain = dose - chosen["metrics"]["heat_dose"]
    if objective == "fastest" and time_gain >= 1:
        return True, f"Save about {time_gain:.1f} min with the updated travel conditions."
    if objective == "shortest" and distance_gain >= 100:
        return True, f"The new route is about {distance_gain:.0f} m shorter."
    if objective == "coolest" and (heat_gain >= max(3, dose * .1) or current["heat_risk_score"] - chosen["heat_risk_score"] >= 3):
        return True, "A different route now has meaningfully lower modelled heat exposure."
    if objective == "balanced" and gain >= 2:
        return True, f"The new route improves the combined preference score by {gain:.1f} points."
    return False, "The improvement is too small to change your route."
