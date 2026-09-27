"""Isolated, opt-in condition checks. Only explicit acceptance stores a new trip."""
from __future__ import annotations

import hashlib
import os
import threading
import uuid
from datetime import timedelta

import numpy as np

from . import geo, modes
from .condition_correction import correction_layer
from .explanation_service import explain
from .multi_route_engine import legal_edges
from .prediction_service import TIMELINE_OFFSETS
from .risk_scoring import CAUTION_C, PERSONAS
from .route_classifier import explain_choice
from .route_planner import REST_RELIEF, traffic_times
from .routing_service import Path
from .traffic import traffic_service
from .weather import base_time

_gate = threading.Semaphore(1)


def _number(name, default, low, high):
    try:
        value = float(os.getenv(name, str(default)))
        return max(low, min(high, value)) if np.isfinite(value) else default
    except ValueError:
        return default


def settings():
    return {"available": os.getenv("HEATMIND_DYNAMIC_REROUTE_ENABLED", "1").lower() in ("1", "true", "yes"),
            "check_seconds": int(_number("REROUTE_CHECK_INTERVAL_SECONDS", 60, 30, 600)),
            "continue_cooldown_seconds": int(_number("REROUTE_CONTINUE_COOLDOWN_SECONDS", 300, 60, 3600)),
            "time_saving_min": _number("REROUTE_TIME_SAVING_MIN", 5, 1, 60),
            "heat_improvement_percent": _number("REROUTE_HEAT_IMPROVEMENT_PERCENT", 15, 5, 80),
            "heat_dose_reduction_min": _number("REROUTE_HEAT_DOSE_REDUCTION_MIN", 5, 1, 100),
            "max_extra_minutes": _number("REROUTE_MAX_EXTRA_MINUTES", 5, 0, 15)}


def worthwhile(current, alternative, config, blocked=False):
    if blocked:
        return {"suggest": True, "saving_min": None, "heat_improvement_percent": None, "reason": "A road on this route is closed."}
    saving = current["duration_min"] - alternative["duration_min"]
    dose = current["metrics"]["heat_dose"]
    reduction = dose - alternative["metrics"]["heat_dose"]
    percent = reduction / dose * 100 if dose > 0 else 0
    # A quicker path cannot bring materially more heat; a cooler path has a detour cap.
    faster = saving >= config["time_saving_min"] and reduction >= 0
    cooler = (percent >= config["heat_improvement_percent"] and reduction >= config["heat_dose_reduction_min"]
              and -saving <= min(config["max_extra_minutes"], max(2, current["duration_min"] * .25)))
    return {"suggest": bool(faster or cooler), "saving_min": round(saving, 1),
            "heat_improvement_percent": round(percent, 1),
            "reason": "A quicker route is available." if faster else "A route with less predicted heat exposure is available." if cooler else "Keep your current route."}


def predicted_times(graph, field, mode, persona, seconds, congestion, corrected_congestion):
    """Apply only a bounded condition correction; pedestrians keep their existing pace."""
    if mode.key not in ("car", "bike", "cycle"):
        return seconds
    sensitivity = modes.CONGESTION_SENSITIVITY[mode.key]
    ratio = (1 - .5 * sensitivity * congestion) / np.maximum(1 - .5 * sensitivity * corrected_congestion, .1)
    out = seconds * ratio
    out[field["closed"]] = seconds[field["closed"]]  # ML never reopens an observed closure.
    return out


def remaining_path(graph, path, position, mode):
    """Reuse the planned suffix; never compare a remaining trip with its full length."""
    src = graph.snap(*position, mode=mode)
    if src in path.nodes:
        index = path.nodes.index(src)
    else:
        index = min(range(len(path.nodes)), key=lambda i: geo.haversine_m(position, graph.node_ll[path.nodes[i]]))
        # A poor/off-route fix cannot justify a favourable comparison against a
        # fabricated connector. Wait for an on-route fix; normal navigation continues.
        if geo.haversine_m(position, graph.node_ll[path.nodes[index]]) > 70:
            raise ValueError("Wait for an accurate position on the current route.")
        join = path.nodes[index]
        edge_cost = np.where(graph.mode_mask(mode), graph.elen, np.inf)
        connector = graph.dijkstra(src, join, edge_cost)
        if connector is None:
            raise ValueError("Wait for an accurate position on the current route.")
        return src, Path(connector.nodes[:-1] + path.nodes[index:], connector.edges + path.edges[index:])
    return src, Path(path.nodes[index:], path.edges[index:])


