"""Isolated planning tools. Never mutate the twin or route state."""
from __future__ import annotations

import math
import time

import numpy as np

from . import geo
from .heat_twin_service import get_twin
from .weather import base_time
from .zone import SURFACES

AREAS = {
    "narhe": ("Narhe · campus neighbourhood", 18.4427, 73.8318),
    "katraj": ("Katraj · Bharati Vidyapeeth", 18.4537, 73.8563),
    "swargate": ("Swargate · transport hub", 18.5007, 73.8586),
}

# Unit costs.
#
# These are published reference figures, not vendor quotations, and each one
# carries the arithmetic that produced it so a reader can disagree with the
# assumption rather than the number. They remain editable in the UI.
KINDS = {
    "trees": {
        "label": "Mature tree canopy",
        "cost": 8000,
        "color": "#8ad8b0",
        "basis": "Avenue tree plantation runs ₹2-5 lakh per km; at ~8 m spacing that is "
                 "~125 trees per km per side, so ₹1,600-4,000 per established tree. This "
                 "patch is one to two mature trees at the upper end, which covers a large "
                 "specimen, a guard and the first years of maintenance.",
        "source": "Industry avenue-plantation rates (₹2-5 lakh/km); Grow Billion Trees planting "
                  "and site-preparation rates",
    },
    "cool_pavement": {
        "label": "Cool pavement patch",
        "cost": 48000,
        "color": "#a9d7fa",
        "basis": "Heat-reflective pavement coating sells at ₹1,500-2,500 per 20 L. At roughly "
                 "1 L/m² for two coats on a rough surface that is ₹100-125/m². About a "
                 "third of a 20 m radius patch (~1,257 m²) is carriageway or footway, so "
                 "~440 m² of coating.",
        "source": "Indian retail prices for heat-reflective / cool-pavement coatings, 2025-26",
    },
    "shade_structure": {
        "label": "Shade structure",
        "cost": 134000,
        "color": "#d0bdfa",
        "basis": "A municipal bus-queue-shelter estimate — excavation, foundation, brickwork, "
                 "RCC, plaster, flooring and terracing — comes to about ₹1.34 lakh for a "
                 "basic shelter. A street shade structure is the same order of work.",
        "source": "Municipal bus-queue-shelter construction estimate",
    },
    "water_refill": {
        "label": "Water refill proposal",
        "cost": 500000,
        "color": "#77d9f5",
        "basis": "Government e-Marketplace caps drinking-water ATM procurement at ₹5 lakh "
                 "inclusive of taxes. Municipal installations including civil works have run "
                 "higher — Amritsar's 2020 batch worked out near ₹13.5 lakh a unit — so this "
                 "is the procurement ceiling, not a fitted-out price.",
        "source": "GeM procurement ceiling for drinking-water ATMs; municipal installation reports",
    },
}

# What a fix physically needs before it can be proposed at all.
#
# The catalogue used to offer every fix at every hot cell, which meant it would
# cheerfully propose a mature tree on a spot with no ground to put one in. These
# are checked against the same rasters the heat model runs on.
PLANT_RADIUS_M = 20.0
# A mature crown needs real open ground. Four 10 m cells is 400 m2, about the
# footprint of one to two mature trees plus the space around them.
MIN_PLANTABLE_CELLS = 4
# Above this the cell already has canopy; adding more buys little and there is
# probably a tree standing in it.
CANOPY_FULL = 0.6
WATER_CODE = SURFACES["water"][0]

_catalog_cache = {}


def _plantable_mask(tw, lat: float, lon: float, radius_m: float = PLANT_RADIUS_M):
    """Cells inside the patch where a tree could actually be planted.

    Open ground only: no building footprint, no water, not the carriageway
    itself, and not already under canopy.
    """
    z = tw.zone
    x, y = geo.to_xy(lat, lon)
    m = geo.disk_mask(x, y, radius_m)
    if m is None:
        return None, 0
    rs, cs, _ = m
    ok = (
        ~z.building[rs, cs]
        & ~z.road[rs, cs]
        & (z.surface[rs, cs] != WATER_CODE)
        & (z.canopy[rs, cs] < CANOPY_FULL)
    )
    return ok, int(ok.sum())


