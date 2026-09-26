"""Recheck the remaining journey against fresh available conditions."""
from __future__ import annotations

from datetime import datetime, timezone

from . import jam_sim, modes
from .multi_route_engine import legal_edges, switch_decision
from .routing_service import Path
from .traffic import traffic_service


def recheck(planner, *, compare_id, route_id, position=None, objective=None, off_route=False,
            temp_delta_c=0, demo_jam=False):
    state = planner.get(compare_id)
    if not state:
        raise KeyError(compare_id)
    old = next((r for r in state["result"]["routes"] if r["id"] == route_id), None)
    if old is None or old.get("transit"):
        raise ValueError("Live rerouting requires a street route from this comparison.")
    mode = modes.get(old.get("mode", "walk"))
    origin = position or state["origin"]
    src = planner.graph.snap(*origin, mode=mode)
    dst = planner.graph.snap(*state["destination"], mode=mode)
    if src == dst:
        return {"arrived": True, "should_switch": False, "message": "You are at the destination street point.", "comparison": None,
                "checked_at": datetime.now(timezone.utc).isoformat(), "changes": []}
    # Pin the actual remaining suffix, never compare a remaining candidate against
    # the full original journey. If the GPS snapped away from it, report off-route.
    path = state["paths"].get(route_id)
    suffix = None
    if path and src in path.nodes:
        index = path.nodes.index(src)
        suffix = Path(path.nodes[index:], path.edges[index:])
    now = datetime.now(timezone.utc)
    # The simulated jam goes on the road the traveller is about to reach, so the
    # reroute has somewhere to go and the jam is unmistakably on their path.
    jam = jam_sim.ahead_on(planner.graph, suffix) if demo_jam else None
    traffic = traffic_service.route_field(planner.graph, [suffix] if suffix else [], now, jam)
    allowed = legal_edges(planner.graph, mode, traffic)
    blocked = bool(suffix and any(not allowed[e] for e in planner.graph.edge_ids(suffix)))
    selected_objective = objective or state.get("objective", "balanced")
    new = planner.compare(origin=origin, destination=state["destination"], persona=state["persona"],
                          scenario=state["scenario"], depart=now, temp_delta=temp_delta_c,
                          extra_paths=[suffix] if suffix and not blocked else None,
                          mode=state.get("mode"), senior=state.get("senior", False),
                          objective=selected_objective, jam=jam)
    current = next((r for r in new["routes"] if "current" in r["tags"]), None)
    chosen = next(r for r in new["routes"] if r["id"] == new["recommended_id"])
    # If a new closure observation arrived while replanning, re-evaluate the pinned
    # suffix against the refreshed cache as well.
    if suffix:
        refreshed = traffic_service.route_field(planner.graph, [suffix], now, jam)
        allowed = legal_edges(planner.graph, mode, refreshed)
        blocked = blocked or any(not allowed[e] for e in planner.graph.edge_ids(suffix))
    should_switch, message = switch_decision(current, chosen, selected_objective, off_route=off_route, blocked=blocked)
    comparison = None
    if jam is not None:
        on_route = jam_sim.pieces_hit(planner.graph, suffix, jam)
        # Under a demo jam the choice is made on the axes a traveller was promised
        # — clear of the jam first, then whichever candidate wins on the most of
        # time, distance, heat, traffic, shade and water. Outside the demo the
        # engine's own objective still decides; this does not touch it.
        clear = _clear_of_jam(new["routes"], jam)
        better = _best_for_traveller(clear, current)
        if better is not None:
            chosen = better
        if current is not None and chosen["id"] != current["id"]:
            should_switch = True
            message = "Simulated jam ahead — rerouted around it."
        elif current is not None:
            message = ("Simulated jam ahead, but no alternative avoids it and scores "
                       "better; staying on this route.")
        comparison = _axes(current, chosen)
    changes = []
    if jam is not None:
        changes.append(f"Simulated jam on {on_route} piece{'' if on_route == 1 else 's'} ahead")
    old_air = state["result"]["conditions"]["weather"]["air_c"]
    new_air = new["conditions"]["weather"]["air_c"]
    if abs(new_air - old_air) >= .5:
        changes.append(f"Air temperature changed by {new_air - old_air:+.1f}°C")
    old_traffic = old.get("optimization", {}).get("traffic", {})
    new_traffic = chosen.get("optimization", {}).get("traffic", {})
    if new_traffic.get("observed_at") != old_traffic.get("observed_at"):
        changes.append("Traffic samples updated" if new_traffic.get("live") else "Traffic using estimates")
    if off_route:
        changes.append("Off-route position")
    if blocked:
        changes.append("Road closure")
    return {"arrived": False, "should_switch": should_switch, "message": message, "changes": changes,
            "checked_at": now.isoformat(), "comparison": new,
            "jam": jam.as_dict() if jam else None, "axes": comparison}


