# HeatMind AI 🌡️ — Urban Heat Digital Twin

> A living digital twin of a city's heat. It doesn't just route around heat: it sees, predicts and explains it, street by street, minute by minute, person by person.

**Demo zone:** TSSM Bhivarabai Sawant College of Engineering & Research (BSCOER), Narhe / Dhayari, **Pune, Maharashtra**, covering about 4 km² of real OpenStreetMap geometry (473 street ways, 998 buildings, Jambhulwadi Lake, the NH48 bypass, Zeal College, School of Fashion Technology and more).

Built from the [PRD](docs/HeatMind_AI_PRD.md). Pitch walkthrough: [docs/demo-script.md](docs/demo-script.md).

---

## Quick start

Requirements: **Python 3.11+** and **Node 20+**.

```bash
# macOS / Linux, one command (checks versions, creates the venv, installs deps, starts both servers)
./start-dev.sh
```

```powershell
# Windows, one command
powershell -ExecutionPolicy Bypass -File .\start-dev.ps1
```

Or manually:

```bash
# 1. Backend (FastAPI) on :8000
cd backend
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt     # macOS/Linux: .venv/bin/python
.venv/Scripts/python -m uvicorn app.main:app --port 8000

# 2. Frontend (Next.js) on :3000, in a second terminal
cd frontend
npm ci
npm run dev
```

Open **http://localhost:3000**. The Next.js app proxies `/api/*` and `/docs` to the backend (override with `BACKEND_URL`).

> **Note on Node/Turbopack:** `npm run dev` defaults to Next.js's `--webpack` bundler, not Turbopack. As of Next.js 16.3.5, Turbopack's dev-server worker has a module-resolution bug with `@tailwindcss/oxide`'s native binding that can crash the app on load (`Cannot find native binding`) even when the package is installed correctly — a known class of npm/Turbopack optional-dependency issue. Use `npm run dev:turbopack` to try Turbopack once that's fixed upstream. Also confirm `node -v` is **20.9.0 or newer** — Next.js 16 fails with an unrelated-looking error on older Node.

Optional: `set ANTHROPIC_API_KEY=...` before starting the backend enables an LLM polish of the explanation text. The rule-based explanation always works and is never blocked.

---

## What's inside (the 5 engines)

| Pillar | Where | How |
|---|---|---|
| **Urban Heat Digital Twin** | `backend/app/services/heat_twin_service.py` | 10 m raster of pedestrian feels-like heat. NOAA heat index of ambient air, plus direct solar load × sun exposure, ground long-wave from surface material (asphalt / concrete / dry ground / grass / water), traffic heat and urban-canyon retention, minus canopy evapotranspiration and lake cooling. |
| **AI Shadow Engine** | `services/shadow_engine.py`, `services/solar.py` | NOAA solar ephemeris gives sun elevation and azimuth. Every cell ray-marches toward the sun through the building-height and tree-canopy fields. Building shadow polygons are cast at `h / tan(elev)` toward `azimuth + 180°`. |
| **Future Heat Prediction** | `services/prediction_service.py` | Physics-informed nowcast from now to +3 h (15-minute keyframes): shadows are recomputed for the future sun position, and air temperature and RH are interpolated from the Open-Meteo hourly forecast (or the demo scenario curve). |
| **Personalized Heat Risk Engine** | `services/risk_scoring.py` | Six transparent factors (cumulative exposure, peak heat index, shade, exertion, rest/water gaps, surface radiant heat), each weighted per persona (Student / Outdoor Worker / Senior / Cyclist) into a 0–100 score. Personas also differ in speed, vulnerability shift and daily budget. |
| **Digital Heat Passport** | `services/passport_service.py` | Minutes in NOAA "danger" heat vs. a daily budget, shaded distance, rest stops, streaks and badges, stored in SQLite under an anonymous session token. |

Plus:

- **Heat-aware routing** (`services/routing_service.py`): Dijkstra over the real OSM street graph. A sweep of heat-aversion weights combined with the penalty method yields ≥2 distinct routes from fastest to coolest. Walkers are sampled on the shady kerb, cyclists on the carriageway.
- **Explainability** (`services/explanation_service.py`): every score ships with a rule-based "why" (shade %, peak °C along a named street, water points, trade-off vs. the fastest route), with an optional LLM polish that falls back silently.
- **Simulate** (`POST /api/routes/simulate`): advance the clock or spike the temperature. Every route is re-scored in under 1 s, and you get a reroute suggestion if your route is no longer the safest.

