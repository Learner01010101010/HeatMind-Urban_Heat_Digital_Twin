# HeatMind AI — Product Requirements Document

**Project codename:** HeatMind AI (built on the CoolRoute challenge track)
**Category:** Climate Resilience / Urban AI / Digital Twin
**Doc owner:** Sudiksha
**Version:** 1.0 — Hackathon MVP
**Build window:** 48 hours
**Status:** Draft for build kickoff

---

## 0. One-line pitch

**HeatMind AI is a living digital twin of a city's heat — not a route planner that avoids heat, but a system that sees, predicts, and explains it, street by street, minute by minute, person by person.**

---

## 1. Problem Statement

The fastest walking, cycling, or outdoor-work route is not always the safest one during extreme heat. Heat exposure is not a single number — it changes with:

- Time of day and sun angle
- Surface material and temperature (asphalt vs. grass vs. concrete)
- Shade coverage from trees and buildings
- Traffic and vehicle heat contribution
- Humidity and "feels-like" temperature
- Route duration and cumulative exposure
- Access to shade, drinking water, and rest points

Most existing tools (Google Maps, city heat advisories, weather apps) present **one city-level temperature** as if it applies uniformly to every street. It doesn't. A shaded park path at 2pm can be 8–12°C cooler than an adjacent asphalt arterial with no tree canopy. People walking to class, working outdoors, cycling to a shift, or simply elderly residents running errands have no way to see this difference, let alone plan around it.

**Core insight:** heat exposure is hyperlocal, dynamic, and personal — and no consumer tool currently models it that way.

## 2. Vision

CoolRoute's brief asks for a route planner. HeatMind AI answers a bigger question underneath it: **what if the map itself understood heat the way it understands roads?**

Instead of shipping "Google Maps + a heat filter," HeatMind AI builds the missing layer of city infrastructure: a real-time, physics-informed, AI-predicted **Urban Heat Digital Twin** for a campus or city zone. Routing becomes just one consumer of that twin — alongside prediction, shade simulation, personalized risk, and a persistent "heat passport" that follows the user across days.

**Why this framing wins a hackathon:** judges see dozens of "route planner" submissions. A digital twin + prediction engine + explainability layer demonstrates systems thinking, technical depth (geospatial AI, not just a Dijkstra shortest path), and a platform story that scales past routing into urban planning, insurance, public health, and city operations.

## 3. Mission Alignment (challenge brief mapping)

| Challenge requirement | HeatMind AI answer |
|---|---|
| Prototype for one campus/city zone | Selected zone: a university campus + adjoining 1.5 km² city block (configurable) |
| Compare ≥2 routes with transparent heat-risk score | Route Comparison Panel with explainable 0–100 Heat Risk Score, factor breakdown |
| Display shaded/rest/water points | Map layer of shade, water fountains, cooling centers, rest benches |
| Show trade-off between time and heat exposure | Time-vs-Exposure trade-off slider + dual-axis chart |
| Reroute when simulated condition changes | "Simulate" control (advance time, spike temperature) triggers live re-scoring and reroute |
| Explain why one route is safer | Natural-language AI explanation generated per route, factor-by-factor |
| Avoid single city-level temperature | Urban Heat Digital Twin renders a per-segment (per ~30m) heat surface, not one number |

## 4. Target Users & Personas

HeatMind AI's **Personalized Heat Risk Engine** adjusts the same physical heat data differently per persona, because identical exposure is not equally risky for everyone.

**1. The Student**
Walking between classes, 10–25 min trips, repeated 4–6x/day, backpack load, often rushing and skipping shade for speed. Risk drivers: cumulative daily exposure, dehydration, poor sun protection habits.

**2. The Outdoor Worker**
Delivery, construction, landscaping, gig work. Long continuous exposure (1–4 hrs), physical exertion, limited schedule flexibility. Risk drivers: heat index + exertion multiplier, lack of break access, PPE/uniform heat retention.

**3. The Senior Resident**
Errands, short walks, medical appointments. Reduced thermoregulation, higher heat-stroke vulnerability at lower thresholds, slower pace lengthens exposure duration. Risk drivers: age-adjusted risk curve, need for frequent rest points, mobility constraints (avoid stairs/steep grades in heat).

