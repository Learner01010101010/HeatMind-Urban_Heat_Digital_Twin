from __future__ import annotations

import csv
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..services.city_lab import catalog, demo_readings, parse_readings, plan, validate_readings

router = APIRouter(prefix="/api/city-lab", tags=["city demonstration lab"])
Area = Literal["narhe", "katraj", "swargate"]
Kind = Literal["trees", "cool_pavement", "shade_structure", "water_refill"]
Metric = Literal["surface_c", "air_c", "feels_c"]


class Project(BaseModel):
    site_id: str = Field(max_length=30)
    kind: Kind


class PlanRequest(BaseModel):
    area: Area = "narhe"
    mode: Literal["demo", "live"] = "demo"
    budget: int = Field(default=150000, ge=0, le=1000000)
    costs: dict[Kind, int] = Field(default_factory=dict, max_length=4)
    projects: list[Project] | None = Field(default=None, max_length=12)
    catalog_time: str | None = Field(default=None, max_length=50)


class ValidationRequest(BaseModel):
    csv_text: str = Field(max_length=60000)
    tolerance_c: float = Field(default=2, ge=.1, le=10)


@router.get("/catalog")
def get_catalog(area: Area = "narhe", mode: Literal["demo", "live"] = "demo"):
    try:
        return catalog(area, mode)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/plan")
def create_plan(body: PlanRequest):
    if any(not 1000 <= price <= 500000 for price in body.costs.values()):
        raise HTTPException(422, "Unit costs must be between ₹1,000 and ₹500,000.")
    try:
        data = catalog(body.area, body.mode)
        if body.catalog_time and body.catalog_time != data["time"]:
            raise ValueError("Live conditions changed. Refresh sites before evaluating this proposal.")
        return plan(data, body.budget, body.costs,
                    [p.model_dump() for p in body.projects] if body.projects is not None else None)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/validation/demo")
def demo(area: Area = "narhe", metric: Metric = "surface_c", tolerance_c: float = Query(2, ge=.1, le=10)):
    return demo_readings(area, metric, tolerance_c)


@router.post("/validation")
def validate(body: ValidationRequest):
    try:
        return validate_readings(parse_readings(body.csv_text), body.tolerance_c)
    except (ValueError, csv.Error) as exc:
        raise HTTPException(422, str(exc)) from exc
