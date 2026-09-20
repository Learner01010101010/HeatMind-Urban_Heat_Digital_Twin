"""Zone + runtime configuration for HeatMind AI."""
from __future__ import annotations

import os
from datetime import timedelta, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
OSM_RAW = DATA_DIR / "osm_raw.json"
ZONE_FILE = DATA_DIR / "zone.json"
DB_FILE = Path(os.environ.get("HEATMIND_DB", DATA_DIR / "heatmind.sqlite3"))

# Demo zone: TSSM Bhivarabai Sawant College of Engineering, Narhe / Dhayari, Pune
ZONE_NAME = "TSSM BSCOER Campus · Narhe, Pune"
ZONE_CITY = "Pune, Maharashtra"
# south, west, north, east
BBOX = (18.4335, 73.8245, 18.4500, 73.8450)
CENTER = (18.4427259, 73.8318459)

# India Standard Time (fixed offset — no tzdata dependency on Windows)
TZ = timezone(timedelta(hours=5, minutes=30), name="IST")

# Raster resolution of the digital twin (metres). PRD asks for ~30 m; we run at 10 m.
CELL_M = 10.0

# Pedestrian "effective heat" thresholds used across the product (°C, feels-like)
HIGH_HEAT_C = 32.0
COLOR_MIN_C = 28.0
COLOR_MAX_C = 46.0

# All calculations are anchored to the live current time — there is no fixed demo timestamp.

# Optional LLM polish for explanations (never blocks the UI)
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
LLM_MODEL = os.environ.get("HEATMIND_LLM_MODEL", "claude-haiku-4-5")
LLM_TIMEOUT_S = float(os.environ.get("HEATMIND_LLM_TIMEOUT", "4"))

ALLOWED_ORIGINS = os.environ.get(
    "HEATMIND_CORS", "http://localhost:3000,http://127.0.0.1:3000"
).split(",")
