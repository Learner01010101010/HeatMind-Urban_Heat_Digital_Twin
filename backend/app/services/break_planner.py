"""Where to drink and where to rest, worked out from the walk itself.

The twin already knows, metre by metre, how hot a route feels, how much of it is in
direct sun, and how humid the air is. That is enough to say something more useful
than "there is a tap near your route": it is enough to say when this particular
person, walking at this particular pace, in today's heat, will have sweated out
enough to need a drink -- and whether there is anywhere to get one at that point.

Two separate needs, because they have different physiology:

  fluid    Sweat rate rises with air temperature and with direct solar load, and
           with how hard the person is working. Published rates for walking in the
           heat run from about 0.4 L/h in comfortable shade to 2 L/h in full sun at
           40 C, and the model below stays inside that envelope. A stop is called
           every time the accumulated loss passes SIP_ML, because drinking 250 ml
           at a time is what the body can actually absorb -- waiting until you are
           two litres down and then drinking two litres does not work.

  rest     Humidity does not change how much you sweat so much as how much good it
           does: at 85% relative humidity sweat drips off instead of evaporating,
           so the same sweat rate buys far less cooling and heat accumulates in the
           body. Rest breaks are therefore driven by heat strain divided by
           evaporative efficiency, which is why a muggy 34 C day calls for more
           stops than a dry 38 C one.

Nothing here invents a water source. If the physiology says drink and there is no
tap within reach, the stop is still reported, marked as having no source, and the
advice becomes "carry water for this stretch" -- which is the true answer, and also
the most useful thing the map can say about the parts of this city that have no
public water at all.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta

import numpy as np

from .risk_scoring import CAUTION_C, PERSONAS

# Sweat model, mL/min. Baseline is moderate walking in comfortable shade; the heat
# and sun terms take it up to roughly 1.8 L/h at 40 C in full sun, which is the top
# of the range healthy adults sustain.
SWEAT_BASE_ML_MIN = 6.0
SWEAT_PER_C = 0.85          # per °C of felt temperature above the comfort point
SWEAT_COMFORT_C = 26.0
SWEAT_SUN_ML_MIN = 4.5      # full direct sun at peak intensity

# How much fluid to take at one stop. Absorption, not thirst, sets this.
SIP_ML = 250.0
# Never call two drink stops closer together than this; sipping every 200 m is not
# advice anyone can follow.
MIN_DRINK_GAP_M = 350.0

# Heat strain between rest breaks, in °C·min above caution, divided by evaporative
# efficiency. Scaled per persona by daily_budget_min.
REST_STRAIN_BUDGET = 190.0
REST_MINUTES = 5.0
MIN_REST_GAP_M = 600.0

# How far off the route is worth walking for a tap.
MAX_DETOUR_M = 130.0
# ...and how far along the route a stop may be shifted to reach one.
MAX_SHIFT_M = 400.0

WATER_TYPES = ("water", "cooling_center")
REST_TYPES = ("rest", "shade", "cooling_center")

# Only points OpenStreetMap actually maps are ever offered as somewhere to stop.
# The zone file also carries 2,004 seeded POIs -- clearly labelled as such, and fine
# as a demonstration layer -- but sending a dehydrated person to a water kiosk that
# does not exist is the one failure mode this feature must not have.
REAL_SOURCE = "osm"

# What kind of water it actually is, from the OSM amenity behind the point. This
# corridor has exactly three mapped public taps, so most of the time the honest
# answer is "a shop that will sell you a bottle", and the advice says so.
TAP_DETAILS = frozenset({"drinking_water", "water_point", "fountain"})
INDOOR_DETAILS = frozenset({"hospital", "clinic", "doctors", "pharmacy", "library",
                            "community_centre", "townhall", "place_of_worship"})


def water_kind(poi: dict) -> str:
    d = (poi.get("detail") or "").lower()
    if d in TAP_DETAILS:
        return "tap"
    if d in INDOOR_DETAILS:
        return "indoor"
    return "buy"


def evaporative_efficiency(rh: float) -> float:
    """How much of the sweat produced actually evaporates and cools.

    Sweat only cools by evaporating. As the air approaches saturation that becomes
    progressively harder, and beyond about 75% relative humidity a large share of it
    simply runs off. Bounded below because air movement never lets it reach zero.
    """
    return float(min(1.0, max(0.35, 1.15 - rh / 100.0)))


def sweat_ml_per_min(feels_c: np.ndarray, exposure: np.ndarray, intensity: float,
                     pace_factor: float) -> np.ndarray:
    heat = SWEAT_PER_C * np.clip(feels_c - SWEAT_COMFORT_C, 0, None)
    sun = SWEAT_SUN_ML_MIN * np.clip(exposure, 0, 1) * max(0.0, min(1.0, intensity))
    return (SWEAT_BASE_ML_MIN + heat + sun) * (0.7 + 0.6 * pace_factor)


def plan(*, persona: str, minutes: np.ndarray, cum_m: np.ndarray, feels: np.ndarray,
         exposure: np.ndarray, intensity: float, rh: float, along: list[dict],
         total_m: float, depart: datetime) -> dict:
    """Hydration and rest stops for one route.

    `minutes` is per-piece walking time, `cum_m` the distance at each piece's middle,
    and `feels`/`exposure` the conditions there at the time the walker arrives.
    """
    P = PERSONAS[persona]
    eff = evaporative_efficiency(rh)
    speed = P["speed_ms"]

    sweat = sweat_ml_per_min(feels + P["vulnerability_shift_c"], exposure, intensity,
                             P["pace_factor"]) * minutes
    total_ml = float(sweat.sum())

    # Heat strain, discounted by how well sweating is working today.
    strain = minutes * np.clip(feels + P["vulnerability_shift_c"] - CAUTION_C, 0, None) / eff
    # A person with a 20-minute daily heat budget needs stopping sooner than one with 90.
    rest_budget = REST_STRAIN_BUDGET * max(0.35, P["daily_budget_min"] / 60.0)

    water_pois = [p for p in along if p.get("type") in WATER_TYPES
                  and p.get("source") == REAL_SOURCE
                  and p.get("off_route_m", 0) <= MAX_DETOUR_M]
    rest_pois = [p for p in along if p.get("type") in REST_TYPES
                 and p.get("source") == REAL_SOURCE
                 and p.get("off_route_m", 0) <= MAX_DETOUR_M]
    taps = [p for p in water_pois if water_kind(p) == "tap"]

    stops: list[dict] = []
    acc_ml = 0.0
    acc_strain = 0.0
    last_drink_m = -math.inf
    last_rest_m = -math.inf

    for i in range(len(minutes)):
        acc_ml += float(sweat[i])
        acc_strain += float(strain[i])
        at = float(cum_m[i])

        if acc_ml >= SIP_ML and at - last_drink_m >= MIN_DRINK_GAP_M:
            stops.append(_stop("water", at, acc_ml, water_pois, P, depart, cum_m, minutes, i,
                               feels[i], exposure[i], eff, rh))
            last_drink_m = stops[-1]["at_m"]
            acc_ml = 0.0
        if acc_strain >= rest_budget and at - last_rest_m >= MIN_REST_GAP_M:
            stops.append(_stop("rest", at, acc_ml, rest_pois, P, depart, cum_m, minutes, i,
                               feels[i], exposure[i], eff, rh))
            last_rest_m = stops[-1]["at_m"]
            acc_strain = 0.0

    stops.sort(key=lambda s: s["at_m"])
    stops = _merge_colocated(stops)

    # Longest stretch with no water source reachable. This is the number that says
    # whether a route is survivable without carrying your own.
    xs = [0.0] + [p["at_m"] for p in water_pois] + [total_m]
    dry_gap = max((b - a for a, b in zip(xs[:-1], xs[1:])), default=total_m)

    return {
        "stops": stops,
        "total_fluid_ml": round(total_ml),
        "fluid_per_hour_ml": round(total_ml / max(float(minutes.sum()) / 60.0, 1e-6)),
        "humidity_pct": round(rh),
        "evaporative_efficiency": round(eff, 2),
        "longest_dry_stretch_m": round(dry_gap),
        "longest_dry_stretch_min": round(dry_gap / speed / 60, 1),
        "water_sources_on_route": len(water_pois),
        "public_taps_on_route": len(taps),
        "carry_water": dry_gap > 1200 or not water_pois,
        "note": ("Sweat loss is modelled from felt temperature, direct sun and pace; "
                 "rest intervals additionally account for how little of that sweat "
                 "evaporates at today's humidity. No water source is invented — where "
                 "a stop shows none, OpenStreetMap maps none within "
                 f"{MAX_DETOUR_M:.0f} m of the route. Seeded demonstration points are "
                 "excluded entirely."),
    }


# Two stops within this distance are the same stop: drink and rest at the same bench.
MERGE_M = 60.0


def _merge_colocated(stops: list[dict]) -> list[dict]:
    """Fold a drink and a rest called at the same place into one stop.

    The two needs are computed independently, so a shaded library that triggers both
    would otherwise put two pins on the same doorstep and read as a bug.
    """
    out: list[dict] = []
    for s in stops:
        prev = out[-1] if out else None
        same_poi = (prev and prev.get("poi") and s.get("poi")
                    and prev["poi"].get("id") == s["poi"].get("id"))
        if prev and (same_poi or abs(prev["at_m"] - s["at_m"]) <= MERGE_M):
            prev["type"] = "water+rest" if prev["type"] != s["type"] else prev["type"]
            prev["fluid_ml"] = max(prev["fluid_ml"], s["fluid_ml"])
            prev["rest_min"] = max(prev["rest_min"], s["rest_min"])
            if not prev["has_source"] and s["has_source"]:
                for k in ("lat", "lon", "poi", "has_source", "at_m", "eta", "eta_min"):
                    prev[k] = s[k]
            if prev["fluid_ml"] and prev["rest_min"]:
                prev["advice"] = (f"Drink about {prev['fluid_ml']:.0f} ml and take "
                                  f"{prev['rest_min']:.0f} minutes out of the sun here.")
            continue
        out.append(s)
    return out


def _stop(kind: str, at_m: float, acc_ml: float, pois: list[dict], P: dict,
          depart: datetime, cum_m: np.ndarray, minutes: np.ndarray, i: int,
          feels_c: float, exposure: float, eff: float, rh: float) -> dict:
    """One stop, snapped to the nearest usable POI if there is one in reach."""
    poi = None
    best = MAX_SHIFT_M
    for p in pois:
        d = abs(p["at_m"] - at_m)
        if d < best:
            best, poi = d, p
    placed = float(poi["at_m"]) if poi else at_m

    eta_min = float(minutes[:i + 1].sum())
    if poi:
        # Walking to a real tap shifts the clock a little.
        eta_min += (placed - at_m) / max(P["speed_ms"], 0.1) / 60.0

    if kind == "water":
        if poi:
            k = water_kind(poi)
            where = {"tap": "Public drinking water — refill here.",
                     "indoor": "Open to the public and usually air-conditioned — "
                               "ask inside for water.",
                     "buy": "No public tap here; this is a shop or café where you "
                            "can buy a bottle."}[k]
            advice = f"Drink about {SIP_ML:.0f} ml. {where}"
        else:
            advice = (f"You will be about {acc_ml:.0f} ml down here and OpenStreetMap "
                      f"maps nothing within {MAX_DETOUR_M:.0f} m — carry water for "
                      "this stretch.")
    else:
        advice = (f"Take {REST_MINUTES:.0f} minutes out of the sun here."
                  if poi else
                  "Heat is accumulating faster than you are shedding it — find shade "
                  "and stop for five minutes.")

    return {
        "type": kind,
        "at_m": round(placed),
        "eta_min": round(max(0.0, eta_min), 1),
        "eta": (depart + timedelta(minutes=max(0.0, eta_min))).isoformat(),
        "lat": poi["lat"] if poi else None,
        "lon": poi["lon"] if poi else None,
        "poi": ({"id": poi.get("id"), "name": poi.get("name"), "type": poi.get("type"),
                 "detail": poi.get("detail"), "water_kind": water_kind(poi),
                 "source": poi.get("source"), "off_route_m": poi.get("off_route_m")}
                if poi else None),
        "has_source": poi is not None,
        "fluid_ml": round(SIP_ML) if kind == "water" else 0,
        "rest_min": REST_MINUTES if kind == "rest" else 0,
        "feels_c": round(float(feels_c), 1),
        "exposure": round(float(exposure), 2),
        "why": (f"{'In full sun' if exposure > 0.6 else 'Partly shaded' if exposure > 0.3 else 'In shade'}, "
                f"feels {feels_c:.0f}°C, humidity {rh:.0f}% — "
                f"only {eff * 100:.0f}% of your sweat is evaporating."),
        "advice": advice,
    }
