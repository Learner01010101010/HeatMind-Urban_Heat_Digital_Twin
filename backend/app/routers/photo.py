"""Street-level photography for a point on the map, when any is actually available.

There is very little to work with here and the endpoint says so rather than
pretending. OpenStreetMap carries seven `wikimedia_commons` tags across this entire
37 km² zone, so tag-based imagery is not a source. Google Street View is not usable:
its terms do not permit deriving or storing from that imagery, and there is no key.

Mapillary is the one open street-level source with real coverage, and it needs a
token. That token lives in backend/.env as HEATMIND_MAPILLARY_TOKEN and is used
here, server side — the browser never sees it, and never calls Mapillary directly.

With no token configured the endpoint returns `available: false` and the client
falls back to showing the spot in the twin itself, which is a real view of that
location built from measured building heights and measured canopy. That is a weaker
answer than a photograph, and an honest one.
"""
from __future__ import annotations

import urllib.parse

import httpx
from fastapi import APIRouter, Query

from ..config import MAPILLARY_TOKEN

router = APIRouter(prefix="/api/photo", tags=["photo"])

# How far from the point a photo may have been taken and still show it.
RADIUS_DEG = 0.0012  # ~130 m
GRAPH = "https://graph.mapillary.com/images"


@router.get("/nearby")
async def nearby(lat: float = Query(...), lon: float = Query(...), limit: int = Query(3, ge=1, le=8)):
    """Street-level photos near a point, newest first."""
    if not MAPILLARY_TOKEN:
        return {
            "available": False,
            "reason": "no_provider",
            "note": ("No street-level imagery provider is configured. Set "
                     "HEATMIND_MAPILLARY_TOKEN in backend/.env to enable Mapillary "
                     "photos; the twin's own 3D view of the spot is used otherwise."),
            "photos": [],
        }
    bbox = f"{lon - RADIUS_DEG},{lat - RADIUS_DEG},{lon + RADIUS_DEG},{lat + RADIUS_DEG}"
    params = {
        "access_token": MAPILLARY_TOKEN,
        "fields": "id,thumb_1024_url,captured_at,compass_angle,computed_geometry",
        "bbox": bbox,
        "limit": str(limit),
    }
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(f"{GRAPH}?{urllib.parse.urlencode(params)}")
            r.raise_for_status()
            data = r.json()
    except Exception:
        # A photo is a nicety; never fail a route panel over it.
        return {"available": False, "reason": "provider_error", "photos": []}

    photos = [
        {
            "id": d.get("id"),
            "url": d.get("thumb_1024_url"),
            "captured_at": d.get("captured_at"),
            "bearing": d.get("compass_angle"),
        }
        for d in data.get("data", []) if d.get("thumb_1024_url")
    ]
    return {
        "available": bool(photos),
        "reason": "ok" if photos else "no_coverage",
        "attribution": "Imagery © Mapillary contributors, CC BY-SA",
        "photos": photos,
    }