**4. The Cyclist**
Commuting or exercise, higher speed reduces exposure duration but increases airflow-adjusted heat index miscalculation risk and asphalt proximity. Risk drivers: road surface radiant heat, headwind/tailwind cooling effect, hydration access along route.

Each persona has a distinct **risk-weighting model** (Section 10) rather than a single global score — this is the product's core personalization thesis.

## 5. Core Product Pillars (the 5 systems)

### 5.1 Urban Heat Digital Twin
A live, tile-based geospatial model of the selected zone rendering land surface temperature (LST), shade coverage, surface material, and pedestrian-level heat index as a continuous color-graded heat surface at ~30m resolution — not a single city-wide number. Built from satellite LST + tree canopy + building footprint + surface classification data, refreshed on a simulated real-time cadence for the demo.

### 5.2 Future Heat Prediction (30m / 1h / 2h)
A short-horizon forecasting layer that projects how the heat surface will evolve over the next 30 minutes, 1 hour, and 2 hours, using sun-angle progression, forecasted air temperature/humidity, and shade-shift modeling (shadows move — a route safe now may be exposed in 45 minutes, and vice versa). This turns HeatMind from a snapshot tool into a *planning* tool: "leave now vs. leave in 40 minutes" becomes an answerable question.

### 5.3 AI Shadow Engine
A geometric + ML shadow simulation combining tree canopy polygons, building footprints/heights, and real-time solar position (via solar ephemeris calculation) to render precise, time-varying shade polygons across the zone. This is what makes the digital twin *physically grounded* rather than a heuristic — shade is computed, not guessed.

### 5.4 Personalized Heat Risk Engine
Converts the raw physical heat surface + shadow data into a persona-adjusted 0–100 Heat Risk Score per route, using weighted factor models (Section 10) for Student / Worker / Senior / Cyclist. Outputs a transparent factor breakdown, not a black-box number.

### 5.5 Digital Heat Passport
A lightweight, persistent per-user record of cumulative heat exposure over a day/week — minutes spent above defined heat-index thresholds, shaded vs. unshaded distance, and hydration/rest stops taken. Reframes heat exposure the way step-count reframed fitness: a personal, trackable, shareable number. This is the retention and personalization hook that no competing route planner has.

## 6. What This Explicitly Is NOT

- Not a general-purpose navigation app (no turn-by-turn driving directions, no transit routing)
- Not a weather app (weather is an input, not the output)
- Not reliant on a single city-average temperature reading
- Not a black box — every score ships with a plain-language explanation

## 7. Screens (Information Architecture)

```
1. Onboarding / Persona Select   → choose Student / Worker / Senior / Cyclist (+ optional profile)
2. Home / Digital Twin Map       → default screen, heat surface + shade + POIs
3. Route Input                    → origin/destination search, "Now" vs "Leave at" time
4. Route Comparison                → ≥2 routes, Heat Risk Score, time-vs-exposure trade-off
5. Route Detail / Explain          → segment-by-segment breakdown, AI explanation, shade/water points along path
6. Future Heat Timeline            → 30m / 1h / 2h prediction scrubber over the twin
7. Simulate Panel                  → judge-facing control: jump time forward, spike temp, trigger live reroute
8. Heat Passport (Profile)         → daily/weekly exposure log, streaks, shaded-distance %, badges
9. Settings                        → persona edit, units (°C/°F), accessibility (motion-sensitivity, senior mode)
```

## 8. UI/UX Design Direction

**Design language:** "Climate command center meets consumer app" — dark, data-rich base (think flight-tracker / weather-radar aesthetic) with warm gradient heat overlays, contrasted by cool teal/blue "safe path" accents. Mobile-first, single-thumb reachable primary actions, bottom-sheet interaction pattern for route details so the map stays primary.

