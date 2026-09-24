#!/usr/bin/env python3
"""Refetch the Overpass extract for a bbox, in tiles, resumably.

The twin reads backend/data/osm_raw.json and never calls Overpass at runtime; this
is only rerun when the zone bbox changes or the snapshot goes stale.

Tiled on purpose. A single query for the whole south-Pune zone reliably exceeds what
public Overpass instances will finish -- kumi.systems ran 15 minutes without
returning and the main instance answers with a dispatcher error under load.
Splitting into small tiles keeps each request inside what a loaded mirror will
actually complete, and the elements are merged and de-duplicated by (type, id).

Resumable on purpose, too. Public Overpass availability swings hour to hour: a run
that dies on tile 12 of 15 used to throw away the eleven tiles that had succeeded,
which on a bad day meant the fetch could never finish at all. Every tile is now
cached under backend/data/osm_tiles/ as soon as it lands, a rerun skips what it
already has, and a tile that fails everywhere is reported rather than aborting the
run. Rerun until it says nothing is missing.

Usage:
    python scripts/fetch_osm.py <south> <west> <north> <east> [--tiles 3x5] [-o PATH]
    python scripts/fetch_osm.py ... --probe        # rank mirrors, fetch nothing
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Order matters: the first mirror that answers wins, so the list is kept in rough
# "most likely to respond" order. Public instances rate-limit and fall over
# independently of each other, which is the entire reason there is a list.
#
# Every entry must carry the WHOLE PLANET. Regional instances are the dangerous
# failure here, not dead ones: overpass.osm.ch answers a Pune query promptly, with
# HTTP 200 and valid JSON containing zero elements, because it only holds
# Switzerland. That silently cached 22 empty tiles and would have built a blank
# city. Hence the emptiness checks below -- do not add a mirror without confirming
# it is global.
#
# z./lz4. are the main instance's alternate front ends. They are worth listing
# separately because they load-balance independently: with overpass-api.de itself
# answering 504 on every request, z.overpass-api.de returned the same query in 1.5s.
MIRRORS = [
    "https://z.overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
# Overpass returns 406 without a User-Agent that identifies the client.
UA = "HeatMind/1.0 (urban heat digital twin; academic project)"

CACHE_DIR = pathlib.Path("backend/data/osm_tiles")

# Seconds to stand down after an HTTP 429 from a mirror.
RATE_LIMIT_COOLDOWN_S = 75
# Breathing room between tiles. Public instances meter by query slot, and going
# straight into the next tile is what earns the 429 in the first place.
INTER_TILE_PAUSE_S = 3
# How many times to re-probe before giving up on a run. Availability swings, and
# a single unlucky probe should not discard the cached tiles a rerun could use.
PROBE_ATTEMPTS = 3

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
  node["place"]({bbox});
);
out body;
>;
out skel qt;
"""

# Neighbourhood and suburb names -- Swargate, Katraj, Dhankawadi, Narhe -- are
# `place=*` nodes, not amenities, so without this they never reach the search box
# and a user simply cannot pick "Swargate" as a destination. It is one tiny query
# for the whole bbox (a few hundred nodes), so it is fetched whole rather than
# tiled, and kept separate so adding it does not invalidate the tile cache.
PLACE_QUERY = """[out:json][timeout:120];
(
  node["place"]({bbox});
  way["railway"="station"]({bbox});
  node["railway"="station"]({bbox});
);
out body;
>;
out skel qt;
"""


def cache_path(bbox: str, tag: str = "") -> pathlib.Path:
    return CACHE_DIR / ((tag + "_" if tag else "")
                       + bbox.replace(",", "_").replace(".", "p") + ".json")


