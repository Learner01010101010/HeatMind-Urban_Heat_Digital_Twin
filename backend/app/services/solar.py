"""Solar position (NOAA General Solar Position algorithm) — no external dependency."""
from __future__ import annotations

import math
from datetime import datetime, timezone


def solar_position(when: datetime, lat: float, lon: float) -> tuple[float, float]:
    """Return (elevation_deg, azimuth_deg clockwise from north) for an aware datetime."""
    utc = when.astimezone(timezone.utc)
    doy = utc.timetuple().tm_yday
    hour = utc.hour + utc.minute / 60 + utc.second / 3600
    g = 2 * math.pi / 365 * (doy - 1 + (hour - 12) / 24)

    eqtime = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
                       - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    decl = (0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g)
            + 0.000907 * math.sin(2 * g) - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g))

    tst = hour * 60 + eqtime + 4 * lon  # true solar time (minutes)
    ha = math.radians(tst / 4 - 180)
    phi = math.radians(lat)

    cos_zen = math.sin(phi) * math.sin(decl) + math.cos(phi) * math.cos(decl) * math.cos(ha)
    cos_zen = max(-1.0, min(1.0, cos_zen))
    zen = math.acos(cos_zen)
    elev = 90 - math.degrees(zen)

    # Azimuth measured clockwise from north (atan2 form, stable at solar noon)
    az = math.degrees(math.atan2(math.sin(ha), math.cos(ha) * math.sin(phi) - math.tan(decl) * math.cos(phi))) + 180
    az = az % 360
    # Atmospheric refraction (small correction near horizon)
    if -0.575 < elev < 85:
        elev += 1.02 / math.tan(math.radians(elev + 10.3 / (elev + 5.11))) / 60
    return elev, az
