"""A bus trip as three legs: walk to the stop, ride, walk from the stop.

Honest about what it is. There is no PMPML feed for this zone, so nothing here
claims a route number or a departure time. What it does claim:

  * the stops are real OSM records (see transit.py),
  * the ride follows roads a bus can physically use,
  * the wait is half an assumed headway, and every response says so.

The heat story is the reason this is worth modelling at all rather than handing
people a walking route and a shrug: on a bus trip the exposure is front-loaded. You
stand at a kerb in full sun for several minutes, then you are shielded. A stop with
a shelter is therefore worth a detour in a way that has nothing to do with distance,
and `_stop_score` is where that trade is made.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from . import geo, modes as modes_mod, transit
from .transit import Stop

#: Walking to a stop further away than the destination itself is not a bus trip.
MIN_RIDE_M = 600.0
#: A shelter is worth this many metres of extra walk when the sun is up — roughly the
#: distance whose walking exposure equals the waiting exposure it removes.
SHELTER_BONUS_M = 220.0


@dataclass
class Leg:
    kind: str  # "walk" | "wait" | "ride"
    from_name: str
    to_name: str
    minutes: float
    distance_m: float
    geometry: list[list[float]]
    sheltered: bool = False


def _dist_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    return geo.haversine_m(a, b)


def _stop_score(stop: Stop, at: tuple[float, float], sun_up: bool) -> float:
    """Effective walking distance to a stop, discounting shelter when the sun is up.

    A plain nearest-stop choice sends people to an unsheltered kerb 40 m away over a
    sheltered one 200 m away, and then has them stand in the sun for the wait. At
    night the shelter is worth nothing and the score is plain distance again.
    """
    d = _dist_m(at, (stop.lat, stop.lon))
    if sun_up and stop.shelter:
        d -= SHELTER_BONUS_M
    return d


def _nearest(stops: list[Stop], at: tuple[float, float], sun_up: bool,
             max_m: float) -> Stop | None:
    reachable = [s for s in stops if _dist_m(at, (s.lat, s.lon)) <= max_m]
    if not reachable:
        return None
    return min(reachable, key=lambda s: _stop_score(s, at, sun_up))


def plan(*, planner, origin: tuple[float, float], destination: tuple[float, float],
         persona: dict, sun_up: bool, congestion: float) -> dict | None:
    """Build a walk/ride/walk itinerary, or None when the bus does not help.

    Returns None rather than a bad bus route when the stops are too close together to
    be worth boarding, or when there is no stop within walking range of either end.
    The caller falls back to walking and says why, which is a better answer than an
    itinerary that has someone wait fifteen minutes to ride 300 metres.
    """
    stops = transit.stops()
    if not stops:
        return None

    board = _nearest(stops, origin, sun_up, transit.WALK_TO_STOP_MAX_M)
    alight = _nearest(stops, destination, sun_up, transit.WALK_TO_STOP_MAX_M)
    if board is None or alight is None or board.id == alight.id:
        return None

    ride_crow = _dist_m((board.lat, board.lon), (alight.lat, alight.lon))
    if ride_crow < MIN_RIDE_M:
        return None

    g = planner.graph
    bus_mode = modes_mod.get("bus")
    walk_mode = modes_mod.get("walk")
    walk_speed = modes_mod.speed_ms(walk_mode, persona)

    # Each leg is routed on the graph the leg's own mode may use: the walk legs over
    # footpaths included, the ride over bus-capable roads only.
    def leg_path(a: tuple[float, float], b: tuple[float, float], mode):
        src, dst = g.snap(*a, mode=mode), g.snap(*b, mode=mode)
        if src == dst:
            return None
        cost = g.elen.copy()
        cost = g.mode_edge_cost(mode, cost)
        path = g.dijkstra(src, dst, cost)
        if path is None:
            return None
        coords = [list(g.node_ll[n]) for n in path.nodes]
        metres = sum(_dist_m(tuple(p), tuple(q)) for p, q in zip(coords[:-1], coords[1:]))
        return coords, metres, path

    to_stop = leg_path(origin, (board.lat, board.lon), walk_mode)
    ride = leg_path((board.lat, board.lon), (alight.lat, alight.lon), bus_mode)
    from_stop = leg_path((alight.lat, alight.lon), destination, walk_mode)
    if ride is None:
        return None

    legs: list[Leg] = []
    if to_stop:
        coords, metres, _ = to_stop
        legs.append(Leg("walk", "Start", board.name, metres / walk_speed / 60, metres, coords))

    # Half a headway is the expected wait for someone who has not timed their arrival,
    # which is the only assumption available without a timetable.
    legs.append(Leg("wait", board.name, board.name, transit.HEADWAY_MIN / 2, 0.0,
                    [[board.lat, board.lon]], sheltered=board.shelter))

    coords, metres, ride_path = ride
    # Stops the bus passes through cost it dwell time; count the ones near the line.
    passed = sum(
        1 for s in stops
        if s.id not in (board.id, alight.id)
        and min(_dist_m((s.lat, s.lon), tuple(c)) for c in coords) < 60.0
    )
    ride_speed = modes_mod.speed_ms(bus_mode, persona, congestion=congestion)
    ride_min = metres / ride_speed / 60 + passed * transit.DWELL_S / 60
    legs.append(Leg("ride", board.name, alight.name, ride_min, metres, coords))

    if from_stop:
        coords2, metres2, _ = from_stop
        legs.append(Leg("walk", alight.name, "Destination", metres2 / walk_speed / 60, metres2, coords2))

    total_min = sum(l.minutes for l in legs)
    walk_m = sum(l.distance_m for l in legs if l.kind == "walk")

    return {
        "legs": [l.__dict__ for l in legs],
        "board": board.__dict__,
        "alight": alight.__dict__,
        "total_min": round(total_min, 1),
        "walk_m": round(walk_m),
        "ride_m": round(metres),
        "intermediate_stops": passed,
        "headway_min": transit.HEADWAY_MIN,
        "wait_min": round(transit.HEADWAY_MIN / 2, 1),
        # Said plainly and carried all the way to the UI, because a rider who thinks
        # this is a timetable will miss buses by it.
        "schedule_source": "modelled",
        "disclaimer": (
            f"Stops are real OpenStreetMap data{' (PMPML-operated)' if board.operator == 'PMPML' else ''}. "
            f"No PMPML timetable is published for this corridor, so the {transit.HEADWAY_MIN:.0f}-minute "
            "headway and the ride time are modelled, not scheduled."
        ),
    }


def stop_features() -> dict:
    """Every bus stop as GeoJSON, for pinning on the map."""
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": s.id,
                "properties": {
                    "id": s.id, "name": s.name, "operator": s.operator,
                    "shelter": s.shelter, "source": s.source,
                },
                "geometry": {"type": "Point", "coordinates": [s.lon, s.lat]},
            }
            for s in transit.stops()
        ],
    }