**Visual system**
- **Heat gradient scale:** deep blue (cool/shaded, <28°C effective) → teal → yellow → orange → deep red (>42°C effective, high risk), used consistently across twin, routes, and passport
- **Typography:** bold geometric sans for headlines/scores (e.g., Inter/Manrope), tabular numerals for the risk score so digits don't jitter on live updates
- **Motion:** heat surface subtly pulses/animates to read as "alive" (digital twin, not a static map); route lines animate a directional "flow" gradient from origin to destination
- **Micro-interaction:** dragging the Future Heat Timeline scrubber live-repaints the map heat surface and updates the risk score in place — this single interaction is the demo's visual centerpiece
- **Explainability card:** every risk score is paired with a 3–4 bullet plain-language "why" card (e.g., "62% of this route is shaded between 2–3pm," "Surface temperature 9°C cooler than Route B due to park canopy")
- **Accessibility:** WCAG AA contrast on all heat-scale text pairings, senior-mode increases touch targets/font size and simplifies route options to one recommended path

**Mobile-first layout pattern:** full-bleed map canvas, floating search bar (top), persona badge (top-right), bottom sheet (40% height, expandable to 90%) for route list/detail — matches familiar ride-share/maps mental models so users need zero onboarding friction.

## 9. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT (Next.js PWA)                      │
│  - Leaflet/Mapbox GL map canvas (heat tile overlay + shade layer)│
│  - Tailwind UI (mobile-first components)                        │
│  - Zustand/React Query for state + API cache                    │
│  - Deployed: Vercel                                               │
└───────────────────────────┬────────────────────────────────────┘
                             │ HTTPS / REST (JSON) + tile requests
┌───────────────────────────▼────────────────────────────────────┐
│                     API LAYER (FastAPI, Python)                  │
│  /routes  /heat/twin  /heat/predict  /shadow  /risk  /passport   │
│  - Pydantic schemas, async endpoints                              │
│  - Auth: lightweight JWT / anonymous session token                │
└──────┬───────────────┬────────────────┬───────────────┬─────────┘
       │               │                │               │
┌──────▼─────┐  ┌──────▼──────┐  ┌──────▼──────┐  ┌─────▼──────┐
│  Routing    │  │ Heat Twin   │  │ Shadow      │  │ Risk +     │
│  Engine     │  │ Service     │  │ Engine      │  │ Passport   │
│ (OSRM/       │  │ (LST +      │  │ (solar ephem│  │ Service    │
│  networkx    │  │  canopy +   │  │  + canopy + │  │ (persona   │
│  graph on    │  │  surface    │  │  footprints)│  │  weighting)│
│  OSM data)   │  │  fusion)    │  │              │  │             │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────┬──────┘
       │                │                 │                │
┌──────▼─────────────────▼─────────────────▼────────────────▼──────┐
│                     PostGIS (PostgreSQL + PostGIS)                 │
│  roads · buildings · tree_canopy · surface_zones · heat_readings   │
│  shade_polygons · pois (water/rest/shade) · users · passport_log   │
└─────────────────────────────────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                              ▼
     External Data Sources           AI/Prediction Layer
     - NASA/Landsat LST (or           - Lightweight regression/
       synthetic zone data)            gradient-boosting model for
     - OpenStreetMap (roads,           30m/1h/2h heat projection
       buildings, land use)          - Rule-based + LLM-generated
     - Open-Meteo (weather API)        natural-language explanations
     - Tree canopy dataset (city      - Solar position via `pysolar`/
       open data or manual GeoJSON      `suncalc`
       for demo zone)
```

**Key architectural decision for the 48-hour build:** real satellite LST ingestion pipelines are slow to stand up reliably in 48 hours. The MVP uses a **hybrid data strategy** — real OSM geometry (roads, buildings, land use) for structural accuracy, combined with a **physically-plausible synthetic heat model** (surface-material-based temperature offsets + time-of-day/sun-angle modulation) calibrated against real weather API data for the demo zone. This is disclosed transparently in the demo script (Section 16) as a deliberate, defensible MVP simplification — judges respect honesty about data-source trade-offs far more than an unexplained black box.

## 10. AI / Scoring Workflow

### 10.1 Heat Risk Score pipeline
```
1. Fetch route geometry (list of road segments)
2. For each segment (~30–50m):
   a. Look up base surface temperature (surface_zones + LST fusion)
   b. Apply shade multiplier from AI Shadow Engine (0 = full shade, 1 = full sun)
   c. Apply time-of-day / sun-angle adjustment
   d. Combine with humidity via heat-index formula (NOAA heat index model)
   → segment_effective_heat_index