def _feasibility(tw, lat: float, lon: float) -> dict:
    """Per-kind buildability at a point, with the reason when it fails."""
    _, cells = _plantable_mask(tw, lat, lon)
    area = cells * geo.CELL_M ** 2
    plantable = cells >= MIN_PLANTABLE_CELLS
    return {
        "trees": {
            "ok": plantable,
            "open_ground_m2": area,
            "reason": "" if plantable else (
                f"Only {area:,.0f} m² of plantable open ground inside {PLANT_RADIUS_M:.0f} m — "
                "the patch is built over, paved, water or already under canopy."
            ),
        },
    }




def lab_time(mode):
    now = base_time()
    # A repeatable daytime heatwave demonstration, separate from the live app clock.
    return now.replace(hour=13, minute=30) if mode == "demo" else now.replace(minute=now.minute // 5 * 5)


def catalog(area="narhe", mode="demo"):
    when = lab_time(mode)
    key = area, mode, when.isoformat()
    cached = _catalog_cache.get(key)
    if cached and time.monotonic() - cached[0] < 300:
        return cached[1]
    name, lat, lon = AREAS[area]
    tw = get_twin()
    f = tw.frame(when, mode)
    cx, cy = geo.to_xy(lat, lon)
    roads, candidates, cells = [], [], set()
    for road in tw.zone.data["roads"]:
        points = [[n[1], n[2]] for n in road["nodes"]]
        nearby = [p for p in points if abs(geo.to_xy(*p)[0] - cx) < 520 and abs(geo.to_xy(*p)[1] - cy) < 520]
        if not nearby:
            continue
        roads.append({"name": road["name"], "points": points})
        for p in nearby:
            r, c = geo.latlon_to_cell(*p)
            if (r, c) in cells or not tw.walkable[r, c]:
                continue
            cells.add((r, c))
            # nearest_name resolves the real street, or "near <place>" when the
            # way itself is unnamed, instead of labelling half the candidates
            # "Mapped local street".
            candidates.append((float(f.feels[r, c]), p[0], p[1], tw.nearest_name(r, c)))
    sites = []
    for _, la, lo, street in sorted(candidates, reverse=True):
        # Separate bounding patches as well as the 20 m cooling radii.
        if any(geo.haversine_m((la, lo), (s["lat"], s["lon"])) < 100 for s in sites):
            continue
        choices = {}
        try:
            for kind in KINDS:
                if kind != "water_refill":
                    choices[kind] = tw.simulate_intervention(f, la, lo, kind, 20)
        except ValueError:
            continue
        sample = tw.sample(f, la, lo)
        sites.append({"id": f"site-{len(sites) + 1}", "name": street, "lat": la, "lon": lo,
                      "sample": sample, "before": choices["trees"]["before"], "choices": choices,
                      "feasible": _feasibility(tw, la, lo)})
        if len(sites) == 12:
            break
    if not sites:
        raise ValueError("No mapped walkable candidate sites in this neighbourhood.")
    out = {"area": area, "area_name": name, "mode": mode, "time": when.isoformat(),
           "weather_source": f.weather.source, "center": [lat, lon],
           "bbox": [max(geo.S, lat - 520 / geo.M_PER_DEG_LAT), max(geo.W, lon - 520 / geo.M_PER_DEG_LON),
                    min(geo.N, lat + 520 / geo.M_PER_DEG_LAT), min(geo.E, lon + 520 / geo.M_PER_DEG_LON)],
           "roads": roads[:500], "sites": sites, "kinds": KINDS,
           "note": "Independent 20 m simulations at separated sites; no changes are applied to the "
                   "main twin. Unit costs are published reference figures with their arithmetic "
                   "shown, not vendor quotations, and remain editable. Tree canopy is only offered "
                   "where the rasters show enough open ground to plant it; siting, land permission "
                   "and maintenance still need assessment."}
    if len(_catalog_cache) >= 8:
        _catalog_cache.clear()
    _catalog_cache[key] = time.monotonic(), out
    return out


def _buildable(site, kind) -> tuple[bool, str]:
    """Whether this fix can physically go at this site."""
    check = site.get("feasible", {}).get(kind)
    if check is None:
        return True, ""
    return bool(check["ok"]), check.get("reason", "")


def plan(data, budget, costs, projects=None):
    prices = {k: costs.get(k, v["cost"]) for k, v in KINDS.items()}
    lookup = {s["id"]: s for s in data["sites"]}
    if projects is None:
        # Two stages. The first ranks by relief per rupee, which is the defensible
        # ordering but stops the moment the next-best option does not fit, and can
        # leave most of the budget unspent. The second repeatedly upgrades to the
        # best option that still fits, until nothing does, so the proposal actually
        # allocates the money it was given.
        benefit = {}
        for site in data["sites"]:
            for kind, result in site["choices"].items():
                if not _buildable(site, kind)[0]:
                    continue
                gain = max(0, -result["delta_c"]) * result["cells_affected"] * geo.CELL_M ** 2
                if gain > 0:
                    benefit[site["id"], kind] = gain
        chosen, spent = {}, 0
        for (sid, kind), gain in sorted(benefit.items(), key=lambda kv: kv[1] / prices[kv[0][1]], reverse=True):
            if sid not in chosen and spent + prices[kind] <= budget:
                chosen[sid] = kind
                spent += prices[kind]
        while True:
            best = None
            for (sid, kind), gain in benefit.items():
                have = chosen.get(sid)
                if have == kind:
                    continue
                delta = prices[kind] - (prices[have] if have else 0)
                # An upgrade has to cost something and buy something; a swap that
                # spends more for less relief is not an improvement.
                if delta <= 0 or spent + delta > budget:
                    continue
                if have and gain <= benefit.get((sid, have), 0):
                    continue
                score = (gain - (benefit.get((sid, have), 0) if have else 0)) / delta
                if best is None or score > best[0]:
                    best = (score, sid, kind, delta)
            if best is None:
                break
            _, sid, kind, delta = best
            chosen[sid] = kind
            spent += delta
        projects = [{"site_id": sid, "kind": kind} for sid, kind in chosen.items()]
    selected, seen, spent = [], set(), 0
    for item in projects:
        sid, kind = item["site_id"], item["kind"]
        if sid not in lookup or kind not in KINDS:
            raise ValueError("Choose a site and intervention from the current catalogue.")
        if sid in seen:
            raise ValueError("Use only one project per site; overlapping benefits cannot be added.")
        seen.add(sid)
        site = lookup[sid]
        ok, why = _buildable(site, kind)
        if not ok:
            raise ValueError(f"{KINDS[kind]['label']} does not fit at {site['name']}. {why}")
        spent += prices[kind]
        selected.append({"site_id": sid, "kind": kind, "name": site["name"], "cost": prices[kind],
                         "lat": site["lat"], "lon": site["lon"], "result": site["choices"].get(kind)})
    if spent > budget:
        raise ValueError("These projects exceed the budget. Remove a project or increase the budget.")
    thermal = [p["result"] for p in selected if p["result"] is not None]
    count = sum(r["cells_affected"] for r in thermal)
    before = sum(r["before"]["feels_c"] * r["cells_affected"] for r in thermal) / count if count else None
    after = sum(r["after"]["feels_c"] * r["cells_affected"] for r in thermal) / count if count else None
    remaining = budget - spent
    # Why the money did not all get spent, when it did not. One project per site
    # and a fixed catalogue mean a large budget can exceed what the shortlist can
    # absorb, and that is worth saying rather than leaving a silent gap.
    cheapest = min(prices.values()) if prices else 0
    if remaining <= 0:
        note = "Fully allocated."
    elif remaining < cheapest:
        note = f"₹{remaining:,.0f} left, below the cheapest fix at ₹{cheapest:,.0f}."
    elif len(selected) >= len(data["sites"]):
        note = (f"Every one of the {len(data['sites'])} candidate sites already carries its best "
                f"affordable project, so ₹{remaining:,.0f} could not be placed. Lower the budget "
                "or refresh for more sites.")
    else:
        note = f"₹{remaining:,.0f} left; no further buildable site improves the result."
    return {"projects": selected, "spent": spent, "remaining": remaining,
            "allocation_note": note,
            "before_c": round(before, 1) if before is not None else None,
            "after_c": round(after, 1) if after is not None else None,
            "reduction_c": round(before - after, 2) if count else 0,
            "evaluated_ground_m2": round(count * geo.CELL_M ** 2),
            "proposed_water_points": sum(p["kind"] == "water_refill" for p in selected),
            "method": "Greedy ranking by estimated temperature relief × evaluated ground area per "
                      "rupee, then a fill pass that spends the remainder on the largest remaining "
                      "benefit; not a global optimum. Tree canopy is only offered where the building, "
                      "road, water and canopy rasters show enough open ground to plant it. Temperature "
                      "averages cover the selected, separate model patches, not the whole "
                      "neighbourhood. Water proposals improve planned access only; they have no "
                      "simulated temperature reduction."}
