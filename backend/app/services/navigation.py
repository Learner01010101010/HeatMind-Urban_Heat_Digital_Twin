"""Turn-by-turn steps for a planned route.

Derived from the route's own display segments rather than re-walking the graph: the
segments already carry the road name, the coordinates and the per-keyframe sun
exposure, which means a step can say both "turn left onto Katraj-Dehu Road" and "that
stretch is in full sun" without a second pass over the network.

Only the second half of that is unusual, and it is the point. A navigation app tells
you where to turn; this one is routing you through shade, so a step that does not
carry its own exposure would hide the reason the turn exists.
"""
from __future__ import annotations

import math

# Turn classification by signed heading change, degrees. The bands are the usual
# navigation ones; "continue" covers the drift of a curving road so a bend in a single
# street does not generate a turn instruction every 24 metres.
STRAIGHT = 22.0
SLIGHT = 55.0
SHARP = 135.0
UTURN = 165.0

#: Stretches shorter than this are folded into their neighbour rather than becoming
#: their own instruction. About five seconds at walking pace.
MIN_STEP_M = 35.0


def bearing_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Initial great-circle bearing from a to b, degrees clockwise from north."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlon = math.radians(b[1] - a[1])
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _delta(from_deg: float, to_deg: float) -> float:
    """Signed heading change in (-180, 180]: positive is a right turn."""
    d = (to_deg - from_deg + 540.0) % 360.0 - 180.0
    return d


def _maneuver(delta: float) -> str:
    a = abs(delta)
    if a >= UTURN:
        return "uturn"
    side = "right" if delta > 0 else "left"
    if a < STRAIGHT:
        return "straight"
    if a < SLIGHT:
        return f"slight-{side}"
    if a < SHARP:
        return side
    return f"sharp-{side}"


def _phrase(maneuver: str, road: str, first: bool) -> str:
    if first:
        return f"Head off along {road}"
    if maneuver == "straight":
        return f"Continue onto {road}"
    if maneuver == "uturn":
        return f"Make a U-turn onto {road}"
    words = {
        "left": "Turn left onto", "right": "Turn right onto",
        "slight-left": "Bear left onto", "slight-right": "Bear right onto",
        "sharp-left": "Sharp left onto", "sharp-right": "Sharp right onto",
    }
    return f"{words[maneuver]} {road}"


def steps_from_segments(segments: list[dict], total_m: float, speed_ms: float,
                        offset_index: int = 0) -> list[dict]:
    """Group display segments into named stretches and label each transition.

    `offset_index` selects which forecast keyframe's exposure to report; 0 is
    departure. The exposure travels with the step so the HUD can warn about the sun
    on the next stretch before the walker is standing in it.
    """
    if not segments:
        return []

    # Group consecutive segments sharing a road name. A name change is the signal for
    # a step; a geometric bend within one named road is not.
    groups: list[list[dict]] = []
    for seg in segments:
        if groups and groups[-1][0]["name"] == seg["name"]:
            groups[-1].append(seg)
        else:
            groups.append([seg])

    # Fold away stretches too short to be an instruction. A named road crossing an
    # unnamed junction for 24 m produces two spurious turns ("continue onto the link
    # road", then straight back) that a driver has no time to act on and a walker
    # would not recognise. Real navigation collapses these; so does this.
    merged: list[list[dict]] = []
    for group in groups:
        length = sum(s["length_m"] for s in group)
        if merged and length < MIN_STEP_M:
            merged[-1].extend(group)
        else:
            merged.append(group)
    # A short *first* stretch cannot fold backwards, so fold it forwards instead.
    if len(merged) > 1 and sum(s["length_m"] for s in merged[0]) < MIN_STEP_M:
        merged[1][:0] = merged[0]
        merged.pop(0)
    groups = merged

    def head(group: list[dict]) -> float:
        c = group[0]["coords"]
        return bearing_deg(tuple(c[0]), tuple(c[min(1, len(c) - 1)]))

    def tail(group: list[dict]) -> float:
        c = group[-1]["coords"]
        return bearing_deg(tuple(c[max(0, len(c) - 2)]), tuple(c[-1]))

    def road_name(group: list[dict]) -> str:
        """The name of the longest run in the group.

        After folding, a group can start with the short stretch that was absorbed --
        naming the step after it would label a 600 m run on Sinhgad Institute Road by
        the 20 m of link road at its head.
        """
        by_name: dict[str, float] = {}
        for seg in group:
            by_name[seg["name"]] = by_name.get(seg["name"], 0.0) + seg["length_m"]
        return max(by_name, key=lambda k: by_name[k])

    steps: list[dict] = []
    for i, group in enumerate(groups):
        length = sum(s["length_m"] for s in group)
        name = road_name(group)
        start_m = group[0]["start_m"]
        if i == 0:
            maneuver, delta = "depart", 0.0
        else:
            delta = _delta(tail(groups[i - 1]), head(group))
            maneuver = _maneuver(delta)

        # Distance-weighted exposure over the stretch: one number for "how much sun is
        # on this next bit", on the same 0..1 scale the shadow engine produces.
        wsum = sum(s["length_m"] for s in group) or 1.0
        idx = min(offset_index, len(group[0]["exposure"]) - 1)
        exposure = sum(s["exposure"][idx] * s["length_m"] for s in group) / wsum
        feels = sum(s["feels"][idx] * s["length_m"] for s in group) / wsum

        coords: list[list[float]] = []
        for s in group:
            coords.extend(s["coords"] if not coords else s["coords"][1:])

        steps.append({
            "index": i,
            "maneuver": "depart" if i == 0 else maneuver,
            "turn_deg": round(delta, 1),
            "road": name,
            "instruction": _phrase(maneuver if i else "straight", name, first=i == 0),
            "distance_m": round(length),
            "start_m": round(start_m),
            "duration_min": round(sum(s.get("duration_seconds", s["length_m"] / speed_ms) for s in group) / 60, 1),
            "exposure": round(exposure, 2),
            "feels_c": round(feels, 1),
            "surface": group[0]["surface"],
            "coords": [[round(a, 6), round(b, 6)] for a, b in coords],
        })

    if steps:
        last = steps[-1]
        last["instruction"] = f"{last['instruction']} — arrive at your destination"
        last["arrival"] = True
        # The final stretch runs to the end of the route, whatever rounding the
        # segment lengths accumulated along the way.
        last["distance_m"] = max(0, round(total_m) - last["start_m"])
    return steps
