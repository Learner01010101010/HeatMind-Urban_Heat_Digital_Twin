"""Sky View Factor — the fraction of the sky hemisphere visible from each cell.

SVF is the standard urban-climatology descriptor of canyon geometry (Oke 1981;
used by SOLWEIG / UMEP).  It is computed once per zone and is *independent of
sun position*, so it is cached to disk and reused by every frame.

Two consumers, one field:
  * physics  — long-wave trapping in the street canyon scales with (1 - SVF),
               a principled replacement for the box-blurred built-density proxy.
  * renderer — (1 - SVF) is exactly an ambient-occlusion term, so the 3D twin
               gets physically-derived contact shading for free from this buffer.

Only buildings occlude here.  Vegetation is deliberately excluded: the heat model
already carries explicit canopy shade (sun_exposure) and evapotranspiration
(canopy_cooling) terms, and folding trees in again would double-count them.
"""
from __future__ import annotations

import json
import math

import numpy as np

from ..config import DATA_DIR, ZONE_FILE
from . import geo
from .shadow_engine import PEDESTRIAN_HEAD_M

N_AZIMUTH = 32
MAX_RAY_M = 200.0
RAY_STEP_M = 5.0

_CACHE = DATA_DIR / "svf.npy"
_STAMP = DATA_DIR / "svf.meta.json"


def _stamp() -> dict:
    st = ZONE_FILE.stat()
    return {
        "zone_mtime": int(st.st_mtime), "zone_size": st.st_size,
        "rows": geo.ROWS, "cols": geo.COLS, "cell_m": geo.CELL_M,
        "n_azimuth": N_AZIMUTH, "max_ray_m": MAX_RAY_M, "ray_step_m": RAY_STEP_M,
        "head_m": PEDESTRIAN_HEAD_M,
    }


def compute(height: np.ndarray, building: np.ndarray) -> np.ndarray:
    """Horizon-scan SVF: for each azimuth find the largest blocked elevation angle.

    SVF = 1 - mean_over_azimuths( sin^2(theta_max) )

    The sin^2 weighting is the projected solid angle of the blocked wedge, i.e.
    the standard hemispherical form rather than a raw angular average.
    """
    R, C = height.shape
    rows, cols = np.indices((R, C))
    # Observer stands on whatever surface the cell is (ground, or a rooftop).
    base = np.where(building, height, 0.0) + PEDESTRIAN_HEAD_M
    n_steps = int(MAX_RAY_M / RAY_STEP_M)
    acc = np.zeros((R, C))

    for a in range(N_AZIMUTH):
        az = 2 * math.pi * a / N_AZIMUTH
        dx, dy = math.sin(az), math.cos(az)
        tan_max = np.zeros((R, C))
        for k in range(1, n_steps + 1):
            d = k * RAY_STEP_M
            ri = np.rint(rows - dy * d / geo.CELL_M).astype(np.int32)
            ci = np.rint(cols + dx * d / geo.CELL_M).astype(np.int32)
            ok = (ri >= 0) & (ri < R) & (ci >= 0) & (ci < C)
            np.clip(ri, 0, R - 1, out=ri)
            np.clip(ci, 0, C - 1, out=ci)
            dh = height[ri, ci] - base
            t = np.where(ok & (dh > 0), dh / d, 0.0)
            np.maximum(tan_max, t, out=tan_max)
        theta = np.arctan(tan_max)
        acc += np.sin(theta) ** 2

    return np.clip(1.0 - acc / N_AZIMUTH, 0.0, 1.0)


def load(height: np.ndarray, building: np.ndarray) -> np.ndarray:
    """Cached SVF for this zone, recomputing only when the zone or params change."""
    want = _stamp()
    if _CACHE.exists() and _STAMP.exists():
        try:
            if json.loads(_STAMP.read_text(encoding="utf8")) == want:
                svf = np.load(_CACHE)
                if svf.shape == height.shape:
                    return svf
        except (OSError, ValueError, json.JSONDecodeError):
            pass  # unreadable cache -> just recompute
    svf = compute(height, building)
    try:
        np.save(_CACHE, svf.astype(np.float32))
        _STAMP.write_text(json.dumps(want), encoding="utf8")
    except OSError:
        pass  # read-only data dir is survivable; we just recompute next boot
    return svf
