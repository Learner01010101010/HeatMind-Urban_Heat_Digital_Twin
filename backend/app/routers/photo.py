"""Attributed Commons place photos, then clearly labelled nearby street imagery."""
from __future__ import annotations

import html
import math
import re
import time

import httpx
from fastapi import APIRouter, Query

from ..config import MAPILLARY_TOKEN
from ..services.zone import get_zone

router = APIRouter(prefix="/api/photo", tags=["photo"])
_cache = {}


def plain(value):
    return html.unescape(re.sub(r"<[^>]+>", "", str(value or "")))[:300]


def distance_m(lat, lon, coords):
    x = math.radians(coords[0] - lon) * math.cos(math.radians(lat))
    y = math.radians(coords[1] - lat)
    return math.hypot(x, y) * 6371000


async def commons_photo(client, poi):
    title = poi.get("wikimedia_commons", "")
    if not title.startswith("File:") and re.fullmatch(r"Q\d+", poi.get("wikidata", "")):
        r = await client.get("https://www.wikidata.org/w/api.php", params={"action": "wbgetclaims", "entity": poi["wikidata"], "property": "P18", "format": "json"})
        r.raise_for_status()
        claims = r.json().get("claims", {}).get("P18", [])
        if claims:
            title = "File:" + claims[0]["mainsnak"]["datavalue"]["value"]
    if not title.startswith("File:"):
        return None
    r = await client.get("https://commons.wikimedia.org/w/api.php", params={"action": "query", "titles": title, "prop": "imageinfo", "iiprop": "url|extmetadata", "iiurlwidth": 640, "format": "json"})
    r.raise_for_status()
    for page in r.json().get("query", {}).get("pages", {}).values():
        info = page.get("imageinfo", [{}])[0]
        meta = info.get("extmetadata", {})
        license_name = plain(meta.get("LicenseShortName", {}).get("value"))
        url = info.get("thumburl") or info.get("url", "")
        if license_name and url.startswith("https://upload.wikimedia.org/"):
            return {"id": title, "url": url, "kind": "place", "attribution": plain(meta.get("Artist", {}).get("value")) + " · " + license_name,
                    "source_url": info.get("descriptionurl", "https://commons.wikimedia.org"), "captured_at": None}
    return None


@router.get("/nearby")
async def nearby(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180),
                 limit: int = Query(3, ge=1, le=8), poi_id: str | None = None):
    poi = next((p for p in get_zone().pois if p["id"] == poi_id), None) if poi_id else None
    if poi:
        lat, lon = poi["lat"], poi["lon"]
    key = (round(lat, 5), round(lon, 5), poi_id, limit)
    cached = _cache.get(key)
    if cached and time.time() - cached[0] < 3600:
        return cached[1]
    photos, reason = [], "no_provider" if not MAPILLARY_TOKEN else "no_coverage"
    async with httpx.AsyncClient(timeout=3.0, headers={"User-Agent": "HeatMind/1.0 (urban heat twin; place imagery)"}) as client:
        if poi and poi.get("source") == "osm":
            try:
                photo = await commons_photo(client, poi)
                if photo:
                    photos.append(photo)
            except Exception:
                reason = "provider_error"
        if not photos and MAPILLARY_TOKEN:
            try:
                radius = .0012
                r = await client.get("https://graph.mapillary.com/images", params={
                    "access_token": MAPILLARY_TOKEN, "fields": "id,thumb_1024_url,captured_at,computed_geometry",
                    "bbox": f"{lon-radius},{lat-radius},{lon+radius},{lat+radius}", "limit": 20})
                r.raise_for_status()
                for d in r.json().get("data", []):
                    coords = d.get("computed_geometry", {}).get("coordinates", [])
                    if len(coords) != 2 or not d.get("thumb_1024_url", "").startswith("https://"):
                        continue
                    dist = distance_m(lat, lon, coords)
                    if dist <= 120:
                        photos.append({"id": d["id"], "url": d["thumb_1024_url"], "captured_at": d.get("captured_at"),
                                       "distance_m": round(dist), "kind": "nearby", "attribution": "Mapillary contributors · CC BY-SA",
                                       "source_url": f"https://www.mapillary.com/app/?pKey={d['id']}"})
                photos.sort(key=lambda p: p.get("distance_m", 0))
            except Exception:
                reason = "provider_error"
    result = {"available": bool(photos), "reason": "ok" if photos else reason, "photos": photos[:limit],
              "note": "Nearby street imagery may not show this exact facility; check the location and capture date."}
    if len(_cache) >= 256:
        _cache.clear()
    _cache[key] = time.time(), result
    return result
