from __future__ import annotations

from fastapi import APIRouter, Query

from ..services.heat_twin_service import get_twin
from ..services.planner_report import report
from .common import resolve_time

router = APIRouter(prefix="/api/planner", tags=["municipal planner"])


@router.get("/report")
def planner_report(scenario: str = "live", time: str | None = None, offset_min: int = Query(0, ge=0, le=720),
                    temp_delta: float = 0.0, top_n: int = Query(12, ge=1, le=40)):
    """SDG 11 — ranked worst pedestrian-exposure streets for a municipal Heat Action Brief."""
    tw = get_twin()
    f = tw.frame(resolve_time(scenario, time, offset_min), scenario, temp_delta)
    return report(f, top_n)
