"""Real ground elevation for the zone, from the Copernicus DEM.

The twin has always been flat. Narhe is not: the corridor climbs out of the Katraj
valley and the difference between a street on the ridge and a street in the bowl is
tens of metres, which is a real part of why they heat differently and a large part of
why a walk between them is not the stroll its distance suggests. Rendering the city
on a plane threw that away.

Source: Copernicus DEM GLO-30, the ESA global 1-arcsecond model, tiled COG on S3 with
no key and no sign-up. It is read over HTTP range requests with the same reader the
building-height and canopy rasters use — four 1024x1024 tiles cover this zone, so the
whole fetch is a few megabytes rather than the 1.7 GB the tile weighs.

  https://copernicus-dem-30m.s3.amazonaws.com/

**It is a surface model, not a bare-earth one.** GLO-30 records the top of whatever
is there, so a dense block reads a few metres high and a canopy edge reads as a small
ridge. That matters here because the twin extrudes its own buildings from measured
heights, and standing those on a surface that already contains them would count the
same building twice. The fix is not to pretend: at 30 m posts a building occupies a
pixel or two, so a grey opening (minimum then maximum over a small window) removes
the narrow positive features while leaving the hillsides, and the residual is
reported below so the size of the correction is visible rather than assumed.

Output: backend/data/terrain.json — the 10 m grid the rest of the twin already uses,
elevation in metres, plus the range it spans.
"""
from __future__ import annotations

import base64
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cog  # noqa: E402

# Matches services/geo.py and the other fetchers exactly. A grid that disagrees by
# one cell misregisters every layer against this one.
BBOX = (18.4300, 73.8200, 18.5060, 73.8620)
CELL_M = 10.0
# services/geo.py's own constants. Using 111_320 for latitude as well gives 847 rows
# instead of 841, and a terrain grid six rows taller than every other field in the
# twin would slide the whole city downhill against its own streets.
M_PER_DEG_LAT = 110_540.0
M_PER_DEG_LON = 111_320.0

TILE = ("https://copernicus-dem-30m.s3.amazonaws.com/"
        "Copernicus_DSM_COG_10_N18_00_E073_00_DEM/Copernicus_DSM_COG_10_N18_00_E073_00_DEM.tif")

OUT = Path(__file__).resolve().parent.parent / "backend" / "data" / "terrain.json"

#: Window for the opening that removes buildings and canopy, in DEM pixels. Three
#: posts is ~83 m — wider than any single structure here, narrower than any hillside.
OPEN_PX = 3


def grid_shape() -> tuple[int, int]:
    s, w, n, e = BBOX
    height_m = (n - s) * M_PER_DEG_LAT
    width_m = (e - w) * M_PER_DEG_LON * math.cos(math.radians((s + n) / 2))
    return int(math.ceil(height_m / CELL_M)), int(math.ceil(width_m / CELL_M))


def cell_centres(rows: int, cols: int) -> tuple[np.ndarray, np.ndarray]:
    """Lat/lon of each cell centre, matching geo.cell_centers()."""
    s, w, n, e = BBOX
    lat = n - (np.arange(rows) + 0.5) * (n - s) / rows
    lon = w + (np.arange(cols) + 0.5) * (e - w) / cols
    return lat, lon


def _minmax_filter(a: np.ndarray, k: int, op) -> np.ndarray:
    """Separable rank filter over a (2k+1) square, numpy only."""
    r = k // 2
    out = a
    for axis in (0, 1):
        stack = [np.roll(out, s, axis=axis) for s in range(-r, r + 1)]
        out = op(np.stack(stack), axis=0)
    return out


