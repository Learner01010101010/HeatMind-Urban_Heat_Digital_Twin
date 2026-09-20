"""HeatMind AI — FastAPI entry point.

Run:  uvicorn app.main:app --reload --port 8000     (from backend/)
Docs: http://localhost:8000/docs
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from .config import ALLOWED_ORIGINS, ANTHROPIC_API_KEY, BBOX, CENTER, COLOR_MAX_C, COLOR_MIN_C, ZONE_CITY, ZONE_NAME
from .db.session import init_db
from .routers import heat, passport, pois, risk, routes, shadow
from .services.heat_twin_service import get_twin
from .services.risk_scoring import weights_table
from .services.route_planner import get_planner
from .services.weather import base_time, weather_service
from .services.zone import get_zone


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    get_planner()  # warm the zone rasters + street graph
    tw = get_twin()
    tw.frame(base_time(), "live")
    yield


app = FastAPI(
    title="HeatMind AI",
    description="A living digital twin of urban heat — street by street, minute by minute, person by person.",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["*"], allow_headers=["*"])

for r in (heat.router, shadow.router, pois.router, routes.router, risk.router, passport.router):
    app.include_router(r)


@app.get("/api/health", tags=["meta"])
def health():
    return {"ok": True}


@app.get("/api/meta", tags=["meta"])
def meta():
    z = get_zone()
    return {
        "zone": {"name": ZONE_NAME, "city": ZONE_CITY, "bbox": list(BBOX), "center": list(CENTER),
                 "counts": z.data["meta"]["counts"], "osm_timestamp": z.data["meta"].get("osm_timestamp")},
        "clock": {"now": base_time().isoformat(), "server_tz": "Asia/Kolkata"},
        "color_scale": {"min_c": COLOR_MIN_C, "max_c": COLOR_MAX_C},
        "llm_enabled": bool(ANTHROPIC_API_KEY),
        "weather_error": weather_service.last_error,
        "risk_model": weights_table(),
        "provenance": [
            {"layer": "Street network", "source": "OpenStreetMap (Overpass)", "status": "real"},
            {"layer": "Building footprints", "source": "OpenStreetMap", "status": "real"},
            {"layer": "Building heights", "source": "OSM levels where tagged; typology estimate otherwise", "status": "mixed"},
            {"layer": "Land use / water", "source": "OpenStreetMap", "status": "real"},
            {"layer": "Tree canopy", "source": "Estimated street & campus canopy (no OSM tree survey here)", "status": "estimated"},
            {"layer": "Water / rest / shade points", "source": "OSM amenities + seeded points", "status": "mixed"},
            {"layer": "Sun position", "source": "NOAA solar ephemeris", "status": "real"},
            {"layer": "Ambient weather", "source": "Open-Meteo at the live current time (Pune climatology fallback offline)", "status": "mixed"},
            {"layer": "Surface heat", "source": "Physics-informed synthetic model (surface material × sun × shade)", "status": "modelled"},
        ],
    }


@app.get("/api/zone", tags=["meta"])
def zone():
    z = get_zone()
    return {"meta": z.data["meta"], "buildings": z.buildings_geojson(), "surfaces": z.surfaces_geojson(),
            "trees": z.trees_geojson(), "places": z.places}
