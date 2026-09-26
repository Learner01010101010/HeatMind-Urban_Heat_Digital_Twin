"""Bounded, cached TomTom observations matched to candidate road corridors.

Unobserved roads and future departures retain the local model. Heat conversion
is still a model; the API measures road speed, not temperatures or emissions.
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone

import httpx
import numpy as np

from ..config import DATA_DIR, TOMTOM_KEY
from . import anthropogenic, geo

FLOW_URL = "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json"
TTL_S = 300
MAX_SAMPLES = 4
MOTOR_ROADS = {"trunk", "trunk_link", "primary", "primary_link", "secondary", "tertiary", "residential", "unclassified"}


class TrafficService:
    def __init__(self, key=None, budget_path=None):
        self.key = TOMTOM_KEY if key is None else key
        self.budget_path = budget_path or DATA_DIR / "traffic_usage.json"
        try:
            self.monthly_limit = max(0, min(18000, int(os.environ.get("HEATMIND_TRAFFIC_MONTHLY_LIMIT", "18000"))))
        except ValueError:
            self.monthly_limit = 18000
        self._cache = {}
        self._lock = threading.Lock()
        self._retry_at = 0
        self.last_error = "key_missing" if not self.key else "not_sampled"

    @staticmethod
    def is_now(when):
        return when.tzinfo is not None and abs(when.timestamp() - time.time()) <= 600

    def _consume_credit(self):
        """Persist before requesting; fail closed if budget cannot be checked.

        Run one backend worker: this lock and counter belong to that process.
        Counts include failed calls, leaving headroom below the free allowance.
        """
        try:
            month = datetime.now(timezone.utc).strftime("%Y-%m")
            d = json.loads(self.budget_path.read_text()) if self.budget_path.exists() else {}
            used = int(d.get("used", 0)) if d.get("month") == month else 0
            if used >= self.monthly_limit:
                self.last_error = "monthly_limit"
                return False
            self.budget_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.budget_path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"month": month, "used": used + 1}), encoding="utf8")
            tmp.replace(self.budget_path)
            return True
        except (OSError, ValueError, TypeError):
            self.last_error = "budget_unavailable"
            return False

    def refresh(self, points, when):
        if not self.key or not self.is_now(when):
            self.last_error = "key_missing" if not self.key else "forecast_uses_model"
            return []
        with self._lock:
            now = time.time()
            self._cache = {k: v for k, v in self._cache.items() if now - v["fetched"] < TTL_S}
            readings = []
            deadline = time.monotonic() + 7
            with httpx.Client(timeout=2.0) as client:
                for lat, lon in points[:MAX_SAMPLES]:
                    bucket = (round(lat, 3), round(lon, 3))
                    if bucket in self._cache:
                        readings.append(self._cache[bucket])
                        continue
                    if now < self._retry_at or time.monotonic() > deadline or not self._consume_credit():
                        break
                    try:
                        r = client.get(FLOW_URL, params={"key": self.key, "point": f"{lat},{lon}", "unit": "KMPH"})
                        if r.status_code in (401, 403, 429):
                            self._retry_at = now + 900
                            self.last_error = "provider_limit" if r.status_code == 429 else "provider_auth"
                            break
                        r.raise_for_status()
                        d = r.json()["flowSegmentData"]
                        cur, free, confidence = float(d["currentSpeed"]), float(d["freeFlowSpeed"]), float(d["confidence"])
                        coords = [(float(p["latitude"]), float(p["longitude"])) for p in d["coordinates"]["coordinate"]]
                        if (not all(np.isfinite([cur, free, confidence])) or cur < 0 or free <= 0 or confidence < .5 or len(coords) < 2
                                or any(abs(a - lat) > .03 or abs(b - lon) > .03 for a, b in coords)):
                            self.last_error = "no_usable_reading"
                            continue
                        item = {"congestion": float(np.clip(1 - cur / free, 0, 1)), "speed_ms": cur / 3.6,
                                "closed": d.get("roadClosure") is True, "confidence": confidence, "coords": coords,
                                "fetched": time.time(), "observed_at": datetime.now(timezone.utc).isoformat()}
                        self._cache[bucket] = item
                        readings.append(item)
                        self.last_error = None
                    except Exception:
                        # Never expose request URLs containing a credential.
                        self.last_error = "provider_unavailable"
                        self._retry_at = now + 60
                        break
            return readings

    def route_field(self, graph, paths, when):
        n = len(graph.p_len)
        out = {"congestion": np.full(n, np.nan), "speed_ms": np.full(n, np.nan),
               "closed": np.zeros(n, bool), "live": np.zeros(n, bool), "observed_at": None}
        if not self.key or not self.is_now(when) or not paths:
            return out
        highway = np.asarray([graph.zone.data["roads"][int(graph.eroad[e])]["highway"] for e in graph.p_edge])
        motor = np.isin(highway, list(MOTOR_ROADS))
        points, seen = [], set()
        # Alternate between routes so a small quota covers different corridors.
        samples = []
        for path in paths:
            idx, _ = graph.path_pieces(path)
            idx = idx[motor[idx]]
            samples.append(idx[np.linspace(0, len(idx) - 1, min(3, len(idx))).astype(int)] if len(idx) else [])
        for rank in range(3):
            for ids in samples:
                if rank >= len(ids):
                    continue
                lat, lon = geo.to_latlon(*graph.p_mid[ids[rank]])
                bucket = round(lat, 3), round(lon, 3)
                if bucket not in seen:
                    points.append((lat, lon))
                    seen.add(bucket)
        readings = self.refresh(points[:MAX_SAMPLES], when)
        nearest = np.full(n, np.inf)
        heading = graph.p_end - graph.p_start
        norm = np.maximum(np.linalg.norm(heading, axis=1), 1e-6)
        for reading in readings:
            xy = np.asarray([geo.to_xy(*p) for p in reading["coords"]])
            for a, b in zip(xy[:-1], xy[1:]):
                v = b - a
                if np.dot(v, v) < 1:
                    continue
                candidates = np.where(motor & np.all(graph.p_mid >= np.minimum(a, b) - 20, axis=1)
                                      & np.all(graph.p_mid <= np.maximum(a, b) + 20, axis=1))[0]
                t = np.clip((graph.p_mid[candidates] - a) @ v / np.dot(v, v), 0, 1)
                dist = np.linalg.norm(graph.p_mid[candidates] - (a + t[:, None] * v), axis=1)
                parallel = np.abs(heading[candidates] @ v) / (norm[candidates] * np.linalg.norm(v))
                keep = (dist <= 20) & (dist < nearest[candidates]) & (parallel >= .87)
                idx = candidates[keep]
                nearest[idx] = dist[keep]
                for k in ("congestion", "speed_ms", "closed"):
                    out[k][idx] = reading[k]
                out["live"][idx] = True
            out["observed_at"] = reading["observed_at"]
        return out

    def factor(self, when):
        if not self.is_now(when):
            return None
        fresh = [v for v in list(self._cache.values()) if time.time() - v["fetched"] < TTL_S]
        if not fresh:
            return None
        return 1 + 1.15 * sum(v["congestion"] * v["confidence"] for v in fresh) / sum(v["confidence"] for v in fresh)

    def describe(self):
        fresh = [v for v in list(self._cache.values()) if time.time() - v["fetched"] < TTL_S]
        return {"source": "tomtom" if fresh else "modelled", "live": bool(fresh),
                "reason": self.last_error, "samples": len(fresh), "monthly_limit": self.monthly_limit,
                "observed_at": max((v["observed_at"] for v in fresh), default=None),
                "resolution": "sampled road corridors; remaining roads modelled", "max_age_seconds": TTL_S}


traffic_service = TrafficService()


def install():
    if not TOMTOM_KEY:
        return False
    anthropogenic.set_congestion_source(traffic_service.factor)
    return True
