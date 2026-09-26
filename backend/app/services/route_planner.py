"""Orchestrates the five engines into route comparisons, forecasts and live simulation."""
from __future__ import annotations

import math
import threading
import uuid
from collections import OrderedDict
from datetime import datetime, timedelta

import numpy as np

from . import geo
from .explanation_service import explain
from .heat_twin_service import get_twin
from . import break_planner
from .prediction_service import TIMELINE_OFFSETS
from . import modes as modes_mod
from . import navigation
from . import transit, transit_routing
from .risk_scoring import CAUTION_C, PERSONAS, score_route
from .routing_service import Path, StreetGraph
from .zone import CODE_LABEL

# Four separable route accents, none of them blue and none of them borrowed from
# the heat ramp, so a route chip can never be misread as a temperature.
ROUTE_COLORS = ["#6fbf5e", "#f472b6", "#f0abfc", "#d8c65a"]
#: Transit gets its own accent, outside the street-route rotation, so a bus itinerary
#: never reads as "one of the walking options in a different colour".
TRANSIT_COLOR = "#5bb8d4"
POI_RADIUS_M = 45.0
SEGMENT_M = 24.0

#: Senior Mode rest-amenity bias. How near a bench or toilet a piece of street has
#: to be to count, and the most the heat penalty may be discounted for it.
REST_NEAR_M = 50.0
REST_RELIEF = 0.33
REST_DETAILS = frozenset({"bench", "toilets"})


