"""Recheck the remaining journey against fresh available conditions."""
from __future__ import annotations

from datetime import datetime, timezone

from . import modes
from .multi_route_engine import legal_edges, switch_decision
from .routing_service import Path
from .traffic import traffic_service


def recheck(planner, *, compare_id, route_id, position=None, objective=None, off_route=False, temp_delta_c=0):
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
    traffic = traffic_service.route_field(planner.graph, [suffix] if suffix else [], now)
    allowed = legal_edges(planner.graph, mode, traffic)
    blocked = bool(suffix and any(not allowed[e] for e in planner.graph.edge_ids(suffix)))
    selected_objective = objective or state.get("objective", "balanced")
    new = planner.compare(origin=origin, destination=state["destination"], persona=state["persona"],
                          scenario=state["scenario"], depart=now, temp_delta=temp_delta_c,
                          extra_paths=[suffix] if suffix and not blocked else None,
                          mode=state.get("mode"), senior=state.get("senior", False), objective=selected_objective)
    current = next((r for r in new["routes"] if "current" in r["tags"]), None)
    chosen = next(r for r in new["routes"] if r["id"] == new["recommended_id"])
    # If a new closure observation arrived while replanning, re-evaluate the pinned
    # suffix against the refreshed cache as well.
    if suffix:
        refreshed = traffic_service.route_field(planner.graph, [suffix], now)
        allowed = legal_edges(planner.graph, mode, refreshed)
        blocked = blocked or any(not allowed[e] for e in planner.graph.edge_ids(suffix))
    should_switch, message = switch_decision(current, chosen, selected_objective, off_route=off_route, blocked=blocked)
    changes = []
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
            "checked_at": now.isoformat(), "comparison": new}
