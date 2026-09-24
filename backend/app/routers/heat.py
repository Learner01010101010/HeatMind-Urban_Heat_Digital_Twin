from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..services.heat_twin_service import INTERVENTIONS, get_twin
from ..services.prediction_service import parse_horizon, predict
from .common import resolve_time

router = APIRouter(prefix="/api/heat", tags=["heat twin"])


@router.get("/twin")
def twin(scenario: str = "live", time: str | None = None, offset_min: int = Query(0, ge=0, le=720),
         temp_delta: float = Query(0.0, ge=-10, le=15), format: str = Query("grid", pattern="^(grid|geojson)$"),
         bbox: str | None = None):
    """Per-cell (10 m) pedestrian feels-like heat surface. `format=geojson` returns ~30 m polygons."""
    tw = get_twin()
    f = tw.frame(resolve_time(scenario, time, offset_min), scenario, temp_delta)
    out = tw.describe(f)
    if format == "geojson":
        out["surface"] = tw.geojson(f)
    else:
        out["grid"] = f.encode()
    return out


@router.get("/predict")
def heat_predict(horizon: str = "30m", scenario: str = "live", time: str | None = None,
                 temp_delta: float = Query(0.0, ge=-10, le=15), include_grid: bool = True):
    """Predicted heat surface at +30m / +1h / +2h (physics-informed nowcast)."""
    mins = parse_horizon(horizon)
    base = resolve_time(scenario, time)
    out = predict(base, mins, scenario, temp_delta)
    if include_grid:
        from datetime import timedelta
        tw = get_twin()
        out["grid"] = tw.frame(base + timedelta(minutes=mins), scenario, temp_delta).encode()
    return out


@router.get("/point")
def heat_point(lat: float, lon: float, scenario: str = "live", time: str | None = None,
               offset_min: int = Query(0, ge=0, le=720), temp_delta: float = 0.0):
    """Inspect the twin at one location: feels-like, surface temperature, shade, material."""
    tw = get_twin()
    f = tw.frame(resolve_time(scenario, time, offset_min), scenario, temp_delta)
    return tw.sample(f, lat, lon)


@router.get("/interventions")
def list_interventions():
    """Catalog of intervention types the simulator supports, with their modelling caveats."""
    return {"kinds": [{"kind": k, **v} for k, v in INTERVENTIONS.items()]}


@router.get("/intervene")
def simulate_intervention(lat: float, lon: float, kind: str, radius_m: float = Query(20.0, ge=5, le=60),
                          scenario: str = "live", time: str | None = None,
                          offset_min: int = Query(0, ge=0, le=720), temp_delta: float = 0.0):
    """SDG 13/15 — 'what if we planted trees / cool-paved / shaded this spot?'

    Re-runs the same physics-informed heat formula on a small patch around
    (lat, lon) with the intervention applied, and reports the before/after
    feels-like temperature and shade coverage in that patch.
    """
    tw = get_twin()
    f = tw.frame(resolve_time(scenario, time, offset_min), scenario, temp_delta)
    try:
        return tw.simulate_intervention(f, lat, lon, kind, radius_m)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/layers")
def heat_layers(scenario: str = "live", time: str | None = None, offset_min: int = Query(0, ge=0, le=720),
                temp_delta: float = Query(0.0, ge=-10, le=15)):
    """Heat Twin overlays: cooling corridors (coolest 22% of street edges), hot streets and hotspot points."""
    from ..services.heat_twin_service import twin_layers
    from ..services.route_planner import get_planner
    tw = get_twin()
    f = tw.frame(resolve_time(scenario, time, offset_min), scenario, temp_delta)
    return twin_layers(f, get_planner().graph)