class RoutePlanner:
    def __init__(self) -> None:
        self.twin = get_twin()
        self.graph = StreetGraph(self.twin.zone)
        pois = self.twin.zone.pois
        self.pois = pois
        self.poi_xy = np.array([geo.to_xy(p["lat"], p["lon"]) for p in pois]) if pois else np.zeros((0, 2))
        self.road_names = [r["name"] for r in self.twin.zone.data["roads"]]
        self.road_hw = [r["highway"] for r in self.twin.zone.data["roads"]]
        self._rest_mask: np.ndarray | None = None
        self._store: OrderedDict[str, dict] = OrderedDict()
        self._lock = threading.Lock()

    # ------------------------------------------------------------------

    def _rest_proximity(self) -> np.ndarray:
        """Per-piece 0/1: is there a mapped bench or toilet within REST_NEAR_M?

        Cached on the planner: it is a pure function of the POI set and the street
        graph, and neither changes after startup.

        Mapped amenities only. Most of this zone's POI set is seeded, and a bench
        that is not there is worse than no bench at all for someone who chose a
        longer route on the strength of it.
        """
        if self._rest_mask is not None:
            return self._rest_mask
        mid = self.graph.p_mid
        mask = np.zeros(len(mid), dtype=float)
        for poi in self.pois:
            if (poi.get("detail") or "").lower() not in REST_DETAILS or poi.get("source") != "osm":
                continue
            x, y = geo.to_xy(poi["lat"], poi["lon"])
            near = (np.abs(mid[:, 0] - x) <= REST_NEAR_M) & (np.abs(mid[:, 1] - y) <= REST_NEAR_M)
            if near.any():
                idx = np.where(near)[0]
                d = np.hypot(mid[idx, 0] - x, mid[idx, 1] - y)
                mask[idx[d <= REST_NEAR_M]] = 1.0
        self._rest_mask = mask
        return mask

    # ------------------------------------------------------------------

    @staticmethod
    def _congestion(frame) -> float:
        """Traffic density at the departure time, as a 0..1 fraction.

        `anthropogenic.congestion_factor` is indexed to 1.0 at free-flowing daytime
        and peaks near 2.15 in the Pune evening rush. Modes want "how jammed is it",
        so anything at or below free flow is 0 and the jam ceiling is 1.
        """
        from .anthropogenic import congestion_factor
        return max(0.0, min(1.0, (congestion_factor(frame.when) - 1.0) / 1.2))

    @staticmethod
    def _at_arrival(g, src: int, piece_seconds: np.ndarray, frames: list, pvs: list[dict],
                    limit_s: float = math.inf, mode=None):
        """Per-piece feels/exposure/intensity, sampled at the time each piece is reached.

        Frames sit 15 minutes apart, so a piece reached at 37 minutes is read as
        two-thirds of the way from the 30-minute frame to the 45-minute one. Beyond
        the last frame the walk is longer than the forecast and the final frame is
        held, which is the honest thing to do with a number that does not exist yet.
        """
        offs = np.asarray(TIMELINE_OFFSETS, dtype=float)
        if len(offs) < 2:
            return pvs[0]["feels"], pvs[0]["exposure"], frames[0].intensity

        reach_min = g.reach_seconds(src, piece_seconds, limit_s, mode=mode) / 60.0
        m = np.clip(reach_min, offs[0], offs[-1])
        hi = np.clip(np.searchsorted(offs, m, side="right"), 1, len(offs) - 1)
        lo = hi - 1
        span = offs[hi] - offs[lo]
        w = np.where(span > 0, (m - offs[lo]) / np.maximum(span, 1e-9), 0.0)

        idx = np.arange(len(piece_seconds))
        feels = np.stack([pv["feels"] for pv in pvs])
        expo = np.stack([pv["exposure"] for pv in pvs])
        inten = np.asarray([f.intensity for f in frames], dtype=float)
        feels_t = feels[lo, idx] * (1 - w) + feels[hi, idx] * w
        expo_t = expo[lo, idx] * (1 - w) + expo[hi, idx] * w
        inten_t = inten[lo] * (1 - w) + inten[hi] * w
        return feels_t, expo_t, inten_t

    def compare(self, *, origin: tuple[float, float], destination: tuple[float, float], persona: str,
                scenario: str, depart: datetime, temp_delta: float = 0.0, extra_paths: list[Path] | None = None,
                compare_id: str | None = None, mode: str | None = None,
                senior: bool = False) -> dict:
        if persona not in PERSONAS:
            raise ValueError(f"unknown persona '{persona}'")
        P = PERSONAS[persona]
        M = modes_mod.get(mode)
        g = self.graph
        snap_mode = modes_mod.get("walk") if M.transit else M
        src, dst = g.snap(*origin, mode=snap_mode), g.snap(*destination, mode=snap_mode)
        if src == dst:
            raise ValueError("Origin and destination snap to the same street point — pick points further apart.")

        frames = [self.twin.frame(depart + timedelta(minutes=o), scenario, temp_delta) for o in TIMELINE_OFFSETS]
        f0 = frames[0]
        # The street routes shown beside a bus itinerary are the walk the rider would
        # otherwise take -- costing them at bus speed would compare the bus against an
        # imaginary trip where you drive a bus yourself.
        street_mode = modes_mod.get("walk") if M.transit else M
        # Who you are decides whether you *would* cross for shade; what you are on
        # decides whether you can. A pedestrian picks the shaded kerb, a car sits in
        # the carriageway whoever is driving it.
        shady = street_mode.shady_side and P["walks_shady_side"]
        pvs = [g.piece_values(f, shady) for f in frames]
        pv0 = pvs[0]
        speed = modes_mod.speed_ms(street_mode, P, congestion=self._congestion(f0))
        piece_seconds = g.p_len / speed

        # Cost every street by the sun that will be on it when the walker gets there,
        # not by the sun at the moment they set off. The frames already span the next
        # three hours; this just reads each piece from the one matching its own
        # arrival time instead of reading all of them from frame zero.
        # Nothing beyond the last forecast frame can be costed differently anyway, so
        # the reach search stops there rather than mapping the whole zone.
        feels_t, expo_t, inten_t = self._at_arrival(
            g, src, piece_seconds, frames, pvs, limit_s=TIMELINE_OFFSETS[-1] * 60.0, mode=street_mode)

        # Heat-aversion penalty relative to the coolest streets on offer, scaled by
        # how much of the weather this mode actually delivers to the traveller. A
        # driver detouring a kilometre for a tree they are sealed away from is not a
        # cooler route, just a longer one.
        ref = max(CAUTION_C - P["vulnerability_shift_c"], float(np.percentile(feels_t, 10)))
        penalty = (np.clip(feels_t - ref, 0, None) / 4 + 0.6 * expo_t * inten_t) * street_mode.heat_exposure

        # Senior Mode: bias the search toward streets with somewhere to sit.
        #
        # Multiplied into the heat penalty rather than added beside it, so it can only
        # ever discount a street the heat term was already pricing -- it cannot drag a
        # route onto a hot road because there is a bench on it. Combined with heat, as
        # asked, and bounded: a third off at most.
        #
        # Be clear about the ceiling on this. The zone carries six mapped benches and
        # no mapped toilets across 37 km2, so on most trips this changes nothing at
        # all. It is wired to the real OSM amenities rather than to invented ones
        # precisely so that the day the mapping improves, the routing does too.
        if senior:
            penalty = penalty * (1.0 - REST_RELIEF * self._rest_proximity())

        paths = g.candidate_paths(src, dst, piece_seconds, penalty, mode=street_mode)
        if not paths:
            raise ValueError(f"No {M.label.lower()} connection between these points.")
        pinned_ids: set[int] = set()
        for ep in extra_paths or []:
            ids = g.edge_ids(ep)
            dup = next((i for i, p in enumerate(paths) if g.edge_ids(p) == ids), None)
            if dup is None:
                paths.append(ep)
                pinned_ids.add(len(paths) - 1)
            else:
                pinned_ids.add(dup)

        cid = compare_id or uuid.uuid4().hex[:10]
        routes = [self._build_route(cid, i, p, P, persona, frames, pvs, street_mode, speed)
                  for i, p in enumerate(paths)]

        # A bus trip is not one of these routes: it is a walk, a wait and a ride, each
        # with its own pace and its own share of the sun. It is built separately and
        # placed alongside the street routes so the two can be compared directly --
        # which is the comparison a rider is actually making.
        transit_block = None
        if M.transit:
            itinerary = transit_routing.plan(
                planner=self, origin=origin, destination=destination, persona=P,
                sun_up=f0.elev > 0, congestion=self._congestion(f0))
            if itinerary is None:
                transit_block = {
                    "available": False,
                    "reason": ("No bus stop within walking range of both ends, or the two nearest "
                               "stops are too close together for the ride to beat walking."),
                }
            else:
                bus_route = self._transit_route(cid, len(paths), itinerary, P, persona, f0)
                routes.append(bus_route)
                transit_block = {"available": True, **itinerary}

        # Tags: fastest / coolest / recommended.
        #
        # Ranked over the street routes only. A bus trip is not a variant of a walk --
        # it has a wait in it and it does not go where you point it -- so calling it
        # "fastest" against three walking routes would be comparing different
        # questions. It is carried alongside with its own label and its own score, and
        # the rider does the comparison the app should not pretend to make for them.
        street = [r for r in routes if "transit" not in r["tags"]] or routes
        fastest = min(street, key=lambda r: r["metrics"]["duration_min"])
        coolest = min(street, key=lambda r: (r["metrics"]["heat_dose"], r["heat_risk_score"]))
        limit = fastest["metrics"]["duration_min"] * 1.5 + 4
        eligible = [r for r in street if r["metrics"]["duration_min"] <= limit] or street
        best_alt = min(eligible, key=lambda r: (r["heat_risk_score"], r["metrics"]["duration_min"]))
        # Only send people on a detour when it meaningfully lowers their risk
        recommended = best_alt if best_alt["heat_risk_score"] <= fastest["heat_risk_score"] - 1.5 else fastest
        for r in routes:
            if r is fastest:
                r["tags"].append("fastest")
            if r is coolest:
                r["tags"].append("coolest")
            if r is recommended:
                r["tags"].append("recommended")
        routes.sort(key=lambda r: ("transit" in r["tags"], 0 if r is recommended else 1,
                                   r["metrics"]["duration_min"]))
        letters = 0
        for r in routes:
            if "transit" in r["tags"]:
                r["label"] = "Bus"
                r["title"] = f"via {r['transit']['board']['name']}"
                r["color"] = TRANSIT_COLOR
                continue
            r["label"] = "Route " + "ABCDEFG"[letters]
            r["color"] = ROUTE_COLORS[letters % len(ROUTE_COLORS)]
            letters += 1
            if "recommended" in r["tags"]:
                r["title"] = "HeatMind pick"
            elif "fastest" in r["tags"]:
                r["title"] = "Fastest"
            elif "coolest" in r["tags"]:
                r["title"] = "Coolest"
            else:
                r["title"] = "Alternative"
        for idx in pinned_ids:
            r = next(x for x in routes if x["_path_index"] == idx)
            r["tags"].append("current")

        # Trade-off vs fastest + explanations
        for r in routes:
            fm, m = fastest["metrics"], r["metrics"]
            r["tradeoff"] = {
                "extra_min": round(m["duration_min"] - fm["duration_min"], 1),
                "dose_change_pct": round((m["heat_dose"] - fm["heat_dose"]) / fm["heat_dose"] * 100, 1) if fm["heat_dose"] > 0 else 0.0,
                "score_change": round(r["heat_risk_score"] - fastest["heat_risk_score"], 1),
                "shade_change_pts": round(m["pct_shaded"] - fm["pct_shaded"], 1),
            }
        for r in routes:
            if "transit" in r["tags"]:
                # The stock explanation compares street routes by shade and detour
                # length, neither of which is the story of a bus trip.
                t = r["transit"]
                exposed_min = sum(l["minutes"] for l in t["legs"]
                                  if l["kind"] == "walk" or (l["kind"] == "wait" and not l["sheltered"]))
                r["explanation"] = {
                    "summary": (
                        f"Walk {t['walk_m']} m to {t['board']['name']}, wait about "
                        f"{t['wait_min']:.0f} min, then ride to {t['alight']['name']}."
                    ),
                    "bullets": [
                        {"icon": "sun",
                         "text": (f"About {exposed_min:.0f} of the {t['total_min']:.0f} minutes are spent "
                                  f"outdoors — the walk at each end and the wait.")},
                        {"icon": "shade",
                         "text": (f"{t['board']['name']} has a shelter, so the wait is out of the sun."
                                  if t["board"]["shelter"] else
                                  f"{t['board']['name']} has no shelter recorded, so the "
                                  f"{t['wait_min']:.0f}-minute wait is in the open.")},
                        {"icon": "clock", "text": t["disclaimer"]},
                    ],
                    "top_factors": ["duration", "shade"],
                    "source": "rule_based",
                }
                # One keyframe, not none: the sheet interpolates a forecast series by
                # position and a single point is a flat line, which is the honest
                # shape for a trip whose wait does not move with the sun.
                r["forecast"] = [{
                    "offset_min": 0, "time": f0.when.isoformat(),
                    "score": r["heat_risk_score"], "band": r["band"],
                    "heat_dose": r["metrics"]["heat_dose"],
                    "pct_shaded": r["metrics"]["pct_shaded"],
                    "peak_feels_c": r["metrics"]["peak_feels_c"],
                }]
                continue
            ref = fastest if r is not fastest else (recommended if recommended is not fastest else None)
            if ref is None:
                others = [x for x in routes if x is not r and "transit" not in x["tags"]]
                ref = others[0] if others else None
            r["explanation"] = explain(r, ref, persona, f0.when.isoformat(), f0.elev > 0)

        rec = recommended
        best_i = int(np.argmin([fc["score"] for fc in rec["forecast"]]))
        best = rec["forecast"][best_i]
        now_score = rec["forecast"][0]["score"]
        result = {
            "compare_id": cid,
            "persona": persona, "persona_label": P["label"], "scenario": scenario,
            "mode": M.key, "mode_label": M.label,
            # The mode the user picked, not the pace of the street alternatives shown
            # beside it. For bus those alternatives are walks, and reporting 4.9 km/h
            # under the label "Bus" reads as a claim about the bus.
            "speed_kmh": round(modes_mod.speed_ms(M, P, congestion=self._congestion(f0)) * 3.6, 1),
            "street_speed_kmh": round(speed * 3.6, 1),
            "mode_note": M.note,
            "depart_at": depart.isoformat(), "temp_delta_c": temp_delta,
            "offsets_min": TIMELINE_OFFSETS,
            "origin": {"lat": origin[0], "lon": origin[1], "snapped": list(g.node_ll[src])},
            "destination": {"lat": destination[0], "lon": destination[1], "snapped": list(g.node_ll[dst])},
            "conditions": self.twin.describe(f0),
            "recommended_id": rec["id"],
            "best_departure": {
                "offset_min": best["offset_min"], "time": best["time"], "score": best["score"],
                "score_now": now_score, "improvement": round(now_score - best["score"], 1),
                "advice": (f"Leaving in {best['offset_min']} min lowers {rec['label']}'s risk from {now_score:.0f} to {best['score']:.0f}."
                           if best["offset_min"] > 0 and now_score - best["score"] >= 3
                           else "Now is the best time to leave within the next 3 hours."),
            },
            "transit": transit_block,
            "routes": [{k: v for k, v in r.items() if not k.startswith("_")} for r in routes],
        }
        with self._lock:
            self._store[cid] = {
                "origin": origin, "destination": destination, "persona": persona, "scenario": scenario,
                "mode": M.key, "depart": depart, "temp_delta": temp_delta,
                "paths": {r["id"]: paths[r["_path_index"]] for r in routes
                          if r["_path_index"] < len(paths)},
                "recommended_id": rec["id"], "result": result,
            }
            while len(self._store) > 200:
                self._store.popitem(last=False)
        return result


    @staticmethod
    def _along_walk(minutes: np.ndarray, stacks: dict[str, np.ndarray],
                    intens: np.ndarray) -> dict:
        """Per-piece conditions interpolated to the minute each piece is reached.

        Frames sit 15 minutes apart, so a piece reached at 37 minutes reads two thirds
        of the way from the 30-minute frame to the 45-minute one. Past the last frame
        the walk outruns the forecast and the final frame is held, which is the honest
        thing to do with a number that does not exist yet.
        """
        offs = np.asarray(TIMELINE_OFFSETS, dtype=float)
        if len(offs) < 2:
            return {k: v[0] for k, v in stacks.items()} | {"intensity": float(intens[0])}
        m = np.clip(minutes, offs[0], offs[-1])
        hi = np.clip(np.searchsorted(offs, m, side="right"), 1, len(offs) - 1)
        lo = hi - 1
        span = offs[hi] - offs[lo]
        w = np.where(span > 0, (m - offs[lo]) / np.maximum(span, 1e-9), 0.0)
        cols = np.arange(len(m))
        out = {k: v[lo, cols] * (1 - w) + v[hi, cols] * w for k, v in stacks.items()}
        # One scalar for the whole walk, weighted by how long it is spent in each part.
        out["intensity"] = float(np.mean(intens[lo] * (1 - w) + intens[hi] * w))
        return out

    # ------------------------------------------------------------------
    def _build_route(self, cid: str, i: int, path: Path, P: dict, persona: str, frames, pvs,
                     M, speed_ms: float) -> dict:
        g = self.graph
        idx, fwd = g.path_pieces(path)
        lens = g.p_len[idx]
        secs = lens / speed_ms
        cum = np.cumsum(lens) - lens / 2
        total = float(lens.sum())

        # POIs within reach of the route
        mids = g.p_mid[idx]
        along = []
        if len(self.poi_xy):
            d = np.hypot(mids[:, None, 0] - self.poi_xy[None, :, 0], mids[:, None, 1] - self.poi_xy[None, :, 1])
            near = d.min(axis=0)
            for pi in np.where(near <= POI_RADIUS_M)[0]:
                k = int(np.argmin(d[:, pi]))
                along.append({**self.pois[pi], "at_m": round(float(cum[k])), "off_route_m": round(float(near[pi]))})
            along.sort(key=lambda p: p["at_m"])
        stop_pos = [p["at_m"] for p in along if p["type"] in ("water", "rest", "cooling_center", "shade")]

        # Minutes into the walk at the middle of each piece. Within a chosen route this
        # is exact -- cumulative distance over pace -- so no estimate is involved.
        walk_min = (np.cumsum(secs) - secs / 2) / 60.0
        stacks = {k: np.stack([pv[k][idx] for pv in pvs])
                  for k in ("feels", "exposure", "surface_excess", "asphalt")}
        intens = np.asarray([f.intensity for f in frames], dtype=float)

        forecast, scored0 = [], None
        for off, f in zip(TIMELINE_OFFSETS, frames):
            # Score the walk as it will be lived, not as a snapshot: every piece read
            # at the clock time the walker is standing on it. Over a two-hour route
            # the sun swings about 30 degrees of azimuth, so the far half was being
            # reported against shade that will have moved well off it by then.
            cond = self._along_walk(off + walk_min, stacks, intens)
            s = score_route(persona=persona, seconds=secs, lengths=lens,
                            feels=cond["feels"], exposure=cond["exposure"],
                            surface_excess=cond["surface_excess"], asphalt=cond["asphalt"],
                            intensity=cond["intensity"], poi_positions_m=stop_pos, total_m=total,
                            speed_ms=speed_ms, mode_exposure=M.heat_exposure, mode_exertion=M.exertion)
            if scored0 is None:
                scored0 = s
                # The hydration and rest plan belongs to the walk you are about to
                # take, so it is built from the same arrival-time conditions the
                # headline score uses rather than from a snapshot.
                # Hydration and rest belong to the exposed modes. A driver passing a
                # water point at 25 km/h is not going to stop at it, and offering the
                # plan anyway would put advice in front of people it does not fit.
                breaks = break_planner.plan(
                    persona=persona, minutes=secs / 60.0, cum_m=cum,
                    feels=cond["feels"], exposure=cond["exposure"],
                    intensity=cond["intensity"], rh=f.weather.rh,
                    along=along, total_m=total, depart=f.when)
            forecast.append({"offset_min": off, "time": f.when.isoformat(), "score": s["score"], "band": s["band"],
                             "heat_dose": s["metrics"]["heat_dose"], "pct_shaded": s["metrics"]["pct_shaded"],
                             "peak_feels_c": s["metrics"]["peak_feels_c"]})

        # Display segments (~24 m) with per-offset feels/exposure for the timeline scrubber
        starts = np.where(fwd[:, None], g.p_start[idx], g.p_end[idx])
        ends = np.where(fwd[:, None], g.p_end[idx], g.p_start[idx])
        segs, cur, acc = [], [], 0.0
        edges_of = g.p_edge[idx]
        for k in range(len(idx)):
            cur.append(k)
            acc += lens[k]
            if acc >= SEGMENT_M or k == len(idx) - 1:
                ks = np.array(cur)
                coords = [geo.to_latlon(*starts[ks[0]])] + [geo.to_latlon(*ends[j]) for j in ks]
                road_i = int(g.eroad[edges_of[ks[len(ks) // 2]]])
                codes = pvs[0]["surface_code"][idx[ks]]
                w = lens[ks]
                segs.append({
                    "coords": [[round(a, 6), round(b, 6)] for a, b in coords],
                    "length_m": round(float(w.sum()), 1),
                    "start_m": round(float(cum[ks[0]] - lens[ks[0]] / 2)),
                    "name": self.road_names[road_i] or self._fallback_name(road_i),
                    "surface": CODE_LABEL[int(np.bincount(codes.astype(int), weights=w, minlength=8).argmax())],
                    "canopy": round(float((pvs[0]["canopy"][idx[ks]] * w).sum() / w.sum()), 2),
                    "feels": [round(float((pv["feels"][idx[ks]] * w).sum() / w.sum()), 1) for pv in pvs],
                    "exposure": [round(float((pv["exposure"][idx[ks]] * w).sum() / w.sum()), 2) for pv in pvs],
                })
                cur, acc = [], 0.0

        geometry = [list(g.node_ll[n]) for n in path.nodes]
        return {
            "id": f"{cid}-{i}", "_path_index": i, "tags": [], "label": "", "title": "", "color": "",
            "geometry": geometry, "duration_min": scored0["metrics"]["duration_min"],
            "distance_m": scored0["metrics"]["distance_m"],
            "heat_risk_score": scored0["score"], "band": scored0["band"], "factors": scored0["factors"],
            "metrics": scored0["metrics"], "pois_along_route": along, "segments": segs, "forecast": forecast,
            "steps": navigation.steps_from_segments(segs, total, speed_ms),
            "breaks": breaks, "mode": M.key, "mode_label": M.label,
            "speed_kmh": round(speed_ms * 3.6, 1),
        }

    #: How much of the sun reaches a rider during each leg of a bus trip. Walking and
    #: waiting at an open kerb are full exposure; a shelter or a bus removes most of it.
    LEG_EXPOSURE = {"walk": 1.0, "wait": 1.0, "wait_sheltered": 0.2, "ride": 0.2}

    def _transit_route(self, cid: str, i: int, it: dict, P: dict, persona: str, frame) -> dict:
        """Score a bus itinerary by sampling the twin along each leg.

        The street routes are scored piece-by-piece on the routing graph. A transit
        trip cannot reuse that: its legs run at three different speeds and under three
        different amounts of shelter, and the graph carries one speed per route. So
        the twin's own grids are sampled directly along each leg's geometry, weighted
        by the minutes spent on it and by how much sun that leg actually delivers.

        The wait is where this matters most. Fifteen minutes is a long time to be
        standing still, and standing still on a sunlit kerb is a bigger dose than the
        walk that preceded it — which is exactly the trade `_stop_score` is making
        when it sends someone to a sheltered stop further away.
        """
        import numpy as _np

        def cells_src(coords: list[list[float]]) -> list[list[float]]:
            """Cap the samples per leg: a 5 km ride has hundreds of nodes and the
            score is a time-weighted mean, so every 12th node carries it just as
            well for a fraction of the grid lookups."""
            step = max(1, len(coords) // 120)
            return coords[::step] or coords[:1]

        feels_w: list[float] = []
        mins_w: list[float] = []
        expo_w: list[float] = []
        geometry: list[list[float]] = []
        for leg in it["legs"]:
            coords = leg["geometry"]
            geometry.extend(coords)
            if not coords or leg["minutes"] <= 0:
                continue
            kind = leg["kind"]
            if kind == "wait":
                share = self.LEG_EXPOSURE["wait_sheltered" if leg.get("sheltered") else "wait"]
            else:
                share = self.LEG_EXPOSURE[kind]
            cells = [geo.xy_to_cell(*geo.to_xy(la, lo)) for la, lo in cells_src(coords)]
            air = frame.weather.air_c
            # Shelter blocks the radiant load, not the air. A PMPML bus is not
            # air-conditioned and its windows are open, so a rider is at very nearly
            # the ambient temperature -- but not under the sky-and-asphalt load that
            # makes `feels` run several degrees above it. Scaling the *excess over
            # air* by the leg's exposure share expresses exactly that, where scaling
            # `feels` itself would have claimed the bus is refrigerated.
            f = [air + (float(frame.feels[r, c]) - air) * share for r, c in cells]
            e = [float(frame.exposure[r, c]) * share for r, c in cells]
            per = leg["minutes"] / len(cells)
            feels_w.extend(f)
            expo_w.extend(e)
            mins_w.extend([per] * len(cells))

        mins = _np.asarray(mins_w or [1.0])
        feels = _np.asarray(feels_w or [frame.weather.air_c])
        expo = _np.asarray(expo_w or [0.0])
        lengths = _np.asarray([it["walk_m"] + it["ride_m"]], dtype=float)

        scored = score_route(
            persona=persona, seconds=mins * 60.0, lengths=lengths, feels=feels, exposure=expo,
            # A bus rider is not standing on the carriageway, so the radiant-surface
            # term is carried by the walk legs' exposure rather than counted twice.
            surface_excess=_np.zeros_like(feels), asphalt=_np.zeros_like(feels),
            intensity=frame.intensity, poi_positions_m=[], total_m=float(lengths.sum()),
            speed_ms=modes_mod.speed_ms(modes_mod.get("walk"), P),
            mode_exposure=1.0,  # already applied per leg above
            mode_exertion=modes_mod.get("bus").exertion,
        )
        metrics = dict(scored["metrics"])
        # The itinerary's own clock is authoritative: it includes the wait and the
        # dwell at intermediate stops, neither of which is distance over speed.
        metrics["duration_min"] = it["total_min"]
        metrics["distance_m"] = round(it["walk_m"] + it["ride_m"])

        return {
            "id": f"{cid}-{i}", "_path_index": i, "tags": ["transit"], "label": "", "title": "",
            "color": "", "geometry": geometry,
            "duration_min": it["total_min"], "distance_m": metrics["distance_m"],
            "heat_risk_score": scored["score"], "band": scored["band"], "factors": scored["factors"],
            "metrics": metrics, "pois_along_route": [], "segments": [], "forecast": [],
            # A bus trip's "turns" are its legs: walk here, wait, ride, walk. Street
            # directions for the ride would be instructions for the driver, not the
            # passenger.
            "steps": [
                {
                    "index": i, "maneuver": leg["kind"], "turn_deg": 0.0,
                    "road": leg["to_name"],
                    "instruction": (
                        f"Walk to {leg['to_name']}" if leg["kind"] == "walk" else
                        f"Wait at {leg['from_name']}" if leg["kind"] == "wait" else
                        f"Ride to {leg['to_name']}"
                    ),
                    "distance_m": round(leg["distance_m"]),
                    "start_m": 0,
                    "duration_min": round(leg["minutes"], 1),
                    "exposure": 1.0 if leg["kind"] == "walk" or (leg["kind"] == "wait" and not leg["sheltered"]) else 0.2,
                    "feels_c": None, "surface": "", "coords": leg["geometry"],
                }
                for i, leg in enumerate(it["legs"])
            ],
            "breaks": None, "mode": "bus", "mode_label": "Bus",
            "speed_kmh": round(transit.BUS_SPEED_MS * 3.6, 1),
            "transit": it,
        }

    def _fallback_name(self, road_i: int) -> str:
        """A readable stand-in for a road OSM has not named.

        These end up inside turn instructions ("Turn right onto ..."), so a raw OSM
        class like "tertiary" cannot be passed through -- it reads as a street called
        Tertiary. Every class gets a phrase that works as the object of that sentence.
        """
        hw = self.road_hw[road_i]
        return {
            "service": "campus/service lane", "residential": "residential lane",
            "living_street": "quiet lane", "track": "dirt track",
            "footway": "footpath", "path": "footpath", "steps": "steps",
            "pedestrian": "pedestrian street", "cycleway": "cycle path",
            "trunk": "NH48 bypass", "trunk_link": "bypass slip road",
            "primary": "the main road", "primary_link": "main-road slip",
            "secondary": "the secondary road", "secondary_link": "secondary slip",
            "tertiary": "the link road", "tertiary_link": "link-road slip",
            "unclassified": "unnamed road",
        }.get(hw, hw.replace("_", " "))

    # ------------------------------------------------------------------
    def get(self, compare_id: str) -> dict | None:
        with self._lock:
            return self._store.get(compare_id)

    def find_route(self, route_id: str) -> tuple[dict, dict] | None:
        cid = route_id.rsplit("-", 1)[0]
        st = self.get(cid)
        if not st:
            return None
        r = next((x for x in st["result"]["routes"] if x["id"] == route_id), None)
        return (st, r) if r else None

    def simulate(self, *, compare_id: str, route_id: str | None, time_offset_min: int, temp_delta_c: float) -> dict:
        st = self.get(compare_id)
        if not st:
            raise KeyError(compare_id)
        current_id = route_id or st["recommended_id"]
        # The selected route may come from an earlier simulation of this same trip
        owner = st if current_id in st["paths"] else (self.get(current_id.rsplit("-", 1)[0]) or st)
        current_path = owner["paths"].get(current_id)
        old = next((r for r in owner["result"]["routes"] if r["id"] == current_id), None)
        new = self.compare(origin=st["origin"], destination=st["destination"], persona=st["persona"],
                           scenario=st["scenario"], depart=st["depart"] + timedelta(minutes=time_offset_min),
                           temp_delta=temp_delta_c, extra_paths=[current_path] if current_path else None,
                           mode=st.get("mode"))
        cur_new = next((r for r in new["routes"] if "current" in r["tags"]), None)
        rec_new = next(r for r in new["routes"] if r["id"] == new["recommended_id"])
        reroute = None
        if cur_new is not None:
            switched = cur_new["id"] != rec_new["id"]
            gain = round(cur_new["heat_risk_score"] - rec_new["heat_risk_score"], 1)
            reroute = {
                "current_route_id": cur_new["id"],
                "previous_score": old["heat_risk_score"] if old else None,
                "current_score_now": cur_new["heat_risk_score"],
                "recommended_route_id": rec_new["id"],
                "suggest_switch": bool(switched and gain >= 2),
                "score_gain": gain,
                "message": (
                    f"Conditions changed: your route now scores {cur_new['heat_risk_score']:.0f}. "
                    f"Switch to {rec_new['label']} ({rec_new['title']}) to cut risk by {gain:.0f} points."
                    if switched and gain >= 2 else
                    f"Your route is still the best option — risk {'rose' if old and cur_new['heat_risk_score'] > old['heat_risk_score'] else 'dropped'} "
                    f"from {old['heat_risk_score'] if old else '—'} to {cur_new['heat_risk_score']:.0f}."
                ),
            }
        new["simulation"] = {"time_offset_min": time_offset_min, "temp_delta_c": temp_delta_c,
                             "base_compare_id": compare_id, "reroute": reroute}
        return new


_planner: RoutePlanner | None = None
_plock = threading.Lock()


def get_planner() -> RoutePlanner:
    global _planner
    with _plock:
        if _planner is None:
            _planner = RoutePlanner()
    return _planner
