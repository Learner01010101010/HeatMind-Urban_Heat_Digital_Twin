"""Pydantic request models (responses are documented GeoJSON/JSON dicts)."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Persona = Literal["student", "worker", "senior", "cyclist", "gig_worker"]
Scenario = Literal["demo", "live"]


class LatLon(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)


class CompareRequest(BaseModel):
    origin: LatLon
    destination: LatLon
    persona: Persona = "student"
    scenario: Scenario = "live"
    depart_at: str | None = Field(None, description="ISO time; default = scenario clock ('now' in live mode)")
    depart_offset_min: int = Field(0, ge=0, le=720)
    temp_delta_c: float = Field(0.0, ge=-10, le=15)


class SimulateParams(BaseModel):
    time_offset_min: int = Field(0, ge=0, le=720)
    temp_delta_c: float = Field(0.0, ge=-10, le=15)


class SimulateRequest(BaseModel):
    compare_id: str | None = None
    route_id: str | None = None
    simulate: SimulateParams = SimulateParams()


class PersonaRequest(BaseModel):
    session_token: str = Field(..., min_length=8, max_length=128)
    persona: Persona
    seed_sample: bool = False


class CommunityPoiRequest(BaseModel):
    session_token: str = Field(..., min_length=8, max_length=128)
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    kind: Literal["water", "rest", "shade"]
    name: str = Field(..., min_length=1, max_length=80)
    note: str | None = Field(None, max_length=280)


class ModerateRequest(BaseModel):
    action: Literal["approve", "reject"]


class PassportLogRequest(BaseModel):
    user_id: int
    route_id: str | None = None
    trip_label: str | None = None
    minutes_total: float | None = None
    minutes_exposed: float | None = None
    heat_dose: float | None = None
    pct_shaded: float | None = None
    distance_m: float | None = None
    rest_stops_taken: int = 0
    heat_risk_score: float | None = None
    persona: Persona | None = None
