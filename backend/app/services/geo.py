"""Lightweight geospatial helpers (local metric projection + rasterisation).

The zone is ~1.5 km across, so an equirectangular projection around the zone
centre is accurate to well under a metre — no PROJ/GEOS dependency needed.
"""
from __future__ import annotations

import math
from typing import Iterable, Sequence

import numpy as np

from ..config import BBOX, CELL_M

S, W, N, E = BBOX
LAT0 = (S + N) / 2
M_PER_DEG_LAT = 110_540.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(LAT0))

WIDTH_M = (E - W) * M_PER_DEG_LON
HEIGHT_M = (N - S) * M_PER_DEG_LAT
COLS = int(math.ceil(WIDTH_M / CELL_M))
ROWS = int(math.ceil(HEIGHT_M / CELL_M))


def to_xy(lat: float, lon: float) -> tuple[float, float]:
    """lat/lon -> metres east/north of the SW corner."""
    return (lon - W) * M_PER_DEG_LON, (lat - S) * M_PER_DEG_LAT


def to_latlon(x: float, y: float) -> tuple[float, float]:
    return S + y / M_PER_DEG_LAT, W + x / M_PER_DEG_LON


def xy_to_cell(x: float, y: float) -> tuple[int, int]:
    """metres -> (row, col); row 0 is the northern edge (image convention)."""
    c = int(x // CELL_M)
    r = int((HEIGHT_M - y) // CELL_M)
    return min(max(r, 0), ROWS - 1), min(max(c, 0), COLS - 1)


def latlon_to_cell(lat: float, lon: float) -> tuple[int, int]:
    return xy_to_cell(*to_xy(lat, lon))


def in_bbox(lat: float, lon: float, pad: float = 0.0) -> bool:
    return S - pad <= lat <= N + pad and W - pad <= lon <= E + pad


def haversine_m(a: Sequence[float], b: Sequence[float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(h))


def cell_centers() -> tuple[np.ndarray, np.ndarray]:
    """Arrays (ROWS, COLS) of cell-centre x, y in metres."""
    xs = (np.arange(COLS) + 0.5) * CELL_M
    ys = HEIGHT_M - (np.arange(ROWS) + 0.5) * CELL_M
    return np.meshgrid(xs, ys)


_CX, _CY = cell_centers()


def polygon_mask(ring_xy: Sequence[tuple[float, float]]) -> tuple[slice, slice, np.ndarray] | None:
    """Even-odd point-in-polygon test of cell centres inside the ring's bbox.

    Returns (row_slice, col_slice, bool_mask) or None if outside the grid.
    """
    pts = np.asarray(ring_xy, dtype=float)
    if len(pts) < 3:
        return None
    x0, y0 = pts.min(axis=0)
    x1, y1 = pts.max(axis=0)
    c0 = max(int(x0 // CELL_M), 0)
    c1 = min(int(x1 // CELL_M) + 1, COLS)
    r0 = max(int((HEIGHT_M - y1) // CELL_M), 0)
    r1 = min(int((HEIGHT_M - y0) // CELL_M) + 1, ROWS)
    if c0 >= c1 or r0 >= r1:
        return None
    px = _CX[r0:r1, c0:c1]
    py = _CY[r0:r1, c0:c1]
    inside = np.zeros(px.shape, dtype=bool)
    xj, yj = pts[-1]
    for xi, yi in pts:
        cond = (yi > py) != (yj > py)
        with np.errstate(divide="ignore", invalid="ignore"):
            xint = (xj - xi) * (py - yi) / (yj - yi) + xi
        inside ^= cond & (px < xint)
        xj, yj = xi, yi
    if not inside.any():
        # Tiny polygon smaller than a cell: mark the cell containing its centroid.
        cx, cy = pts.mean(axis=0)
        r, c = xy_to_cell(cx, cy)
        if r0 <= r < r1 and c0 <= c < c1:
            inside[r - r0, c - c0] = True
    return slice(r0, r1), slice(c0, c1), inside


def line_mask(line_xy: Sequence[tuple[float, float]], half_width: float) -> Iterable[tuple[slice, slice, np.ndarray]]:
    """Cells whose centre lies within half_width of each segment of a polyline."""
    pts = np.asarray(line_xy, dtype=float)
    for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
        pad = half_width + CELL_M
        c0 = max(int((min(ax, bx) - pad) // CELL_M), 0)
        c1 = min(int((max(ax, bx) + pad) // CELL_M) + 1, COLS)
        r0 = max(int((HEIGHT_M - max(ay, by) - pad) // CELL_M), 0)
        r1 = min(int((HEIGHT_M - min(ay, by) + pad) // CELL_M) + 1, ROWS)
        if c0 >= c1 or r0 >= r1:
            continue
        px = _CX[r0:r1, c0:c1]
        py = _CY[r0:r1, c0:c1]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        if L2 == 0:
            t = np.zeros_like(px)
        else:
            t = np.clip(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1)
        d = np.hypot(px - (ax + t * dx), py - (ay + t * dy))
        yield slice(r0, r1), slice(c0, c1), d <= max(half_width, CELL_M * 0.5)


def disk_mask(x: float, y: float, radius: float) -> tuple[slice, slice, np.ndarray] | None:
    c0 = max(int((x - radius) // CELL_M), 0)
    c1 = min(int((x + radius) // CELL_M) + 1, COLS)
    r0 = max(int((HEIGHT_M - y - radius) // CELL_M), 0)
    r1 = min(int((HEIGHT_M - y + radius) // CELL_M) + 1, ROWS)
    if c0 >= c1 or r0 >= r1:
        return None
    d = np.hypot(_CX[r0:r1, c0:c1] - x, _CY[r0:r1, c0:c1] - y)
    return slice(r0, r1), slice(c0, c1), d


def convex_hull(points: Sequence[tuple[float, float]]) -> list[tuple[float, float]]:
    """Andrew's monotone chain."""
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def ring_area_m2(ring_xy: Sequence[tuple[float, float]]) -> float:
    a = 0.0
    for (x1, y1), (x2, y2) in zip(ring_xy, list(ring_xy[1:]) + [ring_xy[0]]):
        a += x1 * y2 - x2 * y1
    return abs(a) / 2