3. Aggregate segment scores weighted by traversal time (not just distance —
   slower segments = longer exposure)
4. Apply persona weighting model (below) → Heat Risk Score (0–100)
5. Generate explanation: top 3 contributing factors in plain language
   (rule-based template + optional LLM polish pass)
```

### 10.2 Persona weighting model (illustrative)
| Factor | Student | Worker | Senior | Cyclist |
|---|---|---|---|---|
| Cumulative exposure duration | High | Very High | High | Medium |
| Peak instantaneous heat index | Medium | High | Very High | Medium |
| Shade availability | Medium | High | High | Low |
| Exertion/pace multiplier | Low | High | Low | Medium |
| Rest/water point proximity | Low | High | Very High | Low |
| Road surface radiant heat | Low | Medium | Low | High |

Each cell is a numeric weight (0–1) applied to the corresponding raw factor before summing into the final 0–100 score — fully transparent and tunable, shown to judges as a config table, not hidden logic.

### 10.3 Future Heat Prediction model
For the 48-hour MVP: a deterministic + lightly-learned hybrid — sun-angle progression (via `suncalc`/`pysolar`) recomputes the Shadow Engine output for t+30m/+1h/+2h, combined with short-horizon air-temperature interpolation from the weather API's hourly forecast. This is framed honestly as a **physics-informed nowcast**, with a clear "Phase 2: full ML model trained on historical LST + weather time series" roadmap note — this is a strong, credible answer to "is this really AI?" from judges.

### 10.4 AI Shadow Engine algorithm
```
For each building polygon:
  shadow_length = height / tan(solar_elevation_angle)
  shadow_direction = solar_azimuth + 180°
  → project shadow polygon from building footprint

For each tree canopy polygon:
  apply canopy_radius-based shade disc (denser canopy = higher shade_factor)

Union all shadow polygons + canopy discs → shade_mask for time t
Recompute shade_mask at t, t+30m, t+1h, t+2h for the prediction layer
```

### 10.5 Explanation generation
Two-tier approach for reliability under demo conditions:
1. **Rule-based template (primary, always works):** fills a structured sentence from the top 3 weighted factors — zero latency, zero failure risk during live demo.
2. **LLM polish pass (optional, if time allows):** sends the structured factor data to an LLM to rewrite as a warmer, more natural sentence. Falls back silently to the rule-based version if the call fails or is slow — never blocks the UI.

## 11. Database Schema (PostGIS)

```sql
-- Core geometry
CREATE TABLE roads (
  id            SERIAL PRIMARY KEY,
  osm_id        BIGINT,
  name          TEXT,
  geom          GEOMETRY(LineString, 4326),
  surface_type  TEXT,              -- asphalt, concrete, grass, gravel
  width_m       NUMERIC,
  walkable      BOOLEAN DEFAULT TRUE,
  bikeable      BOOLEAN DEFAULT TRUE
);

CREATE TABLE buildings (
  id        SERIAL PRIMARY KEY,
  osm_id    BIGINT,
  geom      GEOMETRY(Polygon, 4326),
  height_m  NUMERIC DEFAULT 10
);

CREATE TABLE tree_canopy (
  id            SERIAL PRIMARY KEY,
  geom          GEOMETRY(Polygon, 4326),
  canopy_density NUMERIC DEFAULT 0.7   -- 0-1, shade opacity
);

CREATE TABLE surface_zones (
  id             SERIAL PRIMARY KEY,
  geom           GEOMETRY(Polygon, 4326),
  surface_type   TEXT,              -- asphalt, grass, water, concrete, sand
  base_temp_offset_c NUMERIC         -- calibration offset vs. ambient air temp
);

-- Heat data
CREATE TABLE heat_readings (
  id            SERIAL PRIMARY KEY,
  geom          GEOMETRY(Point, 4326),
  recorded_at   TIMESTAMPTZ DEFAULT now(),
  surface_temp_c NUMERIC,
  air_temp_c    NUMERIC,
  humidity_pct  NUMERIC,
  heat_index_c  NUMERIC,
  source        TEXT                -- 'synthetic' | 'satellite' | 'weather_api'
);

