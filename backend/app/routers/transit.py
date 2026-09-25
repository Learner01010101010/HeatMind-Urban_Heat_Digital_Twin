from __future__ import annotations

from fastapi import APIRouter

from ..services import transit as transit_service
from ..services import transit_routing

router = APIRouter(prefix="/api/transit", tags=["transit"])


@router.get("/stops")
def stops():
    """Bus stops in the zone, as GeoJSON points.

    Real OpenStreetMap records — names, operators and, where tagged, whether the stop
    has a shelter. The shelter flag is the one a heat product cares about: it is the
    difference between waiting for a bus in the sun and waiting for it in shade.
    """
    return transit_routing.stop_features()


@router.get("/describe")
def describe():
    """What the transit layer knows, and what it is only assuming."""
    return transit_service.describe()
