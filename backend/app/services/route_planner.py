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
from .risk_scoring import CAUTION_C, PERSONAS, score_route
from .routing_service import Path, StreetGraph
from .zone import CODE_LABEL

# Four separable route accents, none of them blue and none of them borrowed from
# the heat ramp, so a route chip can never be misread as a temperature.
ROUTE_COLORS = ["#6fbf5e", "#f472b6", "#f0abfc", "#d8c65a"]
POI_RADIUS_M = 45.0
SEGMENT_M = 24.0


class RoutePlanner:
    def __init__(self) -> None:
        self.twin = get_twin()
        self.graph = StreetGraph(self.twin.zone)
        pois = self.twin.zone.pois
        self.pois = pois
        self.poi_xy = np.array([geo.to_xy(p["lat"], p["lon"]) for p in pois]) if pois else np.zeros((0, 2))
        self.road_names = [r["name"] for r in self.twin.zone.data["roads"]]
        self.road_hw = [r["highway"] for r in self.twin.zone.data["roads"]]
        self._store: OrderedDict[str, dict] = OrderedDict()
        self._lock = threading.Lock()

    # ------------------------------------------------------------------

    @staticmethod
    def _at_arrival(g, src: int, piece_seconds: np.ndarray, frames: list, pvs: list[dict],
                    limit_s: float = math.inf):
        """Per-piece feels/exposure/intensity, sampled at the time each piece is reached.

        Frames sit 15 minutes apart, so a piece reached at 37 minutes is read as
        two-thirds of the way from the 30-minute frame to the 45-minute one. Beyond
        the last frame the walk is longer than the forecast and the final frame is
        held, which is the honest thing to do with a number that does not exist yet.
        """
        offs = np.asarray(TIMELINE_OFFSETS, dtype=float)
        if len(offs) < 2:
            return pvs[0]["feels"], pvs[0]["exposure"], frames[0].intensity

        reach_min = g.reach_seconds(src, piece_seconds, limit_s) / 60.0
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
                compare_id: str | None = None) -> dict:
        if persona not in PERSONAS:
            raise ValueError(f"unknown persona '{persona}'")
        P = PERSONAS[persona]
        g = self.graph
        src, dst = g.snap(*origin), g.snap(*destination)
        if src == dst:
            raise ValueError("Origin and destination snap to the same street point — pick points further apart.")

        frames = [self.twin.frame(depart + timedelta(minutes=o), scenario, temp_delta) for o in TIMELINE_OFFSETS]
        f0 = frames[0]
        shady = P["walks_shady_side"]
        pvs = [g.piece_values(f, shady) for f in frames]
        pv0 = pvs[0]
        piece_seconds = g.p_len / P["speed_ms"]

        # Cost every street by the sun that will be on it when the walker gets there,
        # not by the sun at the moment they set off. The frames already span the next
        # three hours; this just reads each piece from the one matching its own
        # arrival time instead of reading all of them from frame zero.
        # Nothing beyond the last forecast frame can be costed differently anyway, so
        # the reach search stops there rather than mapping the whole zone.
        feels_t, expo_t, inten_t = self._at_arrival(
            g, src, piece_seconds, frames, pvs, limit_s=TIMELINE_OFFSETS[-1] * 60.0)

        # Heat-aversion penalty relative to the coolest streets on offer
        ref = max(CAUTION_C - P["vulnerability_shift_c"], float(np.percentile(feels_t, 10)))
        penalty = np.clip(feels_t - ref, 0, None) / 4 + 0.6 * expo_t * inten_t

        paths = g.candidate_paths(src, dst, piece_seconds, penalty)
        if not paths:
            raise ValueError("No walkable connection between these points.")
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
        routes = [self._build_route(cid, i, p, P, persona, frames, pvs) for i, p in enumerate(paths)]

        # Tags: fastest / coolest / recommended
        fastest = min(routes, key=lambda r: r["metrics"]["duration_min"])
        coolest = min(routes, key=lambda r: (r["metrics"]["heat_dose"], r["heat_risk_score"]))
        limit = fastest["metrics"]["duration_min"] * 1.5 + 4
        eligible = [r for r in routes if r["metrics"]["duration_min"] <= limit] or routes
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
        routes.sort(key=lambda r: (0 if r is recommended else 1, r["metrics"]["duration_min"]))
        for i, r in enumerate(routes):
            r["label"] = "Route " + "ABCDEFG"[i]
            r["color"] = ROUTE_COLORS[i % len(ROUTE_COLORS)]
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
            ref = fastest if r is not fastest else (recommended if recommended is not fastest else None)
            if ref is None:
                others = [x for x in routes if x is not r]
                ref = others[0] if others else None
            r["explanation"] = explain(r, ref, persona, f0.when.isoformat(), f0.elev > 0)

        rec = recommended
        best_i = int(np.argmin([fc["score"] for fc in rec["forecast"]]))
        best = rec["forecast"][best_i]
        now_score = rec["forecast"][0]["score"]
        result = {
            "compare_id": cid,
            "persona": persona, "persona_label": P["label"], "scenario": scenario,
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
            "routes": [{k: v for k, v in r.items() if not k.startswith("_")} for r in routes],
        }
        with self._lock:
            self._store[cid] = {
                "origin": origin, "destination": destination, "persona": persona, "scenario": scenario,
                "depart": depart, "temp_delta": temp_delta,
                "paths": {r["id"]: paths[r["_path_index"]] for r in routes},
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
    def _build_route(self, cid: str, i: int, path: Path, P: dict, persona: str, frames, pvs) -> dict:
        g = self.graph
        idx, fwd = g.path_pieces(path)
        lens = g.p_len[idx]
        secs = lens / P["speed_ms"]
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
                            intensity=cond["intensity"], poi_positions_m=stop_pos, total_m=total)
            if scored0 is None:
                scored0 = s
                # The hydration and rest plan belongs to the walk you are about to
                # take, so it is built from the same arrival-time conditions the
                # headline score uses rather than from a snapshot.
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
            "breaks": breaks,
        }

    def _fallback_name(self, road_i: int) -> str:
        hw = self.road_hw[road_i]
        return {"service": "campus/service lane", "residential": "residential lane", "track": "dirt track",
                "footway": "footpath", "path": "footpath", "trunk": "NH48 bypass"}.get(hw, hw.replace("_", " "))

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
                           temp_delta=temp_delta_c, extra_paths=[current_path] if current_path else None)
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
