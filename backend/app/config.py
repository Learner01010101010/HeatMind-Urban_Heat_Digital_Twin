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

# South Pune, from Narhe up the Satara Road spine to Swargate. The zone used to be
# the ~4 km2 block around the TSSM BSCOER campus; it now covers the corridor the
# app is actually asked about, taking in Dhayari, Narhe, Katraj, Bharati
# Vidyapeeth / Dhankawadi, Bibwewadi and Swargate.
#
# 18.4300..18.5060 N is 8.4 km; 73.8200..73.8620 E is 4.4 km at this latitude.
# At CELL_M that is ~840 x 443 = 372k cells, 9.4x the campus grid. Both the
# frame cache budget and the building typology index were sized for this.
ZONE_NAME = "South Pune · Narhe to Swargate"
ZONE_CITY = "Pune, Maharashtra"
# south, west, north, east
BBOX = (18.4300, 73.8200, 18.5060, 73.8620)
# Dhankawadi, roughly the middle of the corridor and a sane opening view.
CENTER = (18.4680, 73.8410)

# India Standard Time (fixed offset — no tzdata dependency on Windows)
TZ = timezone(timedelta(hours=5, minutes=30), name="IST")

# Raster resolution of the digital twin (metres). PRD asks for ~30 m; we run at 10 m.
CELL_M = 10.0

# Canyon long-wave trapping model.
#   on (default) -> canyon = CANYON_K_SVF     * (1 - sky_view_factor)     [physical]
#   off          -> canyon = CANYON_K_DENSITY * box_blur(building_mask)   [original]
#                   set HEATMIND_SVF_CANYON=0 to compare against the old model
# The SVF form is the urban-climatology standard (Oke; SOLWEIG/UMEP) and redistributes
# canyon heat far more realistically. It SHIFTS REPORTED TEMPERATURES slightly, so any
# figure quoted in the PRD / demo script must be read against this model, not the old one.
# CANYON_K_SVF is calibrated so the zone-mean canyon term matches the density model.
USE_SVF_CANYON = os.environ.get("HEATMIND_SVF_CANYON", "1").lower() in ("1", "true", "yes", "on")
CANYON_K_DENSITY = 1.2
# k = 1.98 makes mean(k*(1-SVF)) equal mean(1.2*built_density) over walkable cells,
# so the zone-average canyon contribution is unchanged and only its DISTRIBUTION
# improves (corr 0.84 with the old term; p99 0.54 -> 0.72, i.e. real canyons get
# the trapping that was previously smeared across open ground).
CANYON_K_SVF = float(os.environ.get("HEATMIND_CANYON_K_SVF", "1.98"))

# Pedestrian "effective heat" thresholds used across the product (°C, feels-like)
HIGH_HEAT_C = 32.0
# Reported in /api/meta so a client can label the legend. These mirror the first and
# last stop of HEAT_STOPS in frontend/lib/heatColorScale.ts -- keep the two in step.
# The floor is the twin's own encoding floor (feels_c = 20 + v/4), so nothing clamps.
COLOR_MIN_C = 20.0
COLOR_MAX_C = 56.0

# All calculations are anchored to the live current time — there is no fixed demo timestamp.

# Optional LLM polish for explanations (never blocks the UI)
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
LLM_MODEL = os.environ.get("HEATMIND_LLM_MODEL", "claude-haiku-4-5")
LLM_TIMEOUT_S = float(os.environ.get("HEATMIND_LLM_TIMEOUT", "4"))

ALLOWED_ORIGINS = os.environ.get(
    "HEATMIND_CORS", "http://localhost:3000,http://127.0.0.1:3000"
).split(",")