def main() -> None:
    rows, cols = grid_shape()
    print(f"grid {rows} x {cols} at {CELL_M:.0f} m")

    t = cog.TiledGeoTIFF(TILE)
    s, w, n, e = BBOX
    # Pad generously: the opening below eats into the edges, and bilinear sampling
    # needs a ring of context beyond the bbox itself.
    pad = 8
    x0, y0 = t.world_to_pixel(w, n)
    x1, y1 = t.world_to_pixel(e, s)
    c0, c1 = int(math.floor(x0)) - pad, int(math.ceil(x1)) + pad
    r0, r1 = int(math.floor(y0)) - pad, int(math.ceil(y1)) + pad
    print(f"DEM window rows {r0}..{r1}, cols {c0}..{c1}")

    tiles_y = range(r0 // t.tile_h, r1 // t.tile_h + 1)
    tiles_x = range(c0 // t.tile_w, c1 // t.tile_w + 1)
    win = np.full((r1 - r0 + 1, c1 - c0 + 1), np.nan, dtype=np.float32)
    for ty in tiles_y:
        for tx in tiles_x:
            block = t.read_tile(0, ty, tx)
            by, bx = ty * t.tile_h, tx * t.tile_w
            # Overlap of this tile with the requested window.
            ys, ye = max(r0, by), min(r1, by + t.tile_h - 1)
            xs, xe = max(c0, bx), min(c1, bx + t.tile_w - 1)
            if ys > ye or xs > xe:
                continue
            win[ys - r0:ye - r0 + 1, xs - c0:xe - c0 + 1] = block[ys - by:ye - by + 1, xs - bx:xe - bx + 1]
            print(f"  tile ({ty},{tx}) ok")

    if np.isnan(win).any():
        raise SystemExit("DEM window has gaps — a tile failed to read")

    raw = win.copy()
    # Grey opening: minimum then maximum. Narrow positive features (a block, a stand
    # of trees) are erased; the hill they sit on is not.
    opened = _minmax_filter(_minmax_filter(win, OPEN_PX, np.min), OPEN_PX, np.max)
    removed = float(np.percentile(raw - opened, 95))
    print(f"surface features removed: p95 {removed:.1f} m, max {float((raw - opened).max()):.1f} m")

    # Bilinear resample onto the twin's own grid.
    lat, lon = cell_centres(rows, cols)
    px = (lon - t.origin[0]) / t.scale[0] - c0
    py = (t.origin[1] - lat) / t.scale[1] - r0
    xi = np.clip(px, 0, opened.shape[1] - 1.001)
    yi = np.clip(py, 0, opened.shape[0] - 1.001)
    x0i, y0i = np.floor(xi).astype(int), np.floor(yi).astype(int)
    fx, fy = xi - x0i, yi - y0i
    g = opened
    top = g[y0i][:, x0i] * (1 - fx) + g[y0i][:, x0i + 1] * fx
    bot = g[y0i + 1][:, x0i] * (1 - fx) + g[y0i + 1][:, x0i + 1] * fx
    elev = (top * (1 - fy[:, None]) + bot * fy[:, None]).astype(np.float32)

    lo, hi = float(elev.min()), float(elev.max())
    print(f"elevation {lo:.1f} m to {hi:.1f} m  (relief {hi - lo:.1f} m)")

    # 16-bit across two bytes. 8-bit would quantise a 100 m range to 0.4 m steps,
    # which is invisible on the ground and very visible in the lighting: the surface
    # normal is a difference of neighbours, so the terracing lands straight in the
    # shading as banded facets.
    q = np.clip((elev - lo) / max(hi - lo, 1e-6), 0, 1)
    u16 = np.round(q * 65535).astype(np.uint16)
    packed = np.empty((rows, cols, 2), dtype=np.uint8)
    packed[:, :, 0] = (u16 >> 8).astype(np.uint8)
    packed[:, :, 1] = (u16 & 0xFF).astype(np.uint8)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "source": "Copernicus DEM GLO-30 (ESA), 1 arcsec, opened to approximate bare ground",
        "rows": rows, "cols": cols, "cell_m": CELL_M,
        "min_m": round(lo, 2), "max_m": round(hi, 2),
        "surface_removed_p95_m": round(removed, 2),
        "encoding": "uint16 big-endian across 2 bytes, base64, row-major from north",
        "data": base64.b64encode(packed.tobytes()).decode(),
    }))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
