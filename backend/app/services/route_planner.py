"""Orchestrates the five engines into route comparisons, forecasts and live simulation."""
from __future__ import annotations

import threading
import uuid
from collections import OrderedDict
from datetime import datetime, timedelta

import numpy as np

from . import geo
from .explanation_service import explain
from .heat_twin_service import get_twin
from .prediction_service import TIMELINE_OFFSETS
from .risk_scoring import CAUTION_C, PERSONAS, score_route
from .routing_service import Path, StreetGraph
from .zone import CODE_LABEL

ROUTE_COLORS = ["#38bdf8", "#a78bfa", "#f472b6", "#facc15"]
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
        # Heat-aversion penalty relative to the coolest streets right now (so shade vs sun really matters)
        ref = max(CAUTION_C - P["vulnerability_shift_c"], float(np.percentile(pv0["feels"], 10)))
        penalty = np.clip(pv0["feels"] - ref, 0, None) / 4 + 0.6 * pv0["exposure"] * f0.intensity

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

        forecast, scored0 = [], None
        for off, f, pv in zip(TIMELINE_OFFSETS, frames, pvs):
            s = score_route(persona=persona, seconds=secs, lengths=lens, feels=pv["feels"][idx],
                            exposure=pv["exposure"][idx], surface_excess=pv["surface_excess"][idx],
                            asphalt=pv["asphalt"][idx], intensity=f.intensity, poi_positions_m=stop_pos, total_m=total)
            if scored0 is None:
                scored0 = s
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