CREATE TABLE shadow_snapshots (
  id            SERIAL PRIMARY KEY,
  geom          GEOMETRY(MultiPolygon, 4326),
  valid_at      TIMESTAMPTZ,
  horizon       TEXT                -- 'now' | '+30m' | '+1h' | '+2h'
);

-- Points of interest
CREATE TABLE pois (
  id        SERIAL PRIMARY KEY,
  geom      GEOMETRY(Point, 4326),
  type      TEXT,                   -- 'water' | 'rest' | 'shade' | 'cooling_center'
  name      TEXT
);

-- Users & personalization
CREATE TABLE users (
  id          SERIAL PRIMARY KEY,
  session_token TEXT UNIQUE,
  persona     TEXT,                 -- 'student' | 'worker' | 'senior' | 'cyclist'
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE routes (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id),
  origin          GEOMETRY(Point, 4326),
  destination     GEOMETRY(Point, 4326),
  geom            GEOMETRY(LineString, 4326),
  duration_min    NUMERIC,
  heat_risk_score NUMERIC,
  factors_json    JSONB,
  requested_at    TIMESTAMPTZ DEFAULT now()
);

-- Digital Heat Passport
CREATE TABLE passport_log (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER REFERENCES users(id),
  route_id          INTEGER REFERENCES routes(id),
  logged_at         TIMESTAMPTZ DEFAULT now(),
  minutes_exposed   NUMERIC,       -- above high-heat-index threshold
  pct_shaded        NUMERIC,
  rest_stops_taken  INTEGER DEFAULT 0
);

-- Spatial indexes
CREATE INDEX idx_roads_geom ON roads USING GIST (geom);
CREATE INDEX idx_buildings_geom ON buildings USING GIST (geom);
CREATE INDEX idx_canopy_geom ON tree_canopy USING GIST (geom);
CREATE INDEX idx_surface_geom ON surface_zones USING GIST (geom);
CREATE INDEX idx_heat_geom ON heat_readings USING GIST (geom);
CREATE INDEX idx_pois_geom ON pois USING GIST (geom);
```

## 12. API Design (FastAPI)

```
GET  /api/heat/twin?bbox={sw,ne}&time=now
     → GeoJSON FeatureCollection of the heat surface (color-graded polygons)

GET  /api/heat/predict?bbox={sw,ne}&horizon=30m|1h|2h
     → predicted heat surface for the requested horizon

GET  /api/shadow?bbox={sw,ne}&time=2026-09-18T14:30:00
     → GeoJSON of shade polygons at the given time

GET  /api/pois?bbox={sw,ne}&type=water,rest,shade
     → nearby water/rest/shade/cooling-center points

POST /api/routes/compare
     body: { origin, destination, persona, depart_at }
     → { routes: [ { id, geometry, duration_min, heat_risk_score,
                      factors: [...], explanation: "...",
                      pois_along_route: [...] }, ... ] }
     → returns ≥2 candidate routes (fastest + coolest, minimum) ranked

POST /api/routes/simulate
     body: { route_id, simulate: { time_offset_min, temp_delta_c } }
     → recomputed heat_risk_score + updated route/explanation
       (powers the judge-facing "Simulate" demo control)

GET  /api/risk/explain?route_id={id}
     → structured factor breakdown + natural-language explanation

GET  /api/passport/{user_id}
     → daily/weekly cumulative exposure summary

POST /api/passport/log
     body: { user_id, route_id, minutes_exposed, pct_shaded, rest_stops_taken }
     → confirms log entry

POST /api/users/persona
     body: { session_token, persona }
     → sets/updates persona for weighting model
