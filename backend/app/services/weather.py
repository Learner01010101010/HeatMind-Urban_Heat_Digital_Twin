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


# Haurwitz clear-sky global horizontal irradiance, W/m2, from solar elevation. Used
# only to normalise a *measured* irradiance into the 0..1 clearness the twin already
# runs on, so swapping a modelled sky for a measured one changes no calibration.
def clear_sky_ghi(elev_deg: float) -> float:
    s = math.sin(math.radians(elev_deg))
    if s <= 0.01:
        return 0.0
    return 1098.0 * s * math.exp(-0.059 / s)


@dataclass
class Weather:
    air_c: float
    rh: float
    cloud: float  # 0-100 %
    wind_ms: float
    source: str  # demo_scenario | open_meteo | climatology_fallback
    # Measured shortwave, W/m2. None when the provider did not give one, which is the
    # signal to fall back to the cloud-cover model rather than to invent a number.
    swr_wm2: float | None = None
    direct_wm2: float | None = None
    apparent_c: float | None = None
    wind_dir_deg: float | None = None
    precip_mm: float = 0.0

    def clearness(self, elev_deg: float) -> tuple[float, str]:
        """Fraction of clear-sky irradiance actually arriving, and where it came from.

        Measured shortwave beats cloud cover as a driver: cloud fraction says nothing
        about optical depth, and Pune's pre-monsoon haze and aerosol routinely cut
        surface irradiance by a third under a sky a satellite calls clear. Below ~5
        degrees of elevation the ratio is numerically unstable and worth nothing, so
        the modelled sky takes over there.
        """
        ghi0 = clear_sky_ghi(elev_deg)
        if self.swr_wm2 is not None and elev_deg > 5.0 and ghi0 > 20.0:
            return max(0.0, min(1.0, self.swr_wm2 / ghi0)), "measured"
        return 1 - 0.75 * (self.cloud / 100) ** 3.4, "modelled_from_cloud"

    def as_dict(self) -> dict:
        d = {"air_c": round(self.air_c, 1), "rh": round(self.rh), "cloud_pct": round(self.cloud),
             "wind_ms": round(self.wind_ms, 1), "source": self.source}
        if self.swr_wm2 is not None:
            d["shortwave_wm2"] = round(self.swr_wm2)
        if self.direct_wm2 is not None:
            d["direct_wm2"] = round(self.direct_wm2)
        if self.apparent_c is not None:
            d["apparent_c"] = round(self.apparent_c, 1)
        if self.wind_dir_deg is not None:
            d["wind_dir_deg"] = round(self.wind_dir_deg)
        if self.precip_mm:
            d["precip_mm"] = round(self.precip_mm, 1)
        return d


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
                            "hourly": ("temperature_2m,relative_humidity_2m,cloud_cover,"
                                       "wind_speed_10m,wind_direction_10m,apparent_temperature,"
                                       "shortwave_radiation,direct_radiation,precipitation"),
                            "timezone": "Asia/Kolkata", "past_days": 1, "forecast_days": 2,
                            "wind_speed_unit": "ms"},
                    timeout=6.0,
                )
                r.raise_for_status()
                h = r.json()["hourly"]
                self._cache = {
                    "t": [datetime.fromisoformat(x).replace(tzinfo=TZ) for x in h["time"]],
                    "temp": h["temperature_2m"], "rh": h["relative_humidity_2m"],
                    "cloud": h["cloud_cover"], "wind": h["wind_speed_10m"],
                    # Optional across providers/versions: absent stays absent rather
                    # than becoming a plausible-looking zero.
                    "swr": h.get("shortwave_radiation"), "direct": h.get("direct_radiation"),
                    "apparent": h.get("apparent_temperature"), "wind_dir": h.get("wind_direction_10m"),
                    "precip": h.get("precipitation"),
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

                        def opt(k: str) -> float | None:
                            """Interpolate an optional series, or None if it is absent."""
                            series = data.get(k)
                            if not series or series[i] is None or series[i + 1] is None:
                                return None
                            return series[i] + (series[i + 1] - series[i]) * f

                        w = Weather(lerp("temp"), lerp("rh"), lerp("cloud"), lerp("wind"), "open_meteo",
                                    swr_wm2=opt("swr"), direct_wm2=opt("direct"),
                                    apparent_c=opt("apparent"), wind_dir_deg=opt("wind_dir"),
                                    precip_mm=opt("precip") or 0.0)
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
