"""Real ground elevation for the zone.

The corridor is not flat. Narhe sits around 610 m, Swargate around 576 m, and the
Katraj ridge between them runs past 800 m — 274 m of relief across a walk the map
used to draw on a plane. That is not decoration: a climb changes how long a route
takes, how hard the walker is working when they get there, and which slopes face the
afternoon sun.

The grid is built by scripts/fetch_terrain.py from Copernicus DEM GLO-30 and cached
as backend/data/terrain.json. If that file is missing the twin simply stays flat —
elevation is an enhancement to a scene that was complete without it, and a missing
optional raster should not take the zone endpoint down with it.
"""
from __future__ import annotations

import base64
import json
from functools import lru_cache
from pathlib import Path

import numpy as np

from ..config import ZONE_FILE
from . import geo

TERRAIN_FILE = ZONE_FILE.parent / "terrain.json"


@lru_cache(maxsize=1)
def elevation() -> np.ndarray | None:
    """Ground elevation in metres on the twin's own grid, or None if not fetched."""
    if not TERRAIN_FILE.exists():
        return None
    d = json.loads(TERRAIN_FILE.read_text())
    rows, cols = int(d["rows"]), int(d["cols"])
    if (rows, cols) != (geo.ROWS, geo.COLS):
        # Wrong shape is worse than absent: it would slide the city against its own
        # streets by however many cells it is out.
        raise ValueError(f"terrain.json is {rows}x{cols}, the twin grid is {geo.ROWS}x{geo.COLS}")
    p = np.frombuffer(base64.b64decode(d["data"]), dtype=np.uint8).reshape(rows, cols, 2)
    u = (p[:, :, 0].astype(np.uint32) << 8) | p[:, :, 1].astype(np.uint32)
    lo, hi = float(d["min_m"]), float(d["max_m"])
    return (lo + (u / 65535.0) * (hi - lo)).astype(np.float32)


@lru_cache(maxsize=1)
def describe() -> dict:
    """Range and provenance, for the fields payload and the provenance table."""
    if not TERRAIN_FILE.exists():
        return {"available": False}
    d = json.loads(TERRAIN_FILE.read_text())
    return {
        "available": True,
        "min_m": d["min_m"],
        "max_m": d["max_m"],
        "relief_m": round(d["max_m"] - d["min_m"], 1),
        "source": d["source"],
        "surface_removed_p95_m": d.get("surface_removed_p95_m"),
    }


def planes_b64() -> tuple[str, str] | None:
    """Elevation as two uint8 planes, high byte and low byte.

    Two planes rather than one because 8 bits over 274 m of relief is a 1.1 m step,
    and the shader takes a difference of neighbours to get its surface normal: the
    quantisation that is invisible on the ground lands straight in the lighting as
    banded facets. 16 bits puts the step at 4 mm.
    """
    e = elevation()
    if e is None:
        return None
    d = json.loads(TERRAIN_FILE.read_text())
    lo, hi = float(d["min_m"]), float(d["max_m"])
    u = np.round(np.clip((e - lo) / max(hi - lo, 1e-6), 0, 1) * 65535).astype(np.uint16)
    hi_b = base64.b64encode((u >> 8).astype(np.uint8).tobytes()).decode()
    lo_b = base64.b64encode((u & 0xFF).astype(np.uint8).tobytes()).decode()
    return hi_b, lo_b
