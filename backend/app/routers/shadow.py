from __future__ import annotations

from fastapi import APIRouter, Query

from ..services.heat_twin_service import get_twin
from ..services.shadow_engine import building_shadow_polygons
from .common import resolve_time

router = APIRouter(prefix="/api", tags=["shadow engine"])


@router.get("/shadow")
def shadow(scenario: str = "live", time: str | None = None, offset_min: int = Query(0, ge=0, le=720),
           bbox: str | None = None):
    """Building shadow polygons (h / tan(elevation), cast at azimuth + 180°) for the given time."""
    tw = get_twin()
    f = tw.frame(resolve_time(scenario, time, offset_min), scenario)
    return {
        "time": f.when.isoformat(),
        "sun": {"elevation_deg": round(f.elev, 1), "azimuth_deg": round(f.az, 1)},
        "shadows": building_shadow_polygons(tw.zone, f.elev, f.az),
        "pct_walkable_shaded": f.stats["pct_shaded"],
    }