def _axes(current, chosen):
    """Old route versus new, on the axes a traveller would actually weigh.

    Reported rather than asserted. A detour around a jam is routinely longer in
    distance even when it is faster, cooler and quieter, so every axis carries its
    own verdict and the caller can show which ones actually improved.
    """
    if current is None or chosen is None:
        return None

    def factor(route, key):
        for f in route.get("optimization", {}).get("factors", []):
            if f["key"] == key:
                return float(f.get("raw") or 0.0)
        return 0.0

    def axis(label, before, after, lower_is_better=True, unit="", digits=1):
        gain = (before - after) if lower_is_better else (after - before)
        return {"label": label, "before": round(before, digits), "after": round(after, digits),
                "unit": unit, "improved": gain > 0, "same": abs(gain) < 10 ** -digits,
                "delta": round(after - before, digits)}

    return [
        axis("Travel time", current["duration_min"], chosen["duration_min"], unit="min"),
        axis("Distance", current["distance_m"] / 1000, chosen["distance_m"] / 1000, unit="km", digits=2),
        axis("Heat exposure", current["metrics"]["heat_dose"], chosen["metrics"]["heat_dose"], unit="°C·min"),
        axis("Traffic delay", factor(current, "traffic"), factor(chosen, "traffic"), unit="s"),
        axis("Shade cover", current["metrics"]["pct_shaded"], chosen["metrics"]["pct_shaded"],
             lower_is_better=False, unit="%", digits=0),
        axis("Water & rest stops", len(current.get("pois_along_route", [])), len(chosen.get("pois_along_route", [])),
             lower_is_better=False, unit="", digits=0),
    ]


def _clear_of_jam(routes, jam):
    """Street routes that do not pass through the jam."""
    from . import geo
    out = []
    for route in routes:
        if route.get("transit") or "transit" in route["tags"]:
            continue
        if any(geo.haversine_m(point, (jam.lat, jam.lon)) <= jam.radius_m for point in route["geometry"]):
            continue
        out.append(route)
    return out


# How much each axis counts when a jam forces the choice. Time and traffic lead
# because that is what a jam actually costs; distance trails because a detour is
# longer almost by definition and would otherwise veto every escape.
_AXIS_WEIGHTS = {"Travel time": 1.0, "Traffic delay": 1.0, "Heat exposure": 1.0,
                 "Shade cover": .8, "Water & rest stops": .8, "Distance": .5}


def _best_for_traveller(candidates, current):
    """Pick the candidate that wins on the most of the traveller's axes.

    Ties, and the case where nothing beats the current route, fall back to the
    optimiser's own combined score, so this can only reorder options that the
    engine already considered acceptable.
    """
    if current is None or not candidates:
        return None
    def score(route):
        axes = _axes(current, route) or []
        return sum(_AXIS_WEIGHTS.get(a["label"], 0) * (1 if a["improved"] else 0 if a["same"] else -1)
                   for a in axes)
    return max(candidates, key=lambda r: (score(r), -r["optimization"]["score"]))
