#!/usr/bin/env python3
"""A minimal reader for tiled GeoTIFFs served over HTTP, by range request.

Why this exists rather than rasterio: the only raster this project reads is Google's
Open Buildings 2.5D height tile, which is a 1.4 GB file of which the zone needs about
4%. Range requests over its internal 512x512 tiling fetch exactly that 4%, so the
whole job needs zlib and numpy -- both already here -- instead of a GDAL toolchain.

Deliberately narrow: little-endian TIFF or BigTIFF, deflate, tiled, float32 or uint8.
That is what the two rasters this project reads actually are. Anything else raises
rather than guessing, because a reader that quietly mis-decodes a height raster
produces a plausible-looking city that is wrong.
"""
from __future__ import annotations

import struct
import urllib.request
import zlib

import numpy as np

UA = "HeatMind/1.0 (urban heat digital twin; academic project)"

# TIFF tags this reader understands.
_W, _H, _BPS, _COMPRESSION, _SPP = 256, 257, 258, 259, 277
_TILE_W, _TILE_H, _TILE_OFF, _TILE_CNT = 322, 323, 324, 325
_PLANAR, _PREDICTOR, _SAMPLE_FMT = 284, 317, 339
_STRIP_OFF, _STRIP_CNT, _ROWS_PER_STRIP = 273, 279, 278
_PIXEL_SCALE, _TIE_POINT = 33550, 33922

_TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8}
_TYPE_FMT = {1: "B", 3: "H", 4: "I", 11: "f", 12: "d", 16: "Q", 17: "q", 18: "Q"}


def _fetch(url: str, start: int, end: int) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(req, timeout=180) as f:
        return f.read()


