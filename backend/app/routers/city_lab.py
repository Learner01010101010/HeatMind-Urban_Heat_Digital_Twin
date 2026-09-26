from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.city_lab import catalog, plan

router = APIRouter(prefix="/api/city-lab", tags=["city demonstration lab"])
Area = Literal["narhe", "katraj", "swargate"]
Kind = Literal["trees", "cool_pavement", "shade_structure", "water_refill"]

# Real unit costs run to lakhs a unit, so a ward-scale budget has to reach crores
# for the tool to say anything. The old ceilings were sized for the demo figures.
MAX_BUDGET = 20_000_000
MAX_UNIT_COST = 2_000_000


class Project(BaseModel):
    site_id: str = Field(max_length=30)
    kind: Kind


class PlanRequest(BaseModel):
    area: Area = "narhe"
    mode: Literal["demo", "live"] = "demo"
    budget: int = Field(default=2_000_000, ge=0, le=MAX_BUDGET)
    costs: dict[Kind, int] = Field(default_factory=dict, max_length=4)
    projects: list[Project] | None = Field(default=None, max_length=12)
    catalog_time: str | None = Field(default=None, max_length=50)


@router.get("/catalog")
def get_catalog(area: Area = "narhe", mode: Literal["demo", "live"] = "demo"):
    try:
        return catalog(area, mode)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/plan")
def create_plan(body: PlanRequest):
    if any(not 1000 <= price <= MAX_UNIT_COST for price in body.costs.values()):
        raise HTTPException(422, f"Unit costs must be between ₹1,000 and ₹{MAX_UNIT_COST:,}.")
    try:
        data = catalog(body.area, body.mode)
        if body.catalog_time and body.catalog_time != data["time"]:
            raise ValueError("Live conditions changed. Refresh sites before evaluating this proposal.")
        return plan(data, body.budget, body.costs,
                    [p.model_dump() for p in body.projects] if body.projects is not None else None)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
