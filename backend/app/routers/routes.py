from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool

from ..schemas import CompareRequest, SimulateRequest
from ..services import geo
from ..services.route_planner import get_planner
from .common import resolve_time

router = APIRouter(prefix="/api/routes", tags=["routing"])


@router.post("/compare")
async def compare(req: CompareRequest):
    """≥2 candidate routes (fastest → coolest) with persona-weighted Heat Risk Scores, factor
    breakdowns, explanations, POIs along the route and a 0–120 min departure forecast.

    `mode` selects the vehicle: it sets the pace, restricts the search to streets that
    mode may legally use, and scales how much of the sun reaches the traveller. `bus`
    is answered by the transit planner instead — a walk/ride/walk itinerary over real
    PMPML stops, with a modelled headway (see services/transit.py)."""
    for p in (req.origin, req.destination):
        if not geo.in_bbox(p.lat, p.lon, 0.002):
            raise HTTPException(422, "Point is outside the digital-twin zone (Narhe to Swargate, Pune).")
    depart = resolve_time(req.scenario, req.depart_at, req.depart_offset_min)
    try:
        return await run_in_threadpool(
            get_planner().compare, origin=(req.origin.lat, req.origin.lon),
            destination=(req.destination.lat, req.destination.lon), persona=req.persona, scenario=req.scenario,
            depart=depart, temp_delta=req.temp_delta_c, mode=req.mode)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/simulate")
async def simulate(req: SimulateRequest):
    """Re-score under changed conditions (advance time / spike temperature) and suggest a reroute."""
    planner = get_planner()
    cid = req.compare_id or (req.route_id.rsplit("-", 1)[0] if req.route_id else None)
    if not cid or not planner.get(cid):
        raise HTTPException(404, "Unknown compare_id/route_id — run /api/routes/compare first.")
    return await run_in_threadpool(planner.simulate, compare_id=cid, route_id=req.route_id,
                                   time_offset_min=req.simulate.time_offset_min,
                                   temp_delta_c=req.simulate.temp_delta_c)


@router.get("/{route_id}")
def get_route(route_id: str):
    found = get_planner().find_route(route_id)
    if not found:
        raise HTTPException(404, "route not found (routes are kept in memory for recent comparisons)")
    return found[1]
