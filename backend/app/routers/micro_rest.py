from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import AwareDatetime, BaseModel, Field

from ..services.micro_rest import schedule

router = APIRouter(prefix="/api/micro-rest", tags=["micro-rest scheduling"])


class Position(BaseModel):
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)


class ScheduleRequest(BaseModel):
    origin: Position
    pickup: Position
    ready_at: AwareDatetime
    persona: Literal["student", "worker", "senior", "cyclist", "gig_worker"] = "gig_worker"


@router.post("/recommend")
def recommend(body: ScheduleRequest):
    try:
        return schedule(origin=(body.origin.lat, body.origin.lon), pickup=(body.pickup.lat, body.pickup.lon),
                        ready_at=body.ready_at, persona=body.persona)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
