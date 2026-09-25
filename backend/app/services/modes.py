"""How someone is travelling — separate from who they are.

Persona answers "how does heat affect this body" (risk weights, vulnerability shift,
rest needs). Mode answers "what are they on" (speed, which streets are usable, how
much of the sun actually lands on them). They were conflated: `cyclist` and
`gig_worker` were personas carrying vehicle speeds, so a senior could not take a bus
and a student could not check whether driving was cooler.

The two now compose. A senior on a bike keeps a senior's vulnerability and a bike's
speed and exposure.

`heat_exposure` is the one that does the real work in routing. A walker takes the
full radiant load and will cross the road for shade; a driver is in a box and will
not detour a kilometre for a tree. Costing every mode as if it were a pedestrian is
what would make a car route absurd.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# Classes no motor vehicle can legally or physically use.
_NO_MOTOR = frozenset({"footway", "path", "steps", "pedestrian", "track", "bridleway", "cycleway"})
# Buses additionally keep off service lanes and unpaved tracks: PMPML runs the
# through-roads and residential streets, not campus access lanes.
_NO_BUS = _NO_MOTOR | {"service"}


@dataclass(frozen=True)
class Mode:
    key: str
    label: str
    speed_ms: float | None
    """None means the persona's own walking pace — a senior walks slower than a student."""
    heat_exposure: float
    """0..1 multiplier on the heat/sun penalty. 1 = fully in the weather."""
    shady_side: bool
    """Whether the traveller can hug the shaded kerb. Vehicles sit in the carriageway."""
    exertion: float = 1.0
    """Metabolic load relative to walking. Cycling is harder; sitting in a car is not."""
    forbidden_highways: frozenset[str] = field(default_factory=frozenset)
    transit: bool = False
    note: str = ""


MODES: dict[str, Mode] = {
    "walk": Mode(
        key="walk", label="Walk", speed_ms=None, heat_exposure=1.0, shady_side=True, exertion=1.0,
        note="Full radiant load, and free to cross to the shaded side of the street.",
    ),
    "cycle": Mode(
        key="cycle", label="Cycle", speed_ms=4.2, heat_exposure=0.92, shady_side=False, exertion=1.25,
        # A bicycle is allowed on a footway only where OSM says so; the graph carries
        # that as a per-road `bikeable` flag, which is finer than a class list.
        forbidden_highways=frozenset({"steps"}),
        note="Exposed, but self-generated airflow offsets a little of the load.",
    ),
    "bike": Mode(
        key="bike", label="Bike", speed_ms=7.5, heat_exposure=0.82, shady_side=False, exertion=0.35,
        forbidden_highways=_NO_MOTOR,
        note="Pune's two-wheeler: exposed to the sun, quicker through traffic than a car.",
    ),
    "car": Mode(
        key="car", label="Car", speed_ms=6.9, heat_exposure=0.15, shady_side=False, exertion=0.1,
        forbidden_highways=_NO_MOTOR,
        # Not zero: a cabin parked on radiant asphalt in stopped traffic is a real
        # heat load, and pretending otherwise would rank every car route identically.
        note="Enclosed — heat still matters in stopped traffic, but shade barely changes the trip.",
    ),
    "bus": Mode(
        key="bus", label="Bus", speed_ms=5.6, heat_exposure=0.55, shady_side=True, exertion=0.4,
        forbidden_highways=_NO_BUS, transit=True,
        # The average hides the structure: the walk to the stop and the wait are fully
        # exposed, the ride is not. transit_routing costs those legs separately; this
        # figure is only the fallback for whole-trip summaries.
        note="Walking and waiting are in the sun; the ride is not.",
    ),
}

DEFAULT_MODE = "walk"

#: Two-wheelers and cars are quicker than a walk but they do not fly. Pune's
#: arterials run congested for most of the day, so a mode's free speed is scaled by
#: the same modelled congestion curve the anthropogenic heat term already uses.
CONGESTION_SENSITIVITY = {"walk": 0.0, "cycle": 0.15, "bike": 0.45, "car": 0.75, "bus": 0.8}


def get(key: str | None) -> Mode:
    if not key:
        return MODES[DEFAULT_MODE]
    if key not in MODES:
        raise ValueError(f"unknown travel mode '{key}'")
    return MODES[key]


def speed_ms(mode: Mode, persona: dict, congestion: float = 0.0) -> float:
    """Effective speed for this mode, in m/s.

    `congestion` is 0..1 from the traffic model. It slows a car far more than a
    two-wheeler — which is why Pune commutes on two wheels — and a walker not at all.
    """
    base = mode.speed_ms if mode.speed_ms is not None else persona["speed_ms"]
    k = CONGESTION_SENSITIVITY.get(mode.key, 0.0)
    # Halve at most: even a jam clears eventually, and a speed that trends to zero
    # produces ETAs no one would believe.
    return base * (1.0 - 0.5 * k * max(0.0, min(1.0, congestion)))


def table() -> dict:
    """Mode catalogue for /api/meta, so the client never hard-codes this list."""
    return {
        "default": DEFAULT_MODE,
        "modes": [
            {
                "key": m.key,
                "label": m.label,
                "speed_kmh": round(m.speed_ms * 3.6, 1) if m.speed_ms is not None else None,
                "speed_from_persona": m.speed_ms is None,
                "heat_exposure": m.heat_exposure,
                "shady_side": m.shady_side,
                "exertion": m.exertion,
                "transit": m.transit,
                "note": m.note,
            }
            for m in MODES.values()
        ],
    }
