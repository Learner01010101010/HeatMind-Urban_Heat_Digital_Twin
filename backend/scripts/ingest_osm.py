"""Rebuild data/zone.json from data/osm_raw.json (Overpass extract).

Usage:  python -m scripts.ingest_osm      (run from backend/)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.osm_ingest import build_zone  # noqa: E402

if __name__ == "__main__":
    z = build_zone()
    print("zone.json written:", z["meta"]["counts"])
