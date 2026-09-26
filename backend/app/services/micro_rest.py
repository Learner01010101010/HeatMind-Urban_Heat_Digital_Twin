"""Deadline-constrained micro-rest using the existing street graph and heat twin."""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import numpy as np

from . import geo, modes
from .risk_scoring import PERSONAS
from .route_classifier import usable_stop
from .route_planner import get_planner

MIN_REST_MIN = 1.0
BUFFER_MIN = 1.0
ETA_PADDING = 1.2
MAX_CONNECTOR_M = 80.0


def rank_candidates(points: list[dict], remaining_min: float) -> list[dict]:
    """Feasibility first; then shade, water, seating, heat relief and time margin."""
    ranked = []
    for point in points:
        travel = point["outbound_min"] + point["return_min"]
        available = remaining_min - travel - BUFFER_MIN
        if available < MIN_REST_MIN:
            continue
        rest = min(5.0, math.floor((available + 1e-9) * 10) / 10)
        shade = point["shade_pct"] / 100
        relief = min(1.0, max(0.0, point["cooler_by_c"]) / 5)
        margin = min(1.0, available / max(remaining_min, 1))
        benefit = 45 * shade + 30 * point["water"] + 10 * point["seating"] + 10 * relief + 5 * margin
        ranked.append({**point, "rest_min": rest, "buffer_min": BUFFER_MIN,
                       "required_min": travel + MIN_REST_MIN + BUFFER_MIN,
                       "score": round(benefit, 2)})
    return sorted(ranked, key=lambda p: (-p["score"], p["outbound_min"] + p["return_min"], p["id"]))


def schedule(*, origin: tuple[float, float], pickup: tuple[float, float],
             ready_at: datetime, persona: str, now: datetime | None = None, planner=None) -> dict:
    now = now or datetime.now(timezone.utc)
    remaining = (ready_at - now).total_seconds() / 60
    result = {"calculated_at": now.isoformat(), "ready_at": ready_at.isoformat(),
              "remaining_min": round(max(0, remaining), 2), "candidates": [],
              "status": "no_fit", "weather_source": None,
              "method": "existing_street_dijkstra_deadline_filter",
              "note": "Walking estimates include 20% padding, at least 1 min rest and a 1 min return buffer. OSM access/hours and modelled shade need confirmation."}
    if remaining <= 0:
        return {**result, "status": "expired"}
    if remaining > 60:
        raise ValueError("Pickup wait must be no more than 60 minutes.")
    if remaining < MIN_REST_MIN + BUFFER_MIN:
        return result
    if persona not in PERSONAS:
        raise ValueError("Unknown persona.")
    for lat, lon in (origin, pickup):
        if not geo.in_bbox(lat, lon):
            raise ValueError("Micro-rest is available inside the South Pune twin zone.")
    planner = planner or get_planner()
    graph, twin = planner.graph, planner.twin
    walk = modes.get("walk")
    # Delivery persona carries riding speed; this short rest detour is on foot.
    speed = min(1.4, modes.speed_ms(walk, PERSONAS[persona]))
    src, home = graph.snap(*origin, mode=walk), graph.snap(*pickup, mode=walk)
    origin_link = geo.haversine_m(origin, graph.node_ll[src])
    pickup_link = geo.haversine_m(pickup, graph.node_ll[home])
    if max(origin_link, pickup_link) > MAX_CONNECTOR_M:
        raise ValueError("Pickup/current location is too far from a mapped walkable street. Select a nearby street point.")
    costs = np.where(graph.mode_mask(walk), graph.elen / speed, np.inf)
    radius = remaining * 60 * speed / ETA_PADDING
    pois = [p for p in planner.pois if usable_stop(p)
            and (p.get("opening_hours") or "").strip().lower() not in ("closed", "off")
            and geo.in_bbox(p["lat"], p["lon"])
            and geo.haversine_m(origin, (p["lat"], p["lon"])) <= radius]
    # Bound work per refresh. Straight-line distance prefilters; ETA uses streets.
    pois.sort(key=lambda p: geo.haversine_m(origin, (p["lat"], p["lon"])))
    if not pois:
        return result
    frame = twin.frame(now, "live")
    result["weather_source"] = frame.weather.source
    current_heat = twin.sample(frame, *origin)["feels_c"]
    options = []
    for poi in pois[:20]:
        position = (poi["lat"], poi["lon"])
        target = graph.snap(*position, mode=walk)
        connector = geo.haversine_m(position, graph.node_ll[target])
        if connector > MAX_CONNECTOR_M:
            continue
        outward = graph.dijkstra(src, target, costs)
        backward = graph.dijkstra(target, home, costs)
        if outward is None or backward is None:
            continue

        def minutes(path, links):
            seconds = float(np.sum(costs[list(graph.edge_ids(path))])) + links / speed
            return math.ceil(seconds * ETA_PADDING) / 60

        out = minutes(outward, origin_link + connector)
        back = minutes(backward, pickup_link + connector)
        sample = twin.sample(frame, *position)
        water = poi.get("detail") in ("drinking_water", "water_point", "water_dispenser")
        sheltered = poi.get("covered") == "yes" or poi.get("detail") == "shelter"
        shade_pct = 100.0 if sheltered else round((1 - sample["sun_exposure"]) * 100)
        amenities = []
        if water:
            amenities.append("mapped drinking water")
        if sheltered:
            amenities.append("mapped shelter")
        elif frame.intensity > .05 and shade_pct >= 40:
            amenities.append("modelled shade")
        if poi.get("detail") == "bench":
            amenities.append("bench")
        if poi.get("detail") == "toilets":
            amenities.append("toilet")
        if not amenities:
            continue
        options.append({"id": poi["id"], "name": poi["name"], "lat": poi["lat"], "lon": poi["lon"],
                        "outbound_min": out, "return_min": back, "amenities": amenities,
                        "shade_pct": shade_pct if frame.intensity > .05 or sheltered else 0,
                        "water": water, "seating": poi.get("detail") == "bench",
                        "feels_c": sample["feels_c"], "cooler_by_c": round(current_heat - sample["feels_c"], 1),
                        "source": "osm", "opening_hours": poi.get("opening_hours"),
                        "leave_by": (ready_at - timedelta(minutes=back + BUFFER_MIN)).isoformat(),
                        "hours_status": "Mapped 24/7" if poi.get("opening_hours") == "24/7" else "Opening/access unverified"})
    candidates = rank_candidates(options, remaining)
    return {**result, "status": "recommended" if candidates else "no_fit", "candidates": candidates}