def request(mirror: str, data: str, timeout: int) -> bytes:
    req = urllib.request.Request(
        mirror,
        data=urllib.parse.urlencode({"data": data}).encode(),
        headers={
            "User-Agent": UA,
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# A few hundred metres of central Narhe. Any planet-wide instance returns dozens of
# ways here, so an empty answer is proof the mirror does not hold India.
PROBE_QUERY = '[out:json][timeout:25];(way["highway"](18.4427,73.8318,18.4470,73.8360););out skel qt;'


# 25s, not the per-tile timeout: the probe query is trivial, so a mirror that has
# not answered it by then is loaded enough to be useless for real tiles anyway,
# and four dead mirrors at 60s each cost two minutes before any work starts.
def probe(timeout: int = 25) -> list[str]:
    """Mirrors that actually return Indian data, fastest first; throttled ones last."""
    ranked: list[tuple[float, str]] = []
    throttled: list[str] = []
    for m in MIRRORS:
        host = m.split("//")[1].split("/")[0]
        t0 = time.time()
        try:
            payload = request(m, PROBE_QUERY, timeout)
            dt = time.time() - t0
            if payload[:1] != b"{":
                print(f"  {host:<40} {dt:6.1f}s  bad response {payload[:40]!r}", flush=True)
                continue
            n = len(json.loads(payload).get("elements", []))
            if n == 0:
                print(f"  {host:<40} {dt:6.1f}s  EMPTY over Pune - not a global mirror, skipping",
                      flush=True)
                continue
            ranked.append((dt, m))
            print(f"  {host:<40} {dt:6.1f}s  ok ({n} ways)", flush=True)
        except urllib.error.HTTPError as e:
            # 429 means "you have used your query slots", not "this mirror is down".
            # Dropping it here is how a whole run got abandoned against the only
            # working instance, so keep it, just at the back of the queue.
            note = "rate-limited, keeping (throttled)" if e.code == 429 else f"HTTP {e.code}"
            print(f"  {host:<40} {time.time() - t0:6.1f}s  {note}", flush=True)
            if e.code == 429:
                throttled.append(m)
        except Exception as e:  # noqa: BLE001 - any failure just deranks the mirror
            print(f"  {host:<40} {time.time() - t0:6.1f}s  {type(e).__name__}", flush=True)
    ranked.sort()
    return [m for _, m in ranked] + throttled


def fetch_tile(bbox: str, mirrors: list[str], timeout: int,
               query: str = QUERY, tag: str = "") -> dict | None:
    """Return a tile's elements, from cache if present. None if every mirror failed."""
    p = cache_path(bbox, tag)
    if p.exists():
        try:
            cached = json.loads(p.read_text(encoding="utf8"))
            if cached.get("elements"):
                return cached
            p.unlink()  # empty: a regional mirror slipped through, refetch it
        except json.JSONDecodeError:
            p.unlink()  # truncated by an interrupted run; refetch it

    log: list[str] = []
    for mirror in mirrors:
        host = mirror.split("//")[1].split("/")[0]
        for backoff in (0, 20, 60):
            if backoff:
                time.sleep(backoff)
            try:
                payload = request(mirror, query.format(bbox=bbox), timeout)
                if payload[:1] != b"{":
                    log.append(f"{host}: non-JSON {payload[:50]!r}")
                    continue
                data = json.loads(payload)
                # Every tile in this bbox contains at least a road. An empty answer
                # means the mirror does not hold India, so take it as a failure and
                # move on rather than caching a hole in the city.
                if not data.get("elements"):
                    log.append(f"{host}: 200 but zero elements (not a global mirror?)")
                    break  # no point retrying this mirror, it has no Indian data
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                p.write_text(json.dumps(data), encoding="utf8")
                return data
            except urllib.error.HTTPError as e:
                log.append(f"{host}: HTTP {e.code}")
                if e.code == 429:
                    # The main instance hands out a fixed number of query slots and
                    # frees them on a timer. Retrying inside that window just spends
                    # another one, so wait the cooldown out rather than hammering.
                    print(f"      {host} rate-limited, waiting {RATE_LIMIT_COOLDOWN_S}s",
                          flush=True)
                    time.sleep(RATE_LIMIT_COOLDOWN_S)
            except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as e:
                log.append(f"{host}: {type(e).__name__} {str(e)[:60]}")
    print("      all mirrors failed:", flush=True)
    for line in log[-4:]:
        print(f"        {line}", flush=True)
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("south", type=float)
    ap.add_argument("west", type=float)
    ap.add_argument("north", type=float)
    ap.add_argument("east", type=float)
    ap.add_argument("--tiles", default="3x5", help="cols x rows, e.g. 3x5")
    ap.add_argument("-o", "--out", default="backend/data/osm_raw.json")
    ap.add_argument("--timeout", type=int, default=300, help="per-request seconds")
    ap.add_argument("--probe", action="store_true", help="rank mirrors and exit")
    ap.add_argument("--allow-partial", action="store_true",
                    help="write the merged file even if some tiles are missing")
    a = ap.parse_args()

    # Public Overpass availability comes and goes minute to minute, so one bad probe
    # is not a reason to throw away a run that has cached tiles waiting to be used.
    mirrors: list[str] = []
    for attempt in range(PROBE_ATTEMPTS):
        print("probing mirrors ..." if attempt == 0
              else f"probing mirrors (attempt {attempt + 1}/{PROBE_ATTEMPTS}) ...", flush=True)
        mirrors = probe()
        if mirrors or a.probe:
            break
        if attempt < PROBE_ATTEMPTS - 1:
            print(f"  nothing responded; waiting {RATE_LIMIT_COOLDOWN_S}s before retrying",
                  flush=True)
            time.sleep(RATE_LIMIT_COOLDOWN_S)
    if a.probe:
        return 0
    if not mirrors:
        print("\nNo Overpass mirror is responding. Nothing fetched; cached tiles are kept,")
        print("so rerunning the same command later resumes from where this stopped.")
        return 1
    print(f"using {len(mirrors)} responsive mirror(s)\n", flush=True)

    cols, rows = (int(x) for x in a.tiles.lower().split("x"))
    dlat = (a.north - a.south) / rows
    dlon = (a.east - a.west) / cols

    merged: dict[tuple[str, int], dict] = {}
    meta: dict = {}
    missing: list[str] = []
    total = cols * rows
    for r in range(rows):
        for c in range(cols):
            s = a.south + r * dlat
            w = a.west + c * dlon
            bbox = f"{s:.6f},{w:.6f},{s + dlat:.6f},{w + dlon:.6f}"
            i = r * cols + c + 1
            cached = cache_path(bbox).exists()
            print(f"[{i}/{total}] {bbox}{' (cached)' if cached else ' ...'}", flush=True)
            t0 = time.time()
            data = fetch_tile(bbox, mirrors, a.timeout)
            if data is None:
                missing.append(bbox)
                continue
            meta = meta or {k: data[k] for k in ("version", "generator", "osm3s") if k in data}
            new = 0
            for el in data["elements"]:
                key = (el["type"], el["id"])
                if key not in merged:
                    merged[key] = el
                    new += 1
            if not cached:
                print(f"      {len(data['elements']):,} elements ({new:,} new)"
                      f" in {time.time() - t0:.0f}s", flush=True)
                time.sleep(INTER_TILE_PAUSE_S)

    # One extra whole-bbox pass for place names, so "Swargate" is something a user
    # can actually type into the search box and route to.
    whole = f"{a.south:.6f},{a.west:.6f},{a.north:.6f},{a.east:.6f}"
    print(f"\n[places] {whole} ...", flush=True)
    pdata = fetch_tile(whole, mirrors, a.timeout, query=PLACE_QUERY, tag="places")
    if pdata is None:
        print("      place names unavailable this run; rerun to add them", flush=True)
    else:
        new = 0
        for el in pdata["elements"]:
            key = (el["type"], el["id"])
            if key not in merged:
                merged[key] = el
                new += 1
        named = sum(1 for e in pdata["elements"] if e.get("tags", {}).get("place"))
        print(f"      {len(pdata['elements']):,} elements ({new:,} new, {named:,} named places)",
              flush=True)

    n_nodes = sum(1 for k in merged if k[0] == "node")
    n_ways = sum(1 for k in merged if k[0] == "way")
    print(f"\n{len(merged):,} merged elements ({n_nodes:,} nodes, {n_ways:,} ways)"
          f" from {total - len(missing)}/{total} tiles")

    if missing and not a.allow_partial:
        print(f"\n{len(missing)} tile(s) still missing - NOT writing {a.out}.")
        print("Completed tiles are cached, so rerunning the same command resumes:")
        for bbox in missing:
            print(f"  {bbox}")
        return 1

    with open(a.out, "w", encoding="utf8") as f:
        json.dump(dict(meta, elements=list(merged.values())), f)
    print(f"wrote {a.out}")
    if missing:
        print(f"WARNING: written with {len(missing)} tile(s) missing - coverage has holes.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