class TiledGeoTIFF:
    """Header of a tiled GeoTIFF, plus windowed reads straight out of the remote file."""

    def __init__(self, url: str):
        self.url = url
        head = _fetch(url, 0, 262143)
        if head[:2] != b"II":
            raise ValueError(f"not a little-endian TIFF: {url}")
        version = struct.unpack_from("<H", head, 2)[0]
        # BigTIFF (43) differs from classic (42) in three places: the header carries
        # the offset size, IFD entries are 20 bytes rather than 12 with 8-byte counts
        # and values, and the entry count is 8 bytes. Everything downstream is the
        # same, so the difference is absorbed here.
        if version == 42:
            self.big = False
            self._off_fmt, self._off_size = "I", 4
            ifd = struct.unpack_from("<I", head, 4)[0]
            n = struct.unpack_from("<H", head, ifd)[0]
            entry, hdr = 12, 2
        elif version == 43:
            self.big = True
            self._off_fmt, self._off_size = "Q", 8
            if struct.unpack_from("<H", head, 4)[0] != 8:
                raise ValueError("BigTIFF with non-8-byte offsets is not supported")
            ifd = struct.unpack_from("<Q", head, 8)[0]
            n = struct.unpack_from("<Q", head, ifd)[0]
            entry, hdr = 20, 8
        else:
            raise ValueError(f"unknown TIFF version {version}: {url}")

        need = ifd + hdr + n * entry
        if need > len(head):
            head = _fetch(url, 0, need + 65535)
        self._tags: dict[int, tuple[int, int, int, int]] = {}
        for i in range(n):
            p = ifd + hdr + i * entry
            if self.big:
                tag, typ = struct.unpack_from("<HH", head, p)
                cnt = struct.unpack_from("<Q", head, p + 4)[0]
                voff = struct.unpack_from("<Q", head, p + 12)[0]
                self._tags[tag] = (typ, cnt, voff, p + 12)
            else:
                tag, typ, cnt = struct.unpack_from("<HHI", head, p)
                self._tags[tag] = (typ, cnt, struct.unpack_from("<I", head, p + 8)[0], p + 8)
        self._head = head

        self.width = self._v(_W)[0]
        self.height = self._v(_H)[0]
        # Tiled and stripped GeoTIFFs differ only in the shape of a chunk: a strip is
        # a tile as wide as the image. Normalising here means everything downstream --
        # the LRU, the window assembly, the per-building sampling -- is written once.
        self.stripped = _TILE_W not in self._tags
        if self.stripped:
            self.tile_w = self.width
            self.tile_h = self._v(_ROWS_PER_STRIP, default=(1,))[0]
        else:
            self.tile_w = self._v(_TILE_W)[0]
            self.tile_h = self._v(_TILE_H)[0]
        self.bands = self._v(_SPP)[0]
        self.planar = self._v(_PLANAR)[0]
        self.predictor = self._v(_PREDICTOR, default=(1,))[0]
        compression = self._v(_COMPRESSION)[0]
        bps = self._v(_BPS)
        fmt = self._v(_SAMPLE_FMT, default=(1,) * self.bands)

        if compression != 8:
            raise ValueError(f"only deflate (8) is supported, got compression={compression}")
        if set(bps) == {32} and set(fmt) == {3}:
            self.dtype = np.dtype("<f4")
        elif set(bps) == {8}:
            self.dtype = np.dtype(np.uint8)
        else:
            raise ValueError(f"unsupported sample type: bits={bps} format={fmt}")
        if self.planar not in (1, 2):
            raise ValueError(f"unknown planar configuration {self.planar}")
        if self.planar == 1 and self.bands != 1:
            raise ValueError("interleaved multi-band tiles are not supported")

        self.offsets = self._v(_STRIP_OFF if self.stripped else _TILE_OFF)
        self.counts = self._v(_STRIP_CNT if self.stripped else _TILE_CNT)
        self.across = (self.width + self.tile_w - 1) // self.tile_w
        self.down = (self.height + self.tile_h - 1) // self.tile_h

        sx, sy, _ = self._v(_PIXEL_SCALE)
        tie = self._v(_TIE_POINT)
        self.scale = (sx, sy)
        self.origin = (tie[3], tie[4])  # world x,y of the top-left corner of pixel (0,0)

    def _v(self, tag: int, default=None):
        if tag not in self._tags:
            if default is None:
                raise KeyError(f"missing TIFF tag {tag}")
            return default
        typ, cnt, off, inline = self._tags[tag]
        size = _TYPE_SIZE[typ]
        fmt = "<" + _TYPE_FMT[typ] * cnt
        if cnt * size <= self._off_size:
            return struct.unpack_from(fmt, self._head, inline)
        need = off + cnt * size
        buf = self._head if need <= len(self._head) else _fetch(self.url, 0, need + 4096)
        return struct.unpack_from(fmt, buf, off)

    # ── geo ──
    def world_to_pixel(self, x: float, y: float) -> tuple[float, float]:
        return (x - self.origin[0]) / self.scale[0], (self.origin[1] - y) / self.scale[1]

    def tile_index(self, band: int, ty: int, tx: int) -> int:
        return band * self.across * self.down + ty * self.across + tx

    # ── pixels ──
    def read_tile(self, band: int, ty: int, tx: int, raw: bytes | None = None) -> np.ndarray:
        """One decoded tile. Pass `raw` to decode bytes already cached on disk."""
        if raw is None:
            i = self.tile_index(band, ty, tx)
            off, cnt = self.offsets[i], self.counts[i]
            if cnt == 0:
                return np.zeros((self.tile_h, self.tile_w), dtype=np.float32)
            raw = _fetch(self.url, off, off + cnt - 1)
        buf = zlib.decompress(raw)
        if self.predictor == 3:
            return _undo_float_predictor(buf, self.tile_w, self.tile_h)
        a = np.frombuffer(buf, dtype=self.dtype).reshape(self.tile_h, self.tile_w)
        if self.predictor == 2:  # horizontal differencing
            a = np.cumsum(a, axis=1, dtype=np.int64).astype(self.dtype)
        return a.astype(np.float32)

    def fetch_chunk_range(self, ty0: int, ty1: int) -> dict[int, bytes]:
        """Chunks ty0..ty1 inclusive, in as few requests as the file's layout allows.

        A one-row-per-strip raster has 65,536 chunks, and asking for each separately
        is 65,536 round trips for a window that is physically contiguous on disk. The
        chunks in a run are almost always laid out end to end, so one range request
        covers the lot and the byte counts split it back up.
        """
        ty1 = min(ty1, self.down - 1)
        if ty1 < ty0:
            return {}
        starts = [self.offsets[i] for i in range(ty0, ty1 + 1)]
        ends = [self.offsets[i] + self.counts[i] for i in range(ty0, ty1 + 1)]
        lo, hi = min(starts), max(ends)
        blob = _fetch(self.url, lo, hi - 1)
        out = {}
        for i in range(ty0, ty1 + 1):
            o, c = self.offsets[i] - lo, self.counts[i]
            out[i] = blob[o:o + c] if c else b""
        return out

    def fetch_tile_bytes(self, band: int, ty: int, tx: int) -> bytes:
        i = self.tile_index(band, ty, tx)
        off, cnt = self.offsets[i], self.counts[i]
        return b"" if cnt == 0 else _fetch(self.url, off, off + cnt - 1)


def _undo_float_predictor(buf: bytes, tw: int, th: int) -> np.ndarray:
    """Reverse TIFF predictor 3 on a float32 tile.

    Predictor 3 does two things a plain read does not undo: each row is stored as four
    byte-planes (all the high bytes, then the next, ...), and the bytes are horizontal
    differences. So the row is cumulatively summed byte-wise, then the planes are
    interleaved back into floats, most significant byte first.

    The accumulation runs across the **whole row**, all four planes as one sequence,
    not independently within each plane. libtiff's fpAcc walks `cp[stride] += cp[0]`
    from the first byte of the row to the last with no regard for plane boundaries,
    so the first byte of the exponent plane continues from the last byte of the sign
    plane. Accumulating per plane instead decodes correctly only where a plane
    happens to start at a byte the difference did not carry into — which is why this
    read clean data out of one DEM tile and 1,600 m mountains out of the next.
    """
    a = np.frombuffer(buf, dtype=np.uint8).reshape(th, 4 * tw)
    a = np.cumsum(a, axis=1, dtype=np.uint32).astype(np.uint8).reshape(th, 4, tw)
    out = np.empty((th, tw, 4), dtype=np.uint8)
    for i in range(4):
        out[:, :, 3 - i] = a[:, i, :]
    return out.view(np.float32).reshape(th, tw)
