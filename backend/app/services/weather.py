"""Ambient weather: Open-Meteo (live) or a calibrated Pune heatwave scenario (demo).

Weather is an *input* to the twin — one city-level number that the twin then
breaks apart street by street.
"""
from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta

import httpx

from ..config import CENTER, TZ

# Pune monthly climatology (IMD normals, approx): (Tmax, Tmin, RH afternoon %)
PUNE_CLIMATE = {1: (30, 12, 35), 2: (32, 13, 28), 3: (36, 17, 22), 4: (38, 21, 25), 5: (37, 23, 35),
                6: (32, 23, 65), 7: (28, 22, 78), 8: (28, 21, 78), 9: (30, 21, 70), 10: (31, 18, 55),
                11: (30, 15, 45), 12: (29, 12, 40)}


@dataclass
class Weather:
    air_c: float
    rh: float
    cloud: float  # 0-100 %
    wind_ms: float
    source: str  # demo_scenario | open_meteo | climatology_fallback

    def as_dict(self) -> dict:
        return {"air_c": round(self.air_c, 1), "rh": round(self.rh), "cloud_pct": round(self.cloud),
                "wind_ms": round(self.wind_ms, 1), "source": self.source}


def _diurnal(h: float) -> float:
    """0 at ~06:00, 1 at ~15:00 — asymmetric daily temperature curve."""
    if 6 <= h <= 15:
        return 0.5 - 0.5 * math.cos(math.pi * (h - 6) / 9)
    dh = (h - 15) % 24
    return 0.5 + 0.5 * math.cos(math.pi * dh / 15)


def base_time(scenario: str = "live") -> datetime:
    """The live 'now' (rounded to the minute). Every scenario uses the real current time."""
    now = datetime.now(TZ)
    return now.replace(second=0, microsecond=0)


class WeatherService:
    def __init__(self) -> None:
        self._cache: dict | None = None
        self._fetched = 0.0
        self._lock = threading.Lock()
        self.last_error: str | None = None

    def _fetch(self) -> dict | None:
        with self._lock:
            if self._cache and time.time() - self._fetched < 1800:
                return self._cache
            try:
                r = httpx.get(
                    "https://api.open-meteo.com/v1/forecast",
                    params={"latitude": CENTER[0], "longitude": CENTER[1],
                            "hourly": "temperature_2m,relative_humidity_2m,cloud_cover,wind_speed_10m",
                            "timezone": "Asia/Kolkata", "past_days": 1, "forecast_days": 2,
                            "wind_speed_unit": "ms"},
                    timeout=4.0,
                )
                r.raise_for_status()
                h = r.json()["hourly"]
                self._cache = {
                    "t": [datetime.fromisoformat(x).replace(tzinfo=TZ) for x in h["time"]],
                    "temp": h["temperature_2m"], "rh": h["relative_humidity_2m"],
                    "cloud": h["cloud_cover"], "wind": h["wind_speed_10m"],
                }
                self._fetched = time.time()
                self.last_error = None
            except Exception as exc:  # network down during demo -> climatology fallback
                self.last_error = str(exc)[:200]
                self._fetched = time.time() - 1500  # retry in ~5 min
            return self._cache

    def at(self, when: datetime, scenario: str, temp_delta: float = 0.0) -> Weather:
        when = when.astimezone(TZ)
        h = when.hour + when.minute / 60
        if scenario == "demo":
            s = _diurnal(h)
            w = Weather(26.0 + 16.5 * s, 62 - 36 * s, 5.0, 2.0, "demo_scenario")
        else:
            data = self._fetch()
            w = None
            if data:
                ts = data["t"]
                for i in range(len(ts) - 1):
                    if ts[i] <= when <= ts[i + 1]:
                        f = (when - ts[i]).total_seconds() / 3600
                        lerp = lambda k: data[k][i] + (data[k][i + 1] - data[k][i]) * f  # noqa: E731
                        w = Weather(lerp("temp"), lerp("rh"), lerp("cloud"), lerp("wind"), "open_meteo")
                        break
            if w is None:
                tmax, tmin, rh = PUNE_CLIMATE[when.month]
                s = _diurnal(h)
                w = Weather(tmin + (tmax - tmin) * s, rh + 30 * (1 - s), 30.0, 2.5, "climatology_fallback")
        w.air_c += temp_delta
        return w

    def hourly_outlook(self, start: datetime, scenario: str, hours: int = 3) -> list[dict]:
        return [{"time": (start + timedelta(minutes=30 * i)).isoformat(),
                 **self.at(start + timedelta(minutes=30 * i), scenario).as_dict()} for i in range(hours * 2 + 1)]


weather_service = WeatherService()
