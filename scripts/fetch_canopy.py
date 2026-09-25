#!/usr/bin/env python3
"""Put canopy and grass where they actually are, measured from satellite.

What this replaces: `_synthesise_canopy()` invented 33,329 of the twin's 34,475
trees. It picked a random number per OSM way, called the way a "tree-lined avenue"
if the number cleared a per-class probability, and then scattered trees down it --
so 97% of the canopy shading the model's streets was a coin flip, and the streets
that came out shaded were not the shaded streets.

Two measured rasters replace it:

  canopy   Meta / World Resources Institute Global Canopy Height, ~1 m, 2020
           (CC-BY-4.0). Height above ground of woody vegetation. Anything at or
           above CANOPY_MIN_M is canopy; below that is not a tree and gets nothing.
  ground   ESA WorldCover 10 m v200, 2021 (CC-BY-4.0). Its grassland, cropland and
           shrubland classes say which ground is green, so grass is drawn on grass
           and not on the bare compound next to it.

Trees are emitted per 10 m cell rather than as detected individual crowns: the
renderer and the shade model both work from a radius and a density per tree, and a
cell's canopy fraction and mean height give exactly those two numbers without
pretending to a per-trunk precision the raster does not support.

Usage:
    python scripts/fetch_canopy.py
    python scripts/fetch_canopy.py --stats
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import pathlib
import sys
import time

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from cog import TiledGeoTIFF  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "backend" / "data"
OUT = DATA / "canopy.json"

BBOX = (18.4300, 73.8200, 18.5060, 73.8620)
CELL_M = 10.0

CHM_BASE = "https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm"
CHM_TILES = ["123301202", "123301203"]
WORLDCOVER = ("https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
              "ESA_WorldCover_10m_2021_v200_N18E072_Map.tif")

WC_GRASS = (30, 40)
WC_SHRUB = (20,)

# Woody vegetation starts here. Below it the raster is picking up hedges, parked
# vehicles and roof clutter, none of which shade a pedestrian.
CANOPY_MIN_M = 3.0
# A cell needs this much canopy before it is worth a tree. Below it the crown would
# be under a metre across, which is noise in a 1 m raster.
MIN_CELL_FRAC = 0.12
# Crowns do not reach the full cell even at full cover; this keeps a dense cell's
# tree from reading as a 10 m box of leaves.
MAX_RADIUS_M = 5.6

EARTH_R = 6378137.0


def merc(lat: float, lon: float) -> tuple[float, float]:
    return EARTH_R * math.radians(lon), EARTH_R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


M_PER_DEG_LAT = 110_540.0


def grid_shape() -> tuple[int, int, float, float]:
    """Rows, cols and the metre extent of the twin grid.

    Must agree with services/geo.py exactly -- ceil, not round. The grid overhangs
    the bbox by up to one cell to the south and east, and a landcover raster built
    on a 840 x 443 grid would be off by a cell against every other field in the
    twin, which is a whole street's width of misregistration by the far corner.
    """
    s, w, n, e = BBOX
    height_m = (n - s) * M_PER_DEG_LAT
    width_m = (e - w) * m_per_deg_lon()
    return (int(math.ceil(height_m / CELL_M)), int(math.ceil(width_m / CELL_M)),
            width_m, height_m)


def m_per_deg_lon() -> float:
    s, w, n, e = BBOX
    return 111_320.0 * math.cos(math.radians((s + n) / 2))


def cell_latlon(rows: int, cols: int, sub: int) -> tuple[np.ndarray, np.ndarray]:
    """Latitudes and longitudes of sub-cell centres, on the twin's own grid.

    Built from geo.cell_centers()' formula rather than by stretching the bbox across
    the array, so sample i lands where the twin thinks cell i is.
    """
    s, w, n, e = BBOX
    height_m = (n - s) * M_PER_DEG_LAT
    step = CELL_M / sub
    y = height_m - (np.arange(rows * sub) + 0.5) * step
    x = (np.arange(cols * sub) + 0.5) * step
    return s + y / M_PER_DEG_LAT, w + x / m_per_deg_lon()


def read_window(tif: TiledGeoTIFF, x0: int, y0: int, w: int, h: int, batch: int = 256) -> np.ndarray:
    """A w x h window of band 0, for either a stripped or a tiled raster.

    The two rasters here are laid out differently -- the canopy map is 65,536 strips
    of one row, WorldCover is square tiles -- so the window is assembled from chunk
    rectangles either way, and only the fetch strategy differs: contiguous runs of
    strips come back in one request, tiles are fetched individually.
    """
    out = np.zeros((h, w), dtype=np.float32)
    y0c, y1c = max(0, y0), min(tif.height, y0 + h)
    x0c, x1c = max(0, x0), min(tif.width, x0 + w)
    if y1c <= y0c or x1c <= x0c:
        return out
    ty0, ty1 = y0c // tif.tile_h, (y1c - 1) // tif.tile_h
    tx0, tx1 = x0c // tif.tile_w, (x1c - 1) // tif.tile_w

    def place(tile: np.ndarray, ty: int, tx: int) -> None:
        py, px = ty * tif.tile_h, tx * tif.tile_w
        sy0, sy1 = max(y0c, py), min(y1c, py + tif.tile_h)
        sx0, sx1 = max(x0c, px), min(x1c, px + tif.tile_w)
        if sy1 <= sy0 or sx1 <= sx0:
            return
        out[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = tile[sy0 - py:sy1 - py, sx0 - px:sx1 - px]

    if tif.stripped:
        for tstart in range(ty0, ty1 + 1, batch):
            tend = min(ty1, tstart + batch - 1)
            chunks = tif.fetch_chunk_range(tstart, tend)
            for ti in range(tstart, tend + 1):
                raw = chunks.get(ti)
                if raw:
                    place(tif.read_tile(0, ti, 0, raw=raw), ti, 0)
    else:
        for ty in range(ty0, ty1 + 1):
            for tx in range(tx0, tx1 + 1):
                place(tif.read_tile(0, ty, tx), ty, tx)
    return out


def block_reduce(a: np.ndarray, rows: int, cols: int, how: str) -> np.ndarray:
    """Average or max `a` down to rows x cols, trimming the ragged edge."""
    h, w = a.shape
    bh, bw = h // rows, w // cols
    a = a[:rows * bh, :cols * bw].reshape(rows, bh, cols, bw)
    return a.mean(axis=(1, 3)) if how == "mean" else a.max(axis=(1, 3))


def _cached_window(tag: str, tif: TiledGeoTIFF, x0: int, y0: int, w: int, h: int) -> np.ndarray:
    """A raster window, kept on disk so a rerun does not refetch 7,469 strips."""
    cache = DATA / f"_win_{tag}.npy"
    if cache.exists():
        a = np.load(cache)
        if a.shape == (h, w):
            print(f"  {tag}: cached {a.shape}")
            return a
    t0 = time.time()
    a = read_window(tif, x0, y0, w, h)
    np.save(cache, a)
    print(f"  {tag}: {a.shape} in {time.time() - t0:.0f}s", flush=True)
    return a


def fetch_canopy_grid(rows: int, cols: int, sub: int = 8) -> tuple[np.ndarray, np.ndarray]:
    """Canopy fraction and mean canopy height per twin cell, from the ~1 m CHM."""
    lat, lon = cell_latlon(rows, cols, sub)
    mx = EARTH_R * np.radians(lon)
    my = EARTH_R * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))
    hgt = np.zeros((rows * sub, cols * sub), dtype=np.float32)

    for tile in CHM_TILES:
        print(f"canopy: {tile}", flush=True)
        t = TiledGeoTIFF(f"{CHM_BASE}/{tile}.tif")
        px = (mx - t.origin[0]) / t.scale[0]
        py = (t.origin[1] - my) / t.scale[1]
        ix, iy = np.round(px).astype(np.int64), np.round(py).astype(np.int64)
        okx, oky = (ix >= 0) & (ix < t.width), (iy >= 0) & (iy < t.height)
        if not okx.any() or not oky.any():
            print(f"canopy: {tile} does not cover the zone, skipping")
            continue
        cx0, cx1 = int(ix[okx].min()), int(ix[okx].max()) + 1
        cy0, cy1 = int(iy[oky].min()), int(iy[oky].max()) + 1
        win = _cached_window(f"chm_{tile}", t, cx0, cy0, cx1 - cx0, cy1 - cy0)
        gx = np.clip(ix - cx0, 0, win.shape[1] - 1)
        gy = np.clip(iy - cy0, 0, win.shape[0] - 1)
        sample = win[np.ix_(gy, gx)]
        # Only where this tile actually has pixels; the zone straddles two of them.
        hgt = np.where(np.outer(oky, okx), np.maximum(hgt, sample), hgt)

    canopy = (hgt >= CANOPY_MIN_M)
    cover = block_reduce(canopy.astype(np.float32), rows, cols, "mean")
    total = block_reduce(np.where(canopy, hgt, 0.0).astype(np.float32), rows, cols, "mean")
    with np.errstate(invalid="ignore", divide="ignore"):
        mean_h = np.where(cover > 1e-6, total / np.maximum(cover, 1e-6), 0.0)
    return cover.astype(np.float32), mean_h.astype(np.float32)


def fetch_landcover(rows: int, cols: int) -> np.ndarray:
    """WorldCover class per twin cell, sampled at the cell centre."""
    print("landcover: ESA WorldCover 2021", flush=True)
    t = TiledGeoTIFF(WORLDCOVER)
    lat, lon = cell_latlon(rows, cols, 1)
    ix = np.clip(np.round((lon - t.origin[0]) / t.scale[0]).astype(np.int64), 0, t.width - 1)
    iy = np.clip(np.round((t.origin[1] - lat) / t.scale[1]).astype(np.int64), 0, t.height - 1)
    cx0, cx1 = int(ix.min()), int(ix.max()) + 1
    cy0, cy1 = int(iy.min()), int(iy.max()) + 1
    win = _cached_window("worldcover", t, cx0, cy0, cx1 - cx0, cy1 - cy0)
    return win[np.ix_(iy - cy0, ix - cx0)].astype(np.uint8)


def make_trees(cover: np.ndarray, mean_h: np.ndarray, rows: int, cols: int) -> list[dict]:
    """One tree per canopy cell, with continuous woodland merged to 20 m.

    At 10 m a whole wood becomes a tree every cell -- 121,659 of them over this zone,
    which is 9.7M triangles of canopy for a scene that also has 56,276 buildings. In
    continuous canopy the individual crowns are not separable anyway, so a 2x2 block
    that is canopy throughout collapses to a single wider crown. Street trees, which
    are exactly the cells whose neighbours are not canopy, keep their own.
    """
    s, w, n, e = BBOX
    mlon = m_per_deg_lon()
    height_m = (n - s) * M_PER_DEG_LAT
    taken = np.zeros_like(cover, dtype=bool)
    out: list[dict] = []

    def emit(r: float, c: float, frac: float, h: float, span: float) -> None:
        radius = min(MAX_RADIUS_M * span / 1.0, math.sqrt(frac * (CELL_M * span) ** 2 / math.pi))
        y = height_m - (r + 0.5 * span) * CELL_M
        x = (c + 0.5 * span) * CELL_M
        out.append({"lat": round(s + y / M_PER_DEG_LAT, 7), "lon": round(w + x / mlon, 7),
                    "radius_m": round(max(1.0, radius), 2),
                    "height_m": round(max(CANOPY_MIN_M, h), 1),
                    "density": round(min(1.0, 0.35 + 0.65 * frac), 2),
                    "source": "chm"})

    DENSE = 0.62
    for r in range(0, rows - 1, 2):
        for c in range(0, cols - 1, 2):
            blk = cover[r:r + 2, c:c + 2]
            if blk.min() >= DENSE:
                emit(r, c, float(blk.mean()), float(mean_h[r:r + 2, c:c + 2].mean()), 2.0)
                taken[r:r + 2, c:c + 2] = True

    ys, xs = np.nonzero((cover >= MIN_CELL_FRAC) & ~taken)
    for r, c in zip(ys.tolist(), xs.tolist()):
        emit(r, c, float(cover[r, c]), float(mean_h[r, c]), 1.0)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stats", action="store_true")
    args = ap.parse_args()
    if args.stats:
        d = json.loads(OUT.read_text(encoding="utf8"))
        print(json.dumps(d["meta"], indent=1))
        return

    rows, cols, width_m, height_m = grid_shape()
    print(f"grid {rows} x {cols} cells over {width_m:.0f} x {height_m:.0f} m")

    cover, mean_h = fetch_canopy_grid(rows, cols)
    lc = fetch_landcover(rows, cols)
    trees = make_trees(cover, mean_h, rows, cols)

    grass = np.isin(lc, WC_GRASS)
    shrub = np.isin(lc, WC_SHRUB)
    payload = {
        "meta": {
            "bbox": list(BBOX), "rows": rows, "cols": cols, "cell_m": CELL_M,
            "canopy": "Meta/WRI Global Canopy Height ~1 m, 2020 (CC-BY-4.0)",
            "landcover": "ESA WorldCover 10 m v200, 2021 (CC-BY-4.0)",
            "canopy_min_m": CANOPY_MIN_M,
            "trees": len(trees),
            "canopy_cover_pct": round(float(cover.mean()) * 100, 2),
            "grass_pct": round(float(grass.mean()) * 100, 2),
            "shrub_pct": round(float(shrub.mean()) * 100, 2),
        },
        "trees": trees,
        # Land cover rides along as a base64 byte grid: one byte per 10 m cell is
        # 373 KB raw and ~20 KB gzipped, which is far less than the polygons it
        # would take to say the same thing.
        "landcover_b64": base64.b64encode(lc.tobytes()).decode(),
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf8")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")
    print(json.dumps(payload["meta"], indent=1))


if __name__ == "__main__":
    main()