```

All geospatial responses are GeoJSON so Leaflet/Mapbox GL can render them directly with zero client-side transformation.

## 13. Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend framework | Next.js (App Router) | SSR for fast first paint, PWA-installable |
| Styling | Tailwind CSS | mobile-first utility classes, custom heat-gradient theme tokens |
| Map rendering | Leaflet (fallback) / Mapbox GL JS (preferred if token available) | GeoJSON overlays, custom heat tile layer |
| State/data fetching | React Query (TanStack Query) + Zustand | cache map/route responses, minimize refetch |
| Backend framework | FastAPI (Python 3.11+) | async, auto-generated OpenAPI docs (great for judge Q&A) |
| Database | PostgreSQL + PostGIS extension | spatial queries, ST_Intersects/ST_Buffer for shade & routing |
| Routing engine | OSRM (self-hosted, walk/bike profile) or `networkx` graph over OSM extract | fast shortest-path + alternate-route generation |
| Geo data source | OpenStreetMap extract (Overpass API) for the chosen zone | roads, buildings, land use |
| Weather data | Open-Meteo API (free, no key required) | ambient temp/humidity/forecast |
| Solar geometry | `pysolar` or `suncalc-py` | sun angle/azimuth for Shadow Engine |
| AI/explanation | Rule-based templater + optional LLM API call | resilient fallback, judge-safe |
| Deployment | Vercel (frontend), Render/Railway/Fly.io (FastAPI + Postgres/PostGIS) | fast, free-tier friendly for hackathon |

## 14. Folder Structure

```
heatmind-ai/
├── frontend/
│   ├── app/
│   │   ├── page.tsx                     # Digital Twin map (home)
│   │   ├── onboarding/page.tsx          # persona select
│   │   ├── route/page.tsx               # route input + comparison
│   │   ├── route/[id]/page.tsx          # route detail + explanation
│   │   ├── passport/page.tsx            # Digital Heat Passport
│   │   ├── layout.tsx
│   │   └── globals.css
│   ├── components/
│   │   ├── map/
│   │   │   ├── HeatTwinLayer.tsx
│   │   │   ├── ShadeLayer.tsx
│   │   │   ├── RouteLine.tsx
│   │   │   └── PoiMarkers.tsx
│   │   ├── ui/
│   │   │   ├── RiskScoreBadge.tsx
│   │   │   ├── ExplanationCard.tsx
│   │   │   ├── TradeOffSlider.tsx
│   │   │   ├── TimelineScrubber.tsx
│   │   │   ├── SimulatePanel.tsx
│   │   │   └── PersonaSelector.tsx
│   │   └── passport/
│   │       ├── ExposureChart.tsx
│   │       └── StreakBadge.tsx
│   ├── lib/
│   │   ├── api.ts                       # typed fetch wrappers
│   │   ├── heatColorScale.ts
│   │   └── store.ts                     # Zustand store
│   ├── public/
│   ├── tailwind.config.ts
│   └── package.json
│
├── backend/
│   ├── app/
│   │   ├── main.py                      # FastAPI app entry
│   │   ├── routers/
│   │   │   ├── heat.py
│   │   │   ├── shadow.py
│   │   │   ├── routes.py
│   │   │   ├── risk.py
│   │   │   ├── pois.py
│   │   │   ├── passport.py
│   │   │   └── users.py
│   │   ├── services/
│   │   │   ├── heat_twin_service.py
│   │   │   ├── shadow_engine.py
│   │   │   ├── prediction_service.py
│   │   │   ├── risk_scoring.py
│   │   │   ├── explanation_service.py
│   │   │   └── routing_service.py
│   │   ├── models/                      # SQLAlchemy / GeoAlchemy2 models
│   │   ├── schemas/                     # Pydantic request/response models
│   │   ├── db/
│   │   │   ├── session.py
│   │   │   └── migrations/ (alembic)
│   │   └── config.py
│   ├── data/
│   │   ├── osm_extract.geojson
│   │   ├── tree_canopy.geojson
│   │   └── surface_zones.geojson
│   ├── scripts/
│   │   ├── seed_db.py
│   │   ├── ingest_osm.py
│   │   └── generate_synthetic_heat.py
│   └── requirements.txt
│
├── docs/
│   ├── HeatMind_AI_PRD.md               # this document
│   ├── architecture-diagram.png
│   └── demo-script.md
└── README.md
```

## 15. 48-Hour Roadmap

**Phase 0 — Setup (Hours 0–4)**
Repo scaffolding (Next.js + FastAPI + PostGIS via Docker Compose), select demo zone, pull OSM extract via Overpass API, set up Vercel + Render deployment pipelines, agree on color/design tokens.

**Phase 1 — Data foundation (Hours 4–12)**
Load roads/buildings/land-use into PostGIS, build/curate tree canopy GeoJSON (manual trace or open dataset) for the zone, define surface_zones with base temperature offsets, integrate Open-Meteo for live ambient weather, write `generate_synthetic_heat.py` to produce the calibrated synthetic heat surface.

**Phase 2 — Core engines (Hours 12–24)**
Build AI Shadow Engine (solar position + building/canopy shadow projection), build Heat Twin Service (`/api/heat/twin`), build routing service (OSRM or networkx over OSM graph) producing ≥2 alternate routes, implement Risk Scoring pipeline + persona weighting table.

**Phase 3 — Frontend map + routing UX (Hours 24–34)**
Digital Twin map screen with heat overlay + shade layer, Route Input + Comparison screens, Explanation card (rule-based), POI layer (water/rest/shade points, seeded manually for the zone), mobile-first responsive pass.

**Phase 4 — Prediction + Simulate + Passport (Hours 34–42)**
Future Heat Prediction (30m/1h/2h) via sun-angle progression + forecast interpolation, Timeline Scrubber UI, Simulate Panel (judge-facing "advance time / spike temp" control) wired to live re-scoring, Digital Heat Passport screen + `passport_log` write-through.

**Phase 5 — Polish, resilience, demo prep (Hours 42–48)**
Visual polish pass (motion, color-scale consistency, loading states), fallback paths for every AI/external-API call (never let a live demo hang), seed a rehearsed demo route pair with a strong before/after contrast, record backup demo video, rehearse the 4-minute pitch twice, write judge Q&A prep notes (esp. "is this really AI / what's synthetic vs. real").

## 16. Demo Script (4–5 minutes)

**0:00–0:30 — Hook**
"Every route planner tells you the fastest way somewhere. None of them tell you the safest way to get there when it's 42°C outside — because none of them know that this sidewalk is 11 degrees hotter than the one next to it." *(Open on Digital Twin map, zoom into campus, heat gradient visibly varies street-to-street.)*

**0:30–1:15 — The Digital Twin**
Show the live heat surface — point out a shaded park path (blue/teal) directly adjacent to an exposed parking-lot arterial (orange/red) at the same city-level temperature. "This is not one number for the whole city. This is street-by-street, powered by surface type, tree canopy, and building shadow — a real digital twin of urban heat."

**1:15–2:15 — Personalized routing**
Select persona ("Senior"), input a real origin/destination on campus. Show 2 routes side-by-side: fastest vs. HeatMind-recommended. Open the Explanation Card: "62% shaded, 2 water points, avoids the exposed plaza at peak sun angle." Show the Time-vs-Exposure trade-off slider — "3 minutes slower, 40% less heat exposure."

**2:15–3:00 — Future prediction**
Drag the Timeline Scrubber to +1h. Heat surface visibly repaints as shadows move; the previously-safe route now shows elevated risk on one segment. "Heat isn't static — shadows move, and HeatMind predicts that."

**3:00–3:40 — Live simulate (the "wow" moment)**
Open Simulate Panel, spike the temperature +5°C live. Route re-scores instantly, a reroute suggestion appears. "This is what happens during a real heat advisory — the system adapts in real time, not once a day."

**3:40–4:15 — Digital Heat Passport**
Switch to Passport screen: "And because heat exposure is cumulative, we track it the way fitness apps track steps — so a senior resident, a delivery worker, or a campus student can see their weekly heat exposure and shaded-distance trend."

**4:15–4:45 — Close**
"This isn't a route planner with a heat filter bolted on. It's a digital twin of urban heat, with prediction, explainability, and personalization built in from the ground up — and it's built to scale from one campus to an entire city." *(End on architecture slide — 5 engines, one twin.)*

## 17. Judging-Criteria Alignment

| Typical judging criterion | HeatMind AI evidence |
|---|---|
| Innovation | Digital twin + prediction + shadow simulation, not a routing wrapper |
| Technical depth | PostGIS spatial queries, solar-geometry shadow engine, persona-weighted scoring model, real routing graph |
| Real-world impact | Directly protects vulnerable populations (seniors, outdoor workers) from heat illness; extensible to any city |
| Design/UX quality | Mobile-first, judge-tested "wow" interaction (live simulate), transparent explainability |
| Completeness of MVP brief | Explicitly satisfies every bullet in the original challenge (≥2 routes, transparent score, shade/rest/water points, time-vs-exposure trade-off, live reroute on simulated change) |
| Scalability/business viability | Section 19 — city partnerships, public health, insurance, urban planning data licensing |

## 18. Unique Differentiators

1. **Digital twin, not a filter.** Competing "heat-aware routing" ideas add a heat layer to existing routing logic. HeatMind AI treats heat as first-class city infrastructure data, with routing as one of five consumers.
2. **Prediction, not just measurement.** The 30m/1h/2h Future Heat layer means the product answers "when should I leave," not just "where should I walk" — genuinely novel among route-planning submissions.
3. **Physically-grounded shadow simulation.** Shade isn't a static polygon layer — it's computed from real solar geometry + building height + canopy density, so it changes correctly through the day.
4. **True personalization, not a toggle.** Four distinct, transparently-weighted risk models (not a single score with a cosmetic label swap).
5. **Explainability by default.** Every score ships with a "why," addressing the single most common judge pushback on AI products ("how do I know I can trust this number").
6. **The Passport — a retention mechanic no competitor has.** Turns a one-time trip planner into a recurring personal health tool, which is also the strongest long-term business/data story (Section 19).
7. **Honest about data provenance.** The MVP transparently separates real geometry (OSM) from synthetic-but-calibrated heat data, and shows the Phase 2 path to full satellite LST + trained ML prediction — this reads as rigor, not a gap.

## 19. Beyond the Hackathon (Roadmap / Business Viability)

- **Phase 2 (0–3 months):** Real satellite LST ingestion (Landsat 8/9, Sentinel-3), trained ML prediction model on historical heat + weather time series, expand to full city coverage.
- **Phase 3 (3–9 months):** City partnership pilots — integrate with municipal heat-advisory systems, public health departments, and transit apps; API licensing to delivery/gig platforms (Worker persona) for shift-planning heat-safety compliance.
- **Data flywheel:** Digital Heat Passport data (aggregated, anonymized) becomes a unique dataset on real pedestrian-level heat exposure patterns — valuable to urban planners (where to plant trees / build shade structures) and public health researchers.
- **Monetization paths:** B2G city licensing (heat digital twin as public infrastructure), B2B API for logistics/delivery/construction workforce safety, freemium consumer app with Passport analytics.

## 20. Success Metrics for the MVP Demo

- Renders a visibly non-uniform heat surface across the selected zone (not a flat color) — proves "no single city-level number" requirement
- Produces ≥2 distinct routes with different Heat Risk Scores for the same origin/destination
- Explanation card correctly cites real contributing factors (shade %, surface type, POI proximity)
- Timeline scrubber visibly changes the heat surface and at least one route's score
- Simulate Panel triggers a visible reroute/re-score within ~1 second (no perceptible hang)
- Full flow (onboarding → route → detail → passport) completable in under 90 seconds without dead ends

## 21. Open Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Real satellite LST data too slow/complex to integrate in 48h | Use calibrated synthetic heat model (Section 9); disclose transparently in demo |
| Routing engine (OSRM) setup friction | Fallback to `networkx` shortest-path + manual alternate-route generation over OSM graph |
| LLM explanation call fails/slow during live demo | Rule-based explanation template is the default path; LLM is a non-blocking enhancement only |
| Map tile/token limits (Mapbox) | Leaflet + OpenStreetMap tiles as a zero-dependency fallback |
| Live demo network failure | Pre-recorded backup video + locally cached demo dataset (no live API dependency required for the core flow) |
| Scope creep across 5 pillars in 48h | Build order in Section 15 sequences core engines before polish; Passport and Prediction are last and can ship in reduced form if time is short, without breaking the core routing/explainability demo |

---

*End of PRD. This document is structured to double as both the build spec for the 48-hour sprint and the leave-behind reference for judges after the pitch.*
