from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..schemas import CommunityPoiRequest, ModerateRequest
from ..services import community_pois as cp

router = APIRouter(prefix="/api/community", tags=["community points (SDG 6)"])


@router.post("/pois")
def submit_poi(req: CommunityPoiRequest):
    """Submit a water/rest/shade point for review — starts 'pending', not shown on the map yet."""
    try:
        return cp.submit(req.session_token, req.lat, req.lon, req.kind, req.name, req.note)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/pois")
def community_pois(status: str | None = Query("approved", pattern="^(pending|approved|rejected)?$")):
    """Approved community points as GeoJSON, mergeable with the OSM/seeded POI layer."""
    items = cp.list_pois(status)
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": p["id"],
         "properties": {"kind": p["kind"], "name": p["name"], "status": p["status"], "source": "community",
                        "note": p["note"], "submitted_at": p["submitted_at"]},
         "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]}} for p in items]}


@router.post("/pois/{poi_id}/moderate")
def moderate_poi(poi_id: int, req: ModerateRequest):
    try:
        return cp.moderate(poi_id, req.action)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(404, "poi not found") from exc
