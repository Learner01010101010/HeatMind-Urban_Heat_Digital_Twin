from __future__ import annotations

from fastapi import APIRouter

from ..services.zone import get_zone

router = APIRouter(prefix="/api", tags=["points of interest"])


@router.get("/pois")
def pois(type: str | None = None, bbox: str | None = None):
    """Water, rest, shade and cooling-centre points (OSM-derived + seeded, flagged by `source`)."""
    items = get_zone().pois
    if type:
        wanted = {t.strip() for t in type.split(",")}
        items = [p for p in items if p["type"] in wanted]
    if bbox:
        s, w, n, e = map(float, bbox.split(","))
        items = [p for p in items if s <= p["lat"] <= n and w <= p["lon"] <= e]
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": p["id"], "properties": {k: v for k, v in p.items() if k not in ("lat", "lon")},
         "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]}} for p in items]}


@router.get("/places")
def places(q: str | None = None):
    items = get_zone().places
    if q:
        ql = q.lower()
        items = [p for p in items if ql in p["name"].lower()]
    return sorted(items, key=lambda p: (not p.get("featured"), p["name"]))
