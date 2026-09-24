"""Live road congestion, from TomTom Flow Segment Data.

The twin already models congestion as a Pune weekday/weekend curve (see
`anthropogenic`), and that curve is the right shape but it cannot know that a
truck has jackknifed on the Katraj bypass this afternoon. This service replaces
the curve with a measurement when one is available, through the seam
`anthropogenic.set_congestion_source()` already exposes, and leaves the modelled
curve in place when it is not.

Three things it deliberately does not do:

  * It does not invent a reading. No key, no network, or a provider error means
    the modelled curve stays and `/api/meta` keeps saying "modelled".
  * It does not query per road segment. TomTom bills per request and the twin
    needs one zone-level scalar, so it samples a fixed handful of the busiest
    roads and takes a length-weighted mean.
  * It does not turn congestion into a temperature. It returns the same
    free-flow-relative multiplier the modelled curve returns, so every
    coefficient downstream of it keeps its calibration.

Set HEATMIND_TOMTOM_KEY (in backend/.env or the environment) to enable it.
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timezone

import httpx

from ..config import TOMTOM_KEY
from . import anthropogenic

FLOW_URL = "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json"
# Live flow is only worth refetching on the order of the provider's own update
# cadence; TomTom refreshes most segments every minute or two.
TTL_S = 300.0
# How many road points to sample. Each one is a billed request, and the spread
# across the corridor matters more than the count.
MAX_SAMPLES = 8
# Congestion 1.0 (fully stopped) maps to this multiplier, which is the peak of the
# modelled weekday curve. Free flow maps to 1.0. Anchoring both ends to the curve
# the coefficients were fitted against means swapping in live data changes the
# input, not the calibration.
JAM_MULTIPLIER = 2.15


class TrafficService:
    def __init__(self) -> None:
        self._cache: dict | None = None
        self._fetched = 0.0
        self._lock = threading.Lock()
        self._points: list[tuple[float, float]] | None = None
        self.last_error: str | None = None

    # ------------------------------------------------------------------ sampling
    def _sample_points(self) -> list[tuple[float, float]]:
        """Midpoints of the longest major roads in the zone, spread across it."""
        if self._points is not None:
            return self._points
        from .zone import get_zone

        ranked: list[tuple[float, float, float]] = []
        for r in get_zone().data["roads"]:
            if r["highway"] not in ("trunk", "primary", "secondary"):
                continue
            nodes = r["nodes"]
            if len(nodes) < 2:
                continue
            _, la, lo = nodes[len(nodes) // 2]
            # crude length proxy: node count stands in for extent well enough to
            # rank which roads are worth one of a handful of billed requests
            ranked.append((float(len(nodes)), la, lo))
        ranked.sort(reverse=True)
        self._points = [(la, lo) for _, la, lo in ranked[:MAX_SAMPLES]]
        return self._points

    # ------------------------------------------------------------------ fetching
    def _fetch(self) -> dict | None:
        with self._lock:
            if self._cache and time.time() - self._fetched < TTL_S:
                return self._cache
            if not TOMTOM_KEY:
                self.last_error = "no API key"
                return None

            readings: list[tuple[float, float]] = []  # (congestion, confidence)
            errors = 0
            try:
                with httpx.Client(timeout=5.0) as client:
                    for lat, lon in self._sample_points():
                        try:
                            resp = client.get(FLOW_URL, params={"key": TOMTOM_KEY, "point": f"{lat},{lon}"})
                            resp.raise_for_status()
                            d = resp.json()["flowSegmentData"]
                            cur, free = float(d["currentSpeed"]), float(d["freeFlowSpeed"])
                            if free <= 0:
                                continue
                            congestion = max(0.0, min(1.0, 1.0 - cur / free))
                            readings.append((congestion, float(d.get("confidence", 1.0))))
                        except Exception:  # noqa: BLE001 - one bad point must not sink the batch
                            errors += 1
            except Exception as exc:  # noqa: BLE001 - client construction / network down
                self.last_error = str(exc)[:200]
                self._fetched = time.time() - (TTL_S - 60)  # retry in a minute
                return self._cache

            if not readings:
                self.last_error = f"no usable samples ({errors} failed)"
                self._fetched = time.time() - (TTL_S - 60)
                return self._cache

            weight = sum(c for _, c in readings) or float(len(readings))
            congestion = sum(v * c for v, c in readings) / weight
            self._cache = {
                "congestion": congestion,
                "confidence": round(sum(c for _, c in readings) / len(readings), 2),
                "samples": len(readings),
                "failed": errors,
                "observed_at": datetime.now(timezone.utc).isoformat(),
                "source": "tomtom",
                "resolution": "road segment, zone mean",
            }
            self._fetched = time.time()
            self.last_error = None
            return self._cache

    # ------------------------------------------------------------------- reading
    def factor(self, _when: datetime) -> float | None:
        """Free-flow-relative multiplier, or None to leave the modelled curve alone.

        The timestamp is ignored on purpose: this is a *live* reading, so it only
        describes now. Asking it about a forecast hour would be asking it to make
        something up, and the modelled curve is the honest answer for those.
        """
        d = self._fetch()
        if not d:
            return None
        return 1.0 + d["congestion"] * (JAM_MULTIPLIER - 1.0)

    def describe(self) -> dict:
        d = self._cache
        if not TOMTOM_KEY:
            return {"source": "modelled", "live": False, "reason": "HEATMIND_TOMTOM_KEY not set"}
        if not d:
            return {"source": "modelled", "live": False, "reason": self.last_error or "no reading yet"}
        return {
            "source": d["source"], "live": True,
            "congestion": round(d["congestion"], 3),
            "multiplier": round(1.0 + d["congestion"] * (JAM_MULTIPLIER - 1.0), 2),
            "confidence": d["confidence"], "samples": d["samples"], "failed": d["failed"],
            "observed_at": d["observed_at"], "resolution": d["resolution"],
        }


traffic_service = TrafficService()


def install() -> bool:
    """Attach the live feed to the anthropogenic model. True if it was enabled."""
    if not TOMTOM_KEY:
        return False
    anthropogenic.set_congestion_source(traffic_service.factor)
    return True
