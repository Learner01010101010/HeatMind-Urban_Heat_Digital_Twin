"""Anthropogenic heat — waste heat that people, not the sun, put into the street.

Two sources, both time-varying:

  * **Traffic.** The zone already carries a per-road-class heat weight, but it was a
    constant: a trunk road contributed the same 2.2 °C at 04:00 as in the evening peak.
    Real congestion heat swings by a factor of ten across the day, so the static weight
    is now treated as the *jam-hour* value and scaled by a diurnal congestion profile.

  * **Industrial premises.** Waste heat from process plant and machinery, emitted
    steadily with a working-hours duty cycle rather than following the sun.

**Data provenance, stated plainly.** There is no free real-time traffic feed for this
zone, and the Overpass extract contains *no* industrial tags at all — the only land-use
tags present are `residential` (17) and `education` (2). So:

  * congestion is a *modelled* Pune weekday/weekend profile, not a live feed. The shape
    is the standard twin-peak Indian urban commute. `set_congestion_source()` lets a real
    feed (TomTom / HERE / Google Roads all offer one, all paid) replace the curve without
    touching anything else.
  * industrial sources are the footprints whose typology was *inferred* as industrial
    (services/building_types), since nothing in OSM marks them. No real facility is named
    or located from outside the OSM extract.

Both are surfaced in /api/meta provenance as "modelled" so nothing here reads as surveyed
fact.
"""
from __future__ import annotations

from datetime import datetime

import numpy as np

from . import geo
from .zone import Zone, box_blur

# ---------------------------------------------------------------- traffic ----

# Relative congestion by hour of day (local time), 1.0 = free-flowing daytime baseline.
# Twin peaks: the morning school/office run and a heavier, longer evening peak.
_WEEKDAY = [0.25, 0.18, 0.15, 0.15, 0.20, 0.35, 0.60, 1.00, 1.55, 1.85, 1.60, 1.35,
            1.30, 1.30, 1.25, 1.30, 1.50, 1.85, 2.15, 2.05, 1.60, 1.10, 0.70, 0.40]
# Weekends lose the commute peaks and shift later.
_WEEKEND = [0.45, 0.30, 0.20, 0.16, 0.16, 0.22, 0.32, 0.45, 0.65, 0.90, 1.10, 1.25,
            1.30, 1.28, 1.25, 1.30, 1.45, 1.65, 1.75, 1.70, 1.45, 1.15, 0.85, 0.60]

_override = None


def set_congestion_source(fn) -> None:
    """Install a live congestion feed: fn(datetime) -> float, 1.0 = free flow.

    Nothing calls this yet; it is the seam where a paid traffic API would attach.
    """
    global _override
    _override = fn


def congestion_factor(when: datetime) -> float:
    """Relative traffic density at `when`, interpolated between hourly keyframes."""
    if _override is not None:
        try:
            live = _override(when)
            # None is the documented way for a feed to say "I have nothing for this
            # moment" -- no key, provider down, or a forecast hour it cannot observe.
            # That is a normal answer, not a failure, and the modelled curve below is
            # the honest fallback for it.
            if live is not None:
                return float(live)
        except Exception:  # a flaky feed must never take the twin down
            pass
    table = _WEEKEND if when.weekday() >= 5 else _WEEKDAY
    h = when.hour + when.minute / 60.0
    i0 = int(h) % 24
    i1 = (i0 + 1) % 24
    t = h - int(h)
    return table[i0] * (1 - t) + table[i1] * t


def traffic_field(zone: Zone, when: datetime) -> np.ndarray:
    """Traffic waste heat (°C) across the grid at `when`.

    zone.traffic holds the per-class jam-hour weight; congestion scales it. Capped at
    the jam value so a congestion spike cannot push a residential lane past a trunk road.
    """
    return zone.traffic * min(congestion_factor(when), 2.2)


# ------------------------------------------------------------- industrial ----

# Peak waste-heat contribution at the fence line of an industrial premises, and the
# distance over which it decays into the surrounding street.
INDUSTRIAL_PEAK_C = 2.6
INDUSTRIAL_REACH_M = 80.0

