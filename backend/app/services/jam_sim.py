"""A simulated traffic jam, for demonstrating live rerouting on demand.

Real congestion arrives from TomTom through `traffic.route_field`, and only when a
key is configured and the sample lands near the route. That makes the rerouting
behaviour impossible to show on cue. This module injects a jam into the same
traffic field the router already consumes, so nothing downstream has a special
case for it: travel times, the congestion routing penalty, candidate generation
and the "Road traffic" factor in the route checks all respond exactly as they
would to a real reading.

Everything here is explicitly a simulation. The pieces it touches are marked
`simulated`, never `live`, so no simulated value can be reported as an observation.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import geo

# A jam covers a stretch of road, not a point. 180 m is about a city block, which
# is wide enough to make the corridor genuinely unattractive without blanketing the
# alternatives one street over.
DEFAULT_RADIUS_M = 180.0
# Stop-start crawl rather than a closure. A closure would trip the blunt "road
# closed" branch and reroute on a rule; a jam makes the optimiser reroute on the
# merits, which is both the honest demonstration and the interesting one.
DEFAULT_SPEED_MS = 1.4  # ~5 km/h
DEFAULT_SEVERITY = 0.95
# How far along the remaining route to put it: far enough ahead that a detour is
# still possible, near enough that it is obviously on the user's path.
AHEAD_M = 250.0


@dataclass(frozen=True)
class Jam:
    lat: float
    lon: float
    radius_m: float = DEFAULT_RADIUS_M
    severity: float = DEFAULT_SEVERITY
    speed_ms: float = DEFAULT_SPEED_MS

    def as_dict(self) -> dict:
        return {"lat": self.lat, "lon": self.lon, "radius_m": self.radius_m,
                "severity": round(self.severity, 2), "speed_kmh": round(self.speed_ms * 3.6, 1),
                "source": "simulated"}


def ahead_on(graph, path, metres: float = AHEAD_M) -> Jam | None:
    """Put a jam on the road the traveller is about to reach.

    Walks the remaining path until `metres` of it have been covered, so the jam
    lands on the route rather than near it, and behind the traveller is never an
    option.
    """
    if path is None:
        return None
    pieces, _ = graph.path_pieces(path)
    if not len(pieces):
        return None
    lengths = graph.p_len[pieces]
    reached = np.cumsum(lengths)
    index = int(np.searchsorted(reached, min(metres, reached[-1] * 0.8)))
    index = min(index, len(pieces) - 1)
    lat, lon = geo.to_latlon(*graph.p_mid[pieces[index]])
    return Jam(lat=float(lat), lon=float(lon))


def apply(graph, field: dict, jam: Jam | None) -> dict:
    """Stamp the jam onto a traffic field, in place.

    Marked `simulated` rather than `live`. `traffic_times` and the congestion
    penalty both read the `live` flag, so the flag has to be set for the jam to
    bite — which is why `simulated` is carried alongside it rather than instead of
    it, and why every response that contains one says so.
    """
    if jam is None:
        return field
    x, y = geo.to_xy(jam.lat, jam.lon)
    within = np.linalg.norm(graph.p_mid - np.array([x, y]), axis=1) <= jam.radius_m
    if "simulated" not in field:
        field["simulated"] = np.zeros(len(graph.p_len), bool)
    if not within.any():
        return field
    field["congestion"][within] = jam.severity
    field["speed_ms"][within] = jam.speed_ms
    field["live"][within] = True
    field["simulated"][within] = True
    field["observed_at"] = None
    return field


def pieces_hit(graph, path, jam: Jam | None) -> int:
    """How much of a path the jam actually sits on, for reporting."""
    if jam is None or path is None:
        return 0
    pieces, _ = graph.path_pieces(path)
    if not len(pieces):
        return 0
    x, y = geo.to_xy(jam.lat, jam.lon)
    return int((np.linalg.norm(graph.p_mid[pieces] - np.array([x, y]), axis=1) <= jam.radius_m).sum())
