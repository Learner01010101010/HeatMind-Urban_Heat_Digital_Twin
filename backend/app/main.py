"""HeatMind AI — FastAPI entry point.

Run:  uvicorn app.main:app --reload --port 8000     (from backend/)
Docs: http://localhost:8000/docs
"""
from __future__ import annotations

import math
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from .config import ALLOWED_ORIGINS, ANTHROPIC_API_KEY, BBOX, CENTER, COLOR_MAX_C, COLOR_MIN_C, ZONE_CITY, ZONE_NAME
from .db.session import init_db
from .routers import community, equity, heat, open_data, passport, planner, pois, risk, routes, shadow
from .services.heat_twin_service import get_twin
from .services.risk_scoring import weights_table
from .services.route_planner import get_planner
from .services.weather import base_time, weather_service
from .services.zone import CODE_LABEL, get_zone


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

for r in (heat.router, shadow.router, pois.router, routes.router, risk.router, passport.router, equity.router, planner.router, community.router, open_data.router):
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
            {"layer": "Traffic heat", "source": "OSM road class weighted by a modelled Pune weekday/weekend congestion profile — no live traffic feed is available for this zone", "status": "modelled"},
            {"layer": "Industrial heat", "source": "Waste heat from footprints inferred as industrial; the OSM extract carries no industrial tags, so no premises here is confirmed industrial", "status": "modelled"},
            {"layer": "Sky view factor", "source": "Horizon scan of OSM building heights (32 azimuths, 200 m) — Oke canyon geometry", "status": "modelled"},
            {"layer": "Building typology", "source": "OSM building tag where present (37 of 998); geometry + land-use inference otherwise", "status": "mixed"},
            {"layer": "Heat vulnerability index", "source": "Environmental + infrastructure-access proxy (heat × cooling deficit × POI distance) — no demographic or census data used", "status": "modelled"},
        ],
    }


@app.get("/api/zone", tags=["meta"])
def zone():
    z = get_zone()
    return {"meta": z.data["meta"], "buildings": z.buildings_geojson(), "surfaces": z.surfaces_geojson(),
            "roads": z.roads_geojson(), "trees": z.trees_geojson(), "places": z.places}


@app.get("/api/anthropogenic", tags=["meta"])
def anthropogenic(time: str | None = None):
    """Traffic-congestion and industrial waste heat at a given time.

    Both are modelled, not measured — see services/anthropogenic.py for why and for the
    seam where a real traffic feed would attach.
    """
    from datetime import datetime

    from .services.anthropogenic import describe

    when = datetime.fromisoformat(time) if time else base_time()
    if when.tzinfo is None:
        when = when.replace(tzinfo=base_time().tzinfo)
    return describe(get_zone(), when)


@app.get("/api/zone/fields", tags=["meta"])
def zone_fields():
    """Static raster fields of the twin, for GPU upload by the 3D client.

    These are the *same* arrays the backend physics runs on, so anything the
    renderer derives from them (shadows, ambient occlusion) is consistent with the
    reported temperatures by construction rather than by coincidence.

    `origin` reproduces services.geo's local equirectangular projection exactly,
    which lets the client render in metres east/north of the SW corner and keep
    float32 vertex precision instead of fighting Mercator's 1e-9 scale.
    """
    import base64

    import numpy as np

    from .services import geo

    z = get_zone()
    h_scale = float(max(1.0, math.ceil(float(z.height.max()))))

    def u8(a: np.ndarray, scale: float = 1.0) -> str:
        v = np.clip(np.asarray(a, dtype=float) * (255.0 / scale), 0, 255).astype(np.uint8)
        return base64.b64encode(v.tobytes()).decode()

    return {
        "rows": geo.ROWS, "cols": geo.COLS, "cell_m": geo.CELL_M,
        "bbox": [geo.S, geo.W, geo.N, geo.E],
        "origin": {
            "lat0": geo.S, "lon0": geo.W,
            "m_per_deg_lat": geo.M_PER_DEG_LAT, "m_per_deg_lon": geo.M_PER_DEG_LON,
            "width_m": geo.WIDTH_M, "height_m": geo.HEIGHT_M,
        },
        "height_scale_m": h_scale,
        "encoding": {
            "height": f"uint8 base64, row-major from N; height_m = v * {h_scale} / 255",
            "canopy": "uint8 base64, canopy fraction = v / 255",
            "svf": "uint8 base64, sky view factor = v / 255 (0 = deep canyon, 1 = open sky)",
            "surface": "uint8 base64, raw surface class codes (see /api/meta provenance)",
            "road": "uint8 base64, 255 = carriageway cell",
        },
        "surface_classes": {str(i): lbl for i, lbl in enumerate(CODE_LABEL) if lbl},
        "height_b64": u8(z.height, h_scale),
        "canopy_b64": u8(z.canopy),
        "svf_b64": u8(z.svf),
        "surface_b64": base64.b64encode(z.surface.astype(np.uint8).tobytes()).decode(),
        "road_b64": base64.b64encode((z.road.astype(np.uint8) * 255).tobytes()).decode(),
    }
