from __future__ import annotations

from fastapi import APIRouter, Query

from ..services import equity as equity_service
from ..services.heat_twin_service import get_twin
from .common import resolve_time

router = APIRouter(prefix="/api/equity", tags=["heat equity"])


@router.get("/index")
def equity_index(scenario: str = "live", time: str | None = None, offset_min: int = Query(0, ge=0, le=720),
                 temp_delta: float = 0.0, agg: int = Query(4, ge=1, le=10)):
    """SDG 10 — Heat Vulnerability Index: heat x cooling-deficit x cooling-access-deficit.

    NOT a demographic layer (no census/income data exists for this zone) — an
    environmental + infrastructure-access proxy. See the module docstring in
    app/services/equity.py and the About page for full methodology.
    """
    tw = get_twin()
    f = tw.frame(resolve_time(scenario, time, offset_min), scenario, temp_delta)
    return {
        "summary": equity_service.equity_summary(f),
        "surface": equity_service.equity_geojson(f, agg=agg),
        "methodology": "index = 45% heat exposure + 30% cooling deficit (canopy+water) + 25% distance to nearest water/rest/shade/cooling point",
    }
