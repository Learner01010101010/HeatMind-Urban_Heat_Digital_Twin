from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import HTTPException

from ..config import TZ
from ..services.weather import base_time


def resolve_time(scenario: str, time: str | None, offset_min: int = 0) -> datetime:
    if scenario not in ("demo", "live"):
        raise HTTPException(422, "scenario must be 'demo' or 'live'")
    if time and time != "now":
        try:
            t = datetime.fromisoformat(time.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(422, f"invalid time: {time}") from exc
        if t.tzinfo is None:
            t = t.replace(tzinfo=TZ)
        t = t.astimezone(TZ)
    else:
        t = base_time(scenario)
    return t + timedelta(minutes=offset_min)