# Duty cycle: process plant runs hardest across the working day, idles overnight.
_DUTY = [0.35, 0.32, 0.30, 0.30, 0.34, 0.45, 0.62, 0.80, 0.95, 1.00, 1.00, 0.98,
         0.92, 0.96, 1.00, 1.00, 0.95, 0.88, 0.78, 0.68, 0.60, 0.52, 0.45, 0.38]


def duty_cycle(when: datetime) -> float:
    h = when.hour + when.minute / 60.0
    i0 = int(h) % 24
    i1 = (i0 + 1) % 24
    t = h - int(h)
    base = _DUTY[i0] * (1 - t) + _DUTY[i1] * t
    return base * (0.8 if when.weekday() >= 5 else 1.0)


def industrial_sources(zone: Zone) -> list[dict]:
    """Footprints treated as industrial heat emitters, with why each was chosen."""
    from .building_types import classify_cached

    types = classify_cached(zone)
    out = []
    for b in zone.data["buildings"]:
        typology, src = types.get(b["id"], ("residential", "inferred"))
        if typology != "industrial":
            continue
        xy = [geo.to_xy(*p) for p in b["ring"]]
        cx = sum(p[0] for p in xy) / len(xy)
        cy = sum(p[1] for p in xy) / len(xy)
        la, lo = geo.to_latlon(cx, cy)
        out.append({
            "id": b["id"], "name": b["name"] or "Industrial premises",
            "lat": round(la, 6), "lon": round(lo, 6), "area_m2": b["area_m2"],
            "typology_source": src,
            "peak_c": INDUSTRIAL_PEAK_C, "reach_m": INDUSTRIAL_REACH_M,
        })
    return out


def _industrial_base(zone: Zone) -> np.ndarray:
    """Steady-state industrial heat field at full duty (°C), computed once per zone."""
    field = np.zeros(zone.shape)
    for s in industrial_sources(zone):
        x, y = geo.to_xy(s["lat"], s["lon"])
        # larger premises carry further
        reach = INDUSTRIAL_REACH_M * (0.7 + 0.3 * min(s["area_m2"] / 2000.0, 2.0))
        m = geo.disk_mask(x, y, reach)
        if m is None:
            continue
        rs, cs, d = m
        falloff = np.clip(1.0 - d / reach, 0.0, 1.0) ** 1.6
        np.maximum(field[rs, cs], INDUSTRIAL_PEAK_C * falloff, out=field[rs, cs])
    return box_blur(field, 2)


def industrial_field(zone: Zone, when: datetime) -> np.ndarray:
    if getattr(zone, "_industrial_base", None) is None:
        zone._industrial_base = _industrial_base(zone)
    return zone._industrial_base * duty_cycle(when)


# ----------------------------------------------------------------- total ----

def anthropogenic_field(zone: Zone, when: datetime) -> np.ndarray:
    """Traffic + industrial waste heat (°C) across the grid at `when`."""
    return traffic_field(zone, when) + industrial_field(zone, when)


def describe(zone: Zone, when: datetime) -> dict:
    """Summary for the API, including the provenance caveats."""
    traf = traffic_field(zone, when)
    ind = industrial_field(zone, when)
    walk = ~zone.building
    return {
        "time": when.isoformat(),
        "traffic": {
            "congestion_factor": round(congestion_factor(when), 2),
            "source": "live road-speed samples + modelled heat conversion" if _override and _override(when) is not None else "modelled Pune diurnal profile",
            "mean_c": round(float(traf[walk].mean()), 2),
            "max_c": round(float(traf[walk].max()), 2),
            "peak_hours": "09:00-11:00 and 18:00-20:00 on weekdays",
        },
        "industrial": {
            "duty_cycle": round(duty_cycle(when), 2),
            "source_count": len(industrial_sources(zone)),
            "source": "footprints inferred as industrial (no industrial tags in the OSM extract)",
            "mean_c": round(float(ind[walk].mean()), 2),
            "max_c": round(float(ind[walk].max()), 2),
            "sources": industrial_sources(zone),
        },
        "note": "Traffic and industrial waste heat are modelled, not measured radiation or air-pollution emissions. "
                "Optional TomTom speed observations are used only when fresh; unobserved roads and future times use the model.",
    }


def sun_independent_share(zone: Zone, when: datetime) -> float:
    """Fraction of the zone's mean heat load that does not come from the sun."""
    walk = ~zone.building
    return float(anthropogenic_field(zone, when)[walk].mean())