def _plan(planner, compare_id, route_id, position):
    config = settings()
    if not config["available"]:
        raise ValueError("Route update suggestions are disabled.")
    state = planner.get(compare_id)
    if not state or route_id not in state["paths"]:
        raise KeyError("Trip expired; plan your journey again.")
    selected = next((r for r in state["result"]["routes"] if r["id"] == route_id), None)
    mode = modes.get(selected["mode"] if selected else state["mode"])
    if mode.transit:
        raise ValueError("Street reroute suggestions are unavailable on a bus itinerary.")
    graph = planner.graph
    src, suffix = remaining_path(graph, state["paths"][route_id], position, mode)
    dst = graph.snap(*state["destination"], mode=mode)
    if src == dst or len(suffix.edges) == 0:
        return {"arrived": True, "suggest": False, "reason": "You are at the destination."}, None
    now = base_time(state["scenario"])
    frames = [planner.twin.frame(now + timedelta(minutes=o), state["scenario"], state["temp_delta"]) for o in TIMELINE_OFFSETS]
    persona = PERSONAS[state["persona"]]
    pvs = [graph.piece_values(frame, mode.shady_side and persona["walks_shady_side"]) for frame in frames]
    speed = modes.speed_ms(mode, persona, congestion=planner._congestion(frames[0]))
    seconds = graph.p_len / speed
    edge_seconds = np.bincount(graph.p_edge, weights=seconds, minlength=len(graph.eu))
    fastest = graph.dijkstra(src, dst, np.where(graph.mode_mask(mode), edge_seconds, np.inf))
    field = traffic_service.route_field(graph, [p for p in (suffix, fastest) if p], now)
    seconds = traffic_times(graph, field, mode, persona, seconds)
    congestion = np.where(field["live"], np.nan_to_num(field["congestion"]), planner._congestion(frames[0]))
    pvs, corrected_congestion, correction = correction_layer.apply(graph, pvs, frames, congestion, planner._congestion)
    if correction["ml_applied"]:
        seconds = predicted_times(graph, field, mode, persona, seconds, congestion, corrected_congestion)
    feels, exposure, intensity = planner._at_arrival(graph, src, seconds, frames, pvs,
                                                    limit_s=TIMELINE_OFFSETS[-1] * 60, mode=mode)
    ref = max(CAUTION_C - persona["vulnerability_shift_c"], float(np.percentile(feels, 10)))
    penalty = (np.clip(feels - ref, 0, None) / 4 + .6 * exposure * intensity) * mode.heat_exposure
    penalty += .35 * corrected_congestion * mode.heat_exposure
    if state.get("senior") or mode.key in ("walk", "cycle"):
        penalty *= 1 - REST_RELIEF * planner._rest_proximity()
    allowed = legal_edges(graph, mode, field)
    # Reuse Dijkstra for time-first, balanced and heat-averse candidates.
    # ML supplies the conditions, never a route label or ranking.
    time_cost = np.bincount(graph.p_edge, weights=seconds, minlength=len(graph.eu))
    heat_cost = np.bincount(graph.p_edge, weights=seconds * penalty, minlength=len(graph.eu))
    edge_cost = time_cost + 1.5 * heat_cost
    paths, seen = [], set()
    for weight in (0, 1.5, 3):
        path = graph.dijkstra(src, dst, np.where(allowed, time_cost + weight * heat_cost, np.inf))
        if path is not None and tuple(path.edges) not in seen:
            seen.add(tuple(path.edges))
            paths.append(path)
    if not paths:
        raise ValueError("No usable alternative route is available.")
    blocked = not all(allowed[e] for e in graph.edge_ids(suffix))
    sample = np.linspace(0, len(graph.p_len) - 1, min(2048, len(graph.p_len))).astype(int)
    signature = hashlib.sha256(np.column_stack([np.round(pvs[0]["feels"][sample] * 2),
                                                np.round(pvs[1]["feels"][sample] * 2),
                                                np.round(corrected_congestion[sample] * 10)]).tobytes()
                               + np.flatnonzero(field["closed"]).tobytes()).hexdigest()
    cid = uuid.uuid4().hex[:10]
    kwargs = {"piece_seconds": seconds, "traffic": field,
              "free_seconds": graph.p_len / modes.speed_ms(mode, persona, congestion=0)}
    current = None if blocked else planner._build_route(cid, len(paths), suffix, persona, state["persona"], frames, pvs, mode, speed, **kwargs)
    alternatives = []
    for index, path in enumerate(paths):
        candidate = planner._build_route(cid, index, path, persona, state["persona"], frames, pvs, mode, speed, **kwargs)
        outcome = worthwhile(current, candidate, config, blocked)
        if tuple(path.edges) == tuple(suffix.edges):
            outcome.update(suggest=False, reason="Keep your current route.")
        # The improvement gates suppress poor offers; among eligible Dijkstra
        # paths retain the same time/heat cost used by the balanced search.
        cost = sum(float(edge_cost[e]) for e in graph.edge_ids(path))
        alternatives.append((cost, path, candidate, outcome))
    eligible = [item for item in alternatives if item[3]["suggest"]]
    _, best, candidate, outcome = min(eligible or alternatives, key=lambda item: item[0])
    outcome.update(arrived=False, conditions_signature=signature, blocked=blocked,
                   prediction=correction, checked_at=now.isoformat(),
                   current=None if current is None else current["metrics"], alternative=candidate["metrics"])
    return outcome, (state, candidate, current, best, frames, position, cid)


