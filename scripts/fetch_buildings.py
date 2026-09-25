#!/usr/bin/env python3
"""Measure every building in the zone: real footprints, real heights.

Two problems with what the twin had before.

Footprints came from OSM alone, which in south Pune maps roughly half of what is
actually standing -- 29,156 buildings against 56,531 that satellite detection finds
over the same bbox. Whole informal blocks along the Katraj-Narhe corridor simply
were not there.

Heights were a guess. 96.3% of buildings had no OSM height or levels tag, so they
got a storey count from a typology table plus rng.choice([-1, 0, 0, 1]) -- literally
random jitter, then extruded as though it were a measurement. It drives shadows, sky
view factor and the canyon physics, so the error propagated into every number the
twin reports.

Both are now measured:

  footprints  Overture Maps buildings theme, which fuses OSM with the Google and
              Microsoft satellite-detected footprint sets (ODbL / CDLA-permissive).
  heights     Google Open Buildings 2.5D Temporal v1, 2023 epoch: a 0.5 m/pixel
              building_height raster inferred from satellite imagery (CC-BY-4.0).
              Height per building is the 80th percentile of the pixels inside its
              own footprint that the companion building_presence band confirms are
              building -- 80th rather than max because the raster puts a soft halo
              on roof edges, and rather than median because a median over a footprint
              that includes a low annexe reads the annexe.

A note on Street View: Google's Maps Platform terms do not permit deriving or storing
geometry from Street View or Maps imagery, and there is no automated way to measure a
building from a street-level photo in any case. The imagery-derived products above are
published by Google for exactly this use, and are what "from satellite" means here.

Usage:
    python scripts/fetch_buildings.py                 # full run, resumable
    python scripts/fetch_buildings.py --overture-only
    python scripts/fetch_buildings.py --stats         # report on the cached result
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import pathlib
import struct
import sys
import time

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from cog import TiledGeoTIFF  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "backend" / "data"
TILE_CACHE = DATA / "ob25d_tiles"
OVERTURE_CACHE = DATA / "overture_buildings.json"
OUT = DATA / "buildings.json"

# Zone bbox, kept in step with backend/app/config.py.
BBOX = (18.4300, 73.8200, 18.5060, 73.8620)

OVERTURE_RELEASE = "2026-09-23.0"
OVERTURE_PATH = f"overturemaps-us-west-2/release/{OVERTURE_RELEASE}/theme=buildings/type=building"

# Open Buildings 2.5D Temporal v1, the 2023 epoch tile covering south Pune.
# Found by intersecting the zone bbox against the EPSG:32643 manifest; one 12.5 km
# tile covers the whole zone.
OB25D_URL = ("https://storage.googleapis.com/open-buildings-temporal-data/v1/geotiffs/"
             "3bc2c_2023_06_30/tile_L2SatnJj5Ko.tif")
BAND_HEIGHT, BAND_PRESENCE = 1, 2
PRESENCE_MIN = 0.5
HEIGHT_PCT = 80

# A footprint smaller than this cannot be sampled meaningfully at 0.5 m.
MIN_SAMPLE_PX = 6
# Floor for an extruded building. Below this the raster is saying "there is no real
# structure here", and the footprint is kept flat rather than given a storey.
MIN_HEIGHT_M = 2.5
# Storey heights for the fallback, from the same typology table the old estimator
# used -- but with the random jitter removed, and only ever reached when the raster
# has nothing to say about a footprint.
FALLBACK_M = {"apartments": 16.0, "residential": 10.0, "house": 6.4, "hut": 3.0,
              "shed": 3.0, "garage": 3.0, "kiosk": 3.0, "roof": 3.0, "temple": 8.0,
              "school": 10.0, "college": 13.0, "university": 13.0, "hospital": 13.0,
              "commercial": 10.0, "office": 13.0, "industrial": 8.0, "yes": 7.0}


# ───────────────────────── geodesy ─────────────────────────

def utm43n(lat: float, lon: float) -> tuple[float, float]:
    """WGS84 -> EPSG:32643 easting/northing, which is what the height raster is in."""
    a, f = 6378137.0, 1 / 298.257223563
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    k0 = 0.9996
    lam0 = math.radians(43 * 6 - 183)
    p, l = math.radians(lat), math.radians(lon)
    nu = a / math.sqrt(1 - e2 * math.sin(p) ** 2)
    t = math.tan(p) ** 2
    c = ep2 * math.cos(p) ** 2
    A = (l - lam0) * math.cos(p)
    M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * p
             - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * math.sin(2 * p)
             + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * math.sin(4 * p)
             - (35 * e2 ** 3 / 3072) * math.sin(6 * p))
    east = k0 * nu * (A + (1 - t + c) * A ** 3 / 6
                      + (5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * A ** 5 / 120) + 500000
    north = k0 * (M + nu * math.tan(p) * (A ** 2 / 2 + (5 - t + 9 * c + 4 * c * c) * A ** 4 / 24
                  + (61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * A ** 6 / 720))
    return east, north


# ───────────────────────── Overture footprints ─────────────────────────

def parse_wkb_polygon(buf: bytes) -> list[list[tuple[float, float]]]:
    """Outer rings of a WKB Polygon or MultiPolygon, as (lon, lat) lists.

    Holes are dropped on purpose: the twin extrudes footprints as solid prisms, so an
    inner courtyard would have to become geometry the renderer has no representation
    for. The outer ring is what casts the shadow.
    """
    endian = "<" if buf[0] == 1 else ">"
    typ = struct.unpack_from(endian + "I", buf, 1)[0] & 0xFF
    rings: list[list[tuple[float, float]]] = []

    def read_polygon(off: int) -> int:
        nonlocal rings
        nrings = struct.unpack_from(endian + "I", buf, off)[0]
        off += 4
        for r in range(nrings):
            npts = struct.unpack_from(endian + "I", buf, off)[0]
            off += 4
            if r == 0:
                pts = struct.unpack_from(endian + "d" * (npts * 2), buf, off)
                rings.append([(pts[i * 2], pts[i * 2 + 1]) for i in range(npts)])
            off += npts * 16
        return off

    if typ == 3:
        read_polygon(5)
    elif typ == 6:
        n = struct.unpack_from(endian + "I", buf, 5)[0]
        off = 9
        for _ in range(n):
            off += 5  # each member carries its own byte order + type
            off = read_polygon(off)
    return rings


def fetch_overture() -> list[dict]:
    if OVERTURE_CACHE.exists():
        print(f"overture: cached {OVERTURE_CACHE.name}")
        return json.loads(OVERTURE_CACHE.read_text(encoding="utf8"))
    try:
        import pyarrow.compute as pc
        import pyarrow.dataset as ds
        import pyarrow.fs as fs
    except ImportError:
        sys.exit("pyarrow is needed to read Overture. pip install -r scripts/requirements.txt")

    s, w, n, e = BBOX
    print(f"overture: querying {OVERTURE_RELEASE} over {BBOX} ...")
    t0 = time.time()
    d = ds.dataset(OVERTURE_PATH, filesystem=fs.S3FileSystem(anonymous=True, region="us-west-2"),
                   format="parquet")
    flt = ((pc.field("bbox", "xmin") < e) & (pc.field("bbox", "xmax") > w)
           & (pc.field("bbox", "ymin") < n) & (pc.field("bbox", "ymax") > s))
    tb = d.to_table(filter=flt, columns=["id", "height", "num_floors", "class", "subtype",
                                         "names", "geometry"])
    print(f"overture: {tb.num_rows} rows in {time.time() - t0:.0f}s")

    ids = tb.column("id").to_pylist()
    heights = tb.column("height").to_pylist()
    floors = tb.column("num_floors").to_pylist()
    classes = tb.column("class").to_pylist()
    names = tb.column("names").to_pylist()
    geoms = tb.column("geometry").to_pylist()

    out = []
    for i in range(tb.num_rows):
        for ring in parse_wkb_polygon(geoms[i]):
            if len(ring) < 4:
                continue
            cx = sum(p[0] for p in ring) / len(ring)
            cy = sum(p[1] for p in ring) / len(ring)
            if not (w <= cx <= e and s <= cy <= n):
                continue
            nm = ""
            if names[i] and isinstance(names[i], dict):
                nm = names[i].get("primary") or ""
            out.append({
                "oid": ids[i], "kind": classes[i] or "yes", "name": nm,
                "tag_height": heights[i], "tag_floors": floors[i],
                "ring": [[round(p[1], 7), round(p[0], 7)] for p in ring],  # lat, lon
            })
    OVERTURE_CACHE.write_text(json.dumps(out, separators=(",", ":")), encoding="utf8")
    print(f"overture: kept {len(out)} footprints with centroid inside the bbox")
    return out


# ───────────────────────── height raster ─────────────────────────

class TileStore:
    """Compressed tiles on disk, decoded tiles in a small LRU.

    Buildings are processed in tile order, so an LRU of a couple of hundred tiles
    holds everything the current neighbourhood needs and the 1.4 GB source file is
    touched once per tile, ever.
    """

    def __init__(self, tif: TiledGeoTIFF, capacity: int = 160):
        self.tif = tif
        self.capacity = capacity
        self._lru: collections.OrderedDict[tuple, np.ndarray] = collections.OrderedDict()
        self.fetched = 0
        TILE_CACHE.mkdir(parents=True, exist_ok=True)

    def _path(self, band: int, ty: int, tx: int) -> pathlib.Path:
        return TILE_CACHE / f"b{band}_{ty:03d}_{tx:03d}.z"

    def tile(self, band: int, ty: int, tx: int) -> np.ndarray:
        key = (band, ty, tx)
        hit = self._lru.get(key)
        if hit is not None:
            self._lru.move_to_end(key)
            return hit
        p = self._path(band, ty, tx)
        if p.exists():
            raw = p.read_bytes()
        else:
            raw = self.tif.fetch_tile_bytes(band, ty, tx)
            p.write_bytes(raw)
            self.fetched += 1
        arr = (np.zeros((self.tif.tile_h, self.tif.tile_w), dtype=np.float32)
               if not raw else self.tif.read_tile(band, ty, tx, raw=raw))
        self._lru[key] = arr
        if len(self._lru) > self.capacity:
            self._lru.popitem(last=False)
        return arr


def polygon_mask(ring_px: np.ndarray, x0: int, y0: int, w: int, h: int) -> np.ndarray:
    """Even-odd fill of a polygon over a pixel-centre grid, as a boolean mask."""
    ys = np.arange(y0, y0 + h, dtype=np.float64)[:, None] + 0.5
    xs = np.arange(x0, x0 + w, dtype=np.float64)[None, :] + 0.5
    inside = np.zeros((h, w), dtype=bool)
    px, py = ring_px[:, 0], ring_px[:, 1]
    n = len(ring_px)
    for i in range(n):
        j = (i - 1) % n
        yi, yj = py[i], py[j]
        if yi == yj:
            continue
        cond = ((yi > ys) != (yj > ys))
        xint = (px[j] - px[i]) * (ys - yi) / (yj - yi) + px[i]
        inside ^= cond & (xs < xint)
    return inside


def measure_heights(buildings: list[dict]) -> dict:
    print(f"heights: opening {OB25D_URL.rsplit('/', 1)[-1]} ...")
    tif = TiledGeoTIFF(OB25D_URL)
    store = TileStore(tif)
    tw, th = tif.tile_w, tif.tile_h

    # Footprints into raster pixel space, once.
    prepared = []
    for b in buildings:
        pts = np.array([utm43n(la, lo) for la, lo in b["ring"]], dtype=np.float64)
        px = (pts[:, 0] - tif.origin[0]) / tif.scale[0]
        py = (tif.origin[1] - pts[:, 1]) / tif.scale[1]
        ring = np.stack([px, py], axis=1)
        x0, x1 = int(np.floor(px.min())), int(np.ceil(px.max()))
        y0, y1 = int(np.floor(py.min())), int(np.ceil(py.max()))
        if x1 <= 0 or y1 <= 0 or x0 >= tif.width or y0 >= tif.height:
            prepared.append(None)
            continue
        prepared.append((ring, max(0, x0), max(0, y0), min(tif.width, x1), min(tif.height, y1)))

    order = sorted(range(len(buildings)),
                   key=lambda i: (prepared[i] is None,
                                  prepared[i][2] // th if prepared[i] else 0,
                                  prepared[i][1] // tw if prepared[i] else 0))

    stats = collections.Counter()
    t0 = time.time()
    for k, i in enumerate(order):
        prep = prepared[i]
        b = buildings[i]
        if prep is None:
            stats["outside_raster"] += 1
            continue
        ring, x0, y0, x1, y1 = prep
        w, h = x1 - x0, y1 - y0
        if w <= 0 or h <= 0:
            stats["outside_raster"] += 1
            continue
        mask = polygon_mask(ring, x0, y0, w, h)
        if mask.sum() < MIN_SAMPLE_PX:
            # Tiny footprint: fall back to its own pixel row/col span so something
            # is sampled rather than nothing.
            mask[:] = True
        hv = _gather(store, tif, BAND_HEIGHT, x0, y0, w, h)
        pv = _gather(store, tif, BAND_PRESENCE, x0, y0, w, h)
        sel = mask & (pv >= PRESENCE_MIN) & (hv > -98)
        if sel.sum() < MIN_SAMPLE_PX:
            sel = mask & (hv > -98) & (hv > 0)
        if sel.sum() >= MIN_SAMPLE_PX:
            h_m = float(np.percentile(hv[sel], HEIGHT_PCT))
            b["height_m"] = round(h_m, 1)
            b["height_px"] = int(sel.sum())
            stats["satellite" if h_m >= MIN_HEIGHT_M else "satellite_low"] += 1
        else:
            b["height_m"] = None
            stats["no_signal"] += 1
        if (k + 1) % 2500 == 0:
            el = time.time() - t0
            print(f"  {k + 1}/{len(order)}  {el:.0f}s  "
                  f"{store.fetched} tiles fetched  sat={stats['satellite']}")
    print(f"heights: {dict(stats)} in {time.time() - t0:.0f}s, {store.fetched} tiles fetched")
    return stats


def _gather(store: TileStore, tif: TiledGeoTIFF, band: int,
            x0: int, y0: int, w: int, h: int) -> np.ndarray:
    """A w x h window of one band, assembled from whichever tiles it crosses."""
    out = np.full((h, w), -99.0, dtype=np.float32)
    tw, th = tif.tile_w, tif.tile_h
    for ty in range(y0 // th, (y0 + h - 1) // th + 1):
        for tx in range(x0 // tw, (x0 + w - 1) // tw + 1):
            tile = store.tile(band, ty, tx)
            px, py = tx * tw, ty * th
            sx0, sy0 = max(x0, px), max(y0, py)
            sx1, sy1 = min(x0 + w, px + tw), min(y0 + h, py + th)
            if sx1 <= sx0 or sy1 <= sy0:
                continue
            out[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = tile[sy0 - py:sy1 - py, sx0 - px:sx1 - px]
    return out


# ───────────────────────── assembly ─────────────────────────

def ring_area_m2(ring: list[list[float]]) -> float:
    lat0 = sum(p[0] for p in ring) / len(ring)
    mx = 111320.0 * math.cos(math.radians(lat0))
    pts = [(p[1] * mx, p[0] * 110540.0) for p in ring]
    a = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--overture-only", action="store_true")
    ap.add_argument("--stats", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="sample N buildings (for a dry run)")
    args = ap.parse_args()

    if args.stats:
        return report()

    raw = fetch_overture()
    if args.overture_only:
        return

    buildings = []
    for r in raw:
        area = ring_area_m2(r["ring"])
        if area < 4:
            continue
        tagged = None
        if r["tag_height"]:
            tagged = float(r["tag_height"])
        elif r["tag_floors"]:
            tagged = float(r["tag_floors"]) * 3.2 + 1.0
        buildings.append({"oid": r["oid"], "kind": r["kind"] or "yes", "name": r["name"],
                          "area_m2": round(area), "ring": r["ring"],
                          "tagged_height_m": tagged})
    if args.limit:
        buildings = buildings[:args.limit]
    print(f"buildings: {len(buildings)} footprints, "
          f"{sum(b['tagged_height_m'] is not None for b in buildings)} carry a height/levels tag")

    measure_heights(buildings)

    # Resolve one height per building. A surveyed tag beats an inferred raster, the
    # raster beats a typology guess, and the guess is now deterministic.
    #
    # A measured height near zero is kept as measured, not quietly promoted to the
    # typology default. Those footprints are single-storey sheds, compound walls and
    # the occasional false positive in the ML footprint set; extruding them to seven
    # metres because the raster disagreed with the table would put back exactly the
    # invented geometry this script exists to remove.
    src = collections.Counter()
    for b in buildings:
        measured = b.get("height_m")
        tagged = b["tagged_height_m"]
        if tagged and 2.0 <= tagged <= 300.0:
            b["height_m"], b["height_source"] = round(tagged, 1), "tagged"
        elif measured is not None:
            b["height_m"] = round(max(MIN_HEIGHT_M, min(120.0, measured)), 1)
            b["height_source"] = "satellite" if measured >= MIN_HEIGHT_M else "satellite_low"
        else:
            b["height_m"] = FALLBACK_M.get(b["kind"], FALLBACK_M["yes"])
            b["height_source"] = "typology"
        src[b["height_source"]] += 1
        b.pop("tagged_height_m", None)
        b.pop("height_px", None)

    OUT.write_text(json.dumps({
        "meta": {
            "bbox": list(BBOX),
            "footprints": "Overture Maps " + OVERTURE_RELEASE + " (OSM + Google/Microsoft ML, ODbL)",
            "heights": "Google Open Buildings 2.5D Temporal v1, 2023 epoch, 0.5 m (CC-BY-4.0)",
            "height_percentile": HEIGHT_PCT,
            "count": len(buildings),
            "height_source": dict(src),
        },
        "buildings": buildings,
    }, separators=(",", ":")), encoding="utf8")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)  sources={dict(src)}")


def report() -> None:
    d = json.loads(OUT.read_text(encoding="utf8"))
    b = d["buildings"]
    print(json.dumps(d["meta"], indent=1))
    hs = [x["height_m"] for x in b]
    print(f"height  p10 {np.percentile(hs,10):.1f}  p50 {np.percentile(hs,50):.1f}  "
          f"p90 {np.percentile(hs,90):.1f}  p99 {np.percentile(hs,99):.1f}  max {max(hs):.1f}")


if __name__ == "__main__":
    main()
