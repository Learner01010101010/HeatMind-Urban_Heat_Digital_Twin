from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..schemas import PassportLogRequest, PersonaRequest
from ..services import passport_service as ps
from ..services.heat_alerts import clinical_alert
from ..services.heat_twin_service import get_twin
from ..services.route_planner import get_planner
from ..services.weather import base_time

router = APIRouter(prefix="/api", tags=["passport & users"])


@router.post("/users/persona")
def set_persona(req: PersonaRequest):
    user = ps.get_or_create_user(req.session_token, req.persona, req.seed_sample)
    return {"user_id": user["id"], "persona": user["persona"], "created": user["created"]}


@router.get("/passport/{user_id}")
def passport(user_id: int):
    try:
        s = ps.summary(user_id)
    except KeyError as exc:
        raise HTTPException(404, "user not found") from exc
    f = get_twin().frame(base_time(), "live")
    s["clinical_alert"] = clinical_alert(s["persona"], f.stats["city_level_feels_c"], s["today"]["budget_used_pct"])
    return s


@router.post("/passport/log")
def passport_log(req: PassportLogRequest):
    route = None
    if req.route_id:
        found = get_planner().find_route(req.route_id)
        route = found[1] if found else None
    fields = {k: v for k, v in req.model_dump().items() if v is not None and k not in ("user_id", "route_id")}
    if route is None and req.minutes_total is None:
        raise HTTPException(422, "Provide a route_id from a recent comparison, or explicit trip metrics.")
    try:
        return ps.log_trip(req.user_id, route, fields)
    except Exception as exc:  # FK failure etc.
        raise HTTPException(400, f"could not log trip: {exc}") from exc


@router.delete("/passport/{user_id}/sample")
def clear_sample(user_id: int):
    return {"removed": ps.clear_sample(user_id)}
