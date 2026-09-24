#!/usr/bin/env python3
"""Refetch the Overpass extract for a bbox, in tiles.

The twin reads backend/data/osm_raw.json and never calls Overpass at runtime; this
is only rerun when the zone bbox changes or the snapshot goes stale.

Tiled on purpose. A single query for the whole 42 km2 south-Pune zone reliably
exceeds what public Overpass instances will finish -- kumi.systems ran 15 minutes
without returning and the main instance answers with a dispatcher error under load.
Splitting into ~5 km2 tiles keeps each request small enough to complete, and the
elements are merged and de-duplicated by (type, id) afterwards.

Usage:
    python scripts/fetch_osm.py <south> <west> <north> <east> [--tiles 4x2] [-o PATH]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

MIRRORS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
UA = "HeatMind/1.0 (urban heat digital twin; academic project)"

QUERY = """[out:json][timeout:180];
(
  way["building"]({bbox});
  way["highway"]({bbox});
  way["landuse"]({bbox});
  way["leisure"]({bbox});
  way["natural"]({bbox});
  way["amenity"]({bbox});
  way["waterway"]({bbox});
  node["amenity"]({bbox});
  node["shop"]({bbox});
  node["natural"="tree"]({bbox});
);
out body;
>;
out skel qt;
"""


def fetch_tile(bbox: str, attempt_log: list[str]) -> dict:
    body = urllib.parse.urlencode({"data": QUERY.format(bbox=bbox)}).encode()
    for mirror in MIRRORS:
        for backoff in (0, 20, 60):
            if backoff:
                time.sleep(backoff)
            req = urllib.request.Request(
                mirror, data=body,
                headers={"User-Agent": UA, "Accept": "application/json",
                         "Content-Type": "application/x-www-form-urlencoded"},
            )
            try:
                with urllib.request.urlopen(req, timeout=300) as r:
                    payload = r.read()
                if payload[:1] != b"{":
                    attempt_log.append(f"{mirror}: non-JSON ({payload[:60]!r})")
                    continue
                return json.loads(payload)
            except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as e:
                attempt_log.append(f"{mirror}: {type(e).__name__} {e}")
    raise RuntimeError("every mirror failed for " + bbox + "\n  " + "\n  ".join(attempt_log[-6:]))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("south", type=float)
    ap.add_argument("west", type=float)
    ap.add_argument("north", type=float)
    ap.add_argument("east", type=float)
    ap.add_argument("--tiles", default="4x2", help="cols x rows, e.g. 4x2")
    ap.add_argument("-o", "--out", default="backend/data/osm_raw.json")
    a = ap.parse_args()

    cols, rows = (int(x) for x in a.tiles.lower().split("x"))
    dlat = (a.north - a.south) / rows
    dlon = (a.east - a.west) / cols

    merged: dict[tuple[str, int], dict] = {}
    meta = None
    total = cols * rows
    for r in range(rows):
        for c in range(cols):
            s = a.south + r * dlat
            w = a.west + c * dlon
            bbox = f"{s:.6f},{w:.6f},{s + dlat:.6f},{w + dlon:.6f}"
            i = r * cols + c + 1
            print(f"[{i}/{total}] {bbox} ...", flush=True)
            t0 = time.time()
            data = fetch_tile(bbox, [])
            meta = meta or {k: data[k] for k in ("version", "generator", "osm3s") if k in data}
            new = 0
            for el in data["elements"]:
                key = (el["type"], el["id"])
                if key not in merged:
                    merged[key] = el
                    new += 1
            print(f"      {len(data['elements']):,} elements ({new:,} new) in {time.time() - t0:.0f}s", flush=True)

    out = dict(meta or {})
    out["elements"] = list(merged.values())
    with open(a.out, "w", encoding="utf8") as f:
        json.dump(out, f)
    n_nodes = sum(1 for k in merged if k[0] == "node")
    n_ways = sum(1 for k in merged if k[0] == "way")
    print(f"\nwrote {a.out}: {len(merged):,} elements ({n_nodes:,} nodes, {n_ways:,} ways)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
