from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/api", tags=["open data (SDG 17)"])

CATALOG = [
    {"id": "zone", "title": "Zone geometry", "format": "GeoJSON", "endpoint": "/api/zone",
     "provenance": "OpenStreetMap (Overpass)", "status": "real",
     "description": "Buildings, surfaces, trees and named places for the demo zone."},
    {"id": "heat_twin", "title": "Live heat surface", "format": "GeoJSON polygons or raster grid", "endpoint": "/api/heat/twin?format=geojson",
     "provenance": "Physics-informed synthetic model, calibrated on live weather", "status": "modelled",
     "description": "10 m pedestrian feels-like temperature, refreshed live. Accepts scenario/time/temp_delta params."},
    {"id": "heat_predict", "title": "3-hour heat forecast", "format": "JSON + grid", "endpoint": "/api/heat/predict?horizon=1h",
     "provenance": "Re-run shadow engine + interpolated Open-Meteo forecast", "status": "modelled",
     "description": "Forward-projected heat surface at +30m/+1h/+2h/+3h keyframes."},
    {"id": "equity_index", "title": "Heat vulnerability index", "format": "GeoJSON", "endpoint": "/api/equity/index",
     "provenance": "Environmental + infrastructure-access proxy — no demographic data", "status": "modelled",
     "description": "SDG 10 composite of heat exposure, cooling deficit and cooling-access distance, per ~40m block."},
    {"id": "planner_report", "title": "Municipal Heat Action Brief", "format": "JSON", "endpoint": "/api/planner/report",
     "provenance": "Derived from the heat twin + real OSM street graph", "status": "modelled",
     "description": "Named streets ranked by pedestrian heat-exposure priority for intervention planning."},
    {"id": "pois", "title": "Water / rest / shade points", "format": "GeoJSON", "endpoint": "/api/pois",
     "provenance": "OSM amenities + seeded points", "status": "mixed",
     "description": "Cooling infrastructure locations used for routing and the equity index."},
    {"id": "community_pois", "title": "Crowdsourced cooling points", "format": "GeoJSON", "endpoint": "/api/community/pois?status=approved",
     "provenance": "Community-submitted, moderated before publication", "status": "mixed",
     "description": "SDG 6 — resident-submitted water/rest/shade points, reviewed before appearing here."},
    {"id": "risk_weights", "title": "Persona risk-weighting model", "format": "JSON", "endpoint": "/api/risk/weights",
     "provenance": "This app's transparent scoring model", "status": "real",
     "description": "The full per-persona factor-weight table the risk engine actually uses — not a black box."},
]


@router.get("/open-data")
def open_data_catalog():
    """SDG 17 — machine-readable catalog of every open dataset this app publishes.

    For researchers and municipalities who want to build on this data instead
    of starting over: every entry below is a live, documented, CORS-open
    endpoint with its own provenance tag (see /api/meta for the full
    real/mixed/estimated/modelled breakdown of underlying layers).
    """
    return {
        "license": "Code: MIT. Data: attribute HeatMind AI + original sources (OpenStreetMap © OpenStreetMap contributors, Open-Meteo).",
        "docs": "/docs",
        "datasets": CATALOG,
    }