def check(planner, compare_id, route_id, position, *, accept=False):
    if not _gate.acquire(blocking=False):
        raise RuntimeError("A route check is already running; guidance continues.")
    try:
        outcome, plan = _plan(planner, compare_id, route_id, position)
        # Checking, ignoring or declining never touches planner comparisons or navigation.
        if not accept or not outcome["suggest"] or plan is None:
            return {**outcome, "comparison": None}
        state, route, current, path, frames, position, cid = plan
        route.update(label="Route A", title="Updated route", color="#6fbf5e", tags=["recommended"])
        if current:
            current.update(label="Previous route")
        route["tradeoff"] = {"extra_min": 0, "dose_change_pct": 0, "score_change": 0, "shade_change_pts": 0}
        explain_choice(route, route)
        route["explanation"] = explain(route, current, state["persona"], frames[0].when.isoformat(), frames[0].elev > 0)
        route = {k: v for k, v in route.items() if not k.startswith("_")}
        best = min(route["forecast"], key=lambda f: f["score"])
        mode = modes.get(route["mode"])
        comparison = {**state["result"], "compare_id": cid, "depart_at": frames[0].when.isoformat(),
                      "mode": mode.key, "mode_label": mode.label, "mode_note": mode.note,
                      "speed_kmh": route["speed_kmh"], "street_speed_kmh": route["speed_kmh"], "transit": None,
                      "origin": {"lat": position[0], "lon": position[1], "snapped": route["geometry"][0]},
                      "recommended_id": route["id"], "routes": [route], "conditions": planner.twin.describe(frames[0]),
                      "best_departure": {"offset_min": best["offset_min"], "time": best["time"], "score": best["score"],
                                         "score_now": route["forecast"][0]["score"], "improvement": round(route["forecast"][0]["score"] - best["score"], 1),
                                         "advice": "Check the departure forecast before travelling."}}
        comparison.pop("simulation", None)
        with planner._lock:
            planner._store[cid] = {**state, "origin": position, "depart": frames[0].when, "mode": mode.key,
                                   "paths": {route["id"]: path}, "recommended_id": route["id"], "result": comparison}
            while len(planner._store) > 200:
                planner._store.popitem(last=False)
        return {**outcome, "comparison": comparison}
    finally:
        _gate.release()
