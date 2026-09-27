from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from ..schemas import LatLon
from ..services import geo
from ..services.dynamic_rerouting import check, settings
from ..services.route_planner import get_planner

router = APIRouter(prefix="/api/routes/dynamic", tags=["optional route updates"])


class CheckRequest(BaseModel):
    compare_id: str = Field(min_length=1, max_length=64)
    route_id: str = Field(min_length=1, max_length=64)
    position: LatLon


class AcceptRequest(CheckRequest):
    consent: Literal[True]  # Required only on the acceptance endpoint.


@router.get("/settings")
def get_settings():
    return settings()


async def perform(req, accept):
    if not geo.in_bbox(req.position.lat, req.position.lon):
        raise HTTPException(422, "Current position is outside the digital-twin zone.")
    try:
        return await run_in_threadpool(check, get_planner(), req.compare_id, req.route_id,
                                      (req.position.lat, req.position.lon), accept=accept)
    except KeyError as exc:
        raise HTTPException(404, "Trip expired; plan your journey again.") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc


@router.post("/check")
async def check_conditions(req: CheckRequest):
    return await perform(req, False)


@router.post("/accept")
async def accept_suggestion(req: AcceptRequest):
    # Always recalculate from the submitted current position, never use stale geometry.
    return await perform(req, True)