## Screens

The map is the hero: on desktop it keeps at least 85% of the screen, and route paths are always framed clear of the UI.

- **Live clock**: everything is anchored to the user's current local time. The clock ticks every second; the forecast baseline, heat surface, shadows, risk scores and route recommendations re-anchor to "now" automatically every 5 minutes. There are no fixed demo timestamps.
- **Global navigation** (Twin · Heat Passport · How it works) appears on every screen: a top pill on desktop, a tab bar on phones.
- **Left route sheet**: a compact comparison list (time, live risk, shade, water, sun-exposure reduction) docked left and collapsible; route details open inside the same sheet. On phones it's a slim peek with swipeable route chips.

- **Map ↔ Heat Twin** toggle: Heat Twin tilts into 3D with extruded buildings lit by the real sun position, computed ground shadows, glowing cooling corridors (coolest 22% of streets), hot streets and a hotspot heat layer.
- **Future Heat timeline**: Now → +30m → +1h → +2h → +3h. Continuous scrubbing cross-fades the heat forecast keyframes; shadows, lighting, route colours and risk scores update in place. Routes never animate or redraw along the map.
- **⚡ Simulate**: a small floating button with a temperature spike popover and live reroute suggestion.
- `/passport`: Heat Passport in an Apple Health style (Heat Rings, Highlights, weekly metrics, Awards) · `/about`: engines, persona weights and data provenance · `/route/[id]`: shareable route detail.

## API (FastAPI, docs at `/docs`)

```
GET  /api/meta                         zone, clock, provenance, risk model
GET  /api/zone                         buildings / surfaces / trees GeoJSON + named places
GET  /api/heat/twin?scenario&time&offset_min&temp_delta&format=grid|geojson
GET  /api/heat/predict?horizon=30m|1h|2h|3h
GET  /api/heat/layers?time              cooling corridors, hot streets, hotspots (Heat Twin mode)
GET  /api/heat/point?lat&lon           probe one location
GET  /api/shadow?time                  building shadow polygons
GET  /api/pois?type=water,rest,shade,cooling_center
POST /api/routes/compare               { origin, destination, persona, scenario, depart_at }
POST /api/routes/simulate              { compare_id, route_id, simulate: { time_offset_min, temp_delta_c } }
GET  /api/routes/{route_id}
GET  /api/risk/explain?route_id&polish_llm=true
GET  /api/risk/weights
POST /api/users/persona                { session_token, persona, seed_sample }
GET  /api/passport/{user_id}
POST /api/passport/log                 { user_id, route_id, rest_stops_taken }
```

## Data provenance (honest by design)

| Layer | Status |
|---|---|
| Street network, building footprints, land use, lake, amenities | **Real** (OpenStreetMap via Overpass, `backend/data/osm_raw.json`) |
| Building heights | OSM `building:levels` where tagged (25 buildings), typology estimate otherwise |
| Tree canopy | **Estimated**: per-street avenue/bare assignment plus campus and lake-edge vegetation (OSM has no tree survey here) |
| Water / rest / shade points | OSM amenities plus seeded points (flagged `source: "seeded"`) |
| Sun position | **Real** (NOAA algorithm) |
| Weather | Open-Meteo at the live current time · Pune climatology fallback (offline) |
| Heat surface | **Modelled** (physics-informed synthetic, PRD §9) |

To rebuild the zone from a fresh OSM extract: replace `backend/data/osm_raw.json`, delete `backend/data/zone.json`, then run `python scripts/ingest_osm.py` from `backend/`.

## Stack

Next.js 16 (App Router) · Tailwind CSS v4 · MapLibre GL 6 · Zustand · lucide-react · Geist — FastAPI · NumPy · httpx · SQLite.

The current build runs entirely on SQLite + in-memory rasters — that's what's actually wired up and what the demo uses. `backend/app/db/migrations/001_postgis.sql` is a draft schema for the Phase 2 city-scale migration (see Roadmap below); it is **not** applied or used by the app today.

## Roadmap

Phase 2: Landsat 8/9 and Sentinel-3 LST ingestion, plus a gradient-boosted residual model trained on historical LST and weather. City-wide coverage on PostGIS with tiled rasters. Phase 3: municipal heat-action-plan integration and a B2B API for delivery and construction workforce heat safety.
