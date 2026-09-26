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

> **Linux without root/nvm:** if your distro's `node` is older than 20.9 and you can't install a version manager or `sudo apt install` a newer one, download a standalone build instead — no root needed:
> ```bash
> curl -fsSL -o node.tar.xz https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz
> tar xf node.tar.xz && mv node-v20.18.1-linux-x64 .tools/node20 && rm node.tar.xz
> export PATH="$(pwd)/.tools/node20/bin:$PATH"   # put this first so npm's spawned `next` binary picks it up too
> ```
> Similarly, if `python -m venv` fails with `ensurepip is not available` and you can't `apt install python3-venv` (needs sudo), create the venv without pip and bootstrap it manually:
> ```bash
> python3 -m venv .venv --without-pip
> curl -fsSL https://bootstrap.pypa.io/get-pip.py -o get-pip.py
> .venv/bin/python get-pip.py && rm get-pip.py
> ```

`npm run dev` also auto-generates `frontend/AGENTS.md` and `frontend/CLAUDE.md` on every start (a Next.js 16 feature). They're gitignored like `next-env.d.ts` — don't commit them, they're regenerated locally each run.

---

## What's inside (the 5 engines)

| Pillar | Where | How |
|---|---|---|
| **Urban Heat Digital Twin** | `backend/app/services/heat_twin_service.py` | 10 m raster of pedestrian feels-like heat. NOAA heat index of ambient air, plus direct solar load × sun exposure, ground long-wave from surface material (asphalt / concrete / dry ground / grass / water), traffic heat and urban-canyon retention, minus canopy evapotranspiration and lake cooling. Canyon retention uses the **sky view factor** (Oke canyon geometry, as in SOLWEIG/UMEP) rather than a built-density proxy, so trapping concentrates in genuinely enclosed streets. Set `HEATMIND_SVF_CANYON=0` to fall back to the density model. |
| **AI Shadow Engine** | `services/shadow_engine.py`, `services/solar.py` | NOAA solar ephemeris gives sun elevation and azimuth. Every cell ray-marches toward the sun through the building-height and tree-canopy fields. Building shadow polygons are cast at `h / tan(elev)` toward `azimuth + 180°`. |
| **Sky View Factor** | `services/svf.py` | 32-azimuth horizon scan of the building-height raster, `SVF = 1 - mean(sin²θ_max)`. Independent of sun and weather, so it is computed once and disk-cached (~0.6 s). One field, two consumers: the canyon physics term above, and the ambient occlusion in the 3D renderer. |
| **Future Heat Prediction** | `services/prediction_service.py` | Physics-informed nowcast from now to +3 h (15-minute keyframes): shadows are recomputed for the future sun position, and air temperature and RH are interpolated from the Open-Meteo hourly forecast (or the demo scenario curve). |
| **Personalized Heat Risk Engine** | `services/risk_scoring.py` | Six transparent factors (cumulative exposure, peak heat index, shade, exertion, rest/water gaps, surface radiant heat), each weighted per persona (Student / Outdoor Worker / Senior / Delivery Rider) into a 0–100 score. Personas differ in vulnerability shift, weights and daily budget; the **travel mode** supplies speed, sun exposure and exertion on top (`services/modes.py`), and all three default to the pedestrian values so a walking route scores exactly as it did before modes existed. |
| **Digital Heat Passport** | `services/passport_service.py` | Minutes in NOAA "danger" heat vs. a daily budget, shaded distance, rest stops, streaks and badges, stored in SQLite under an anonymous session token. |

Plus:

- **Heat-aware routing** (`services/routing_service.py`): Dijkstra over the real OSM street graph. A sweep of heat-aversion weights combined with the penalty method yields ≥2 distinct routes from fastest to coolest. Pedestrians are sampled on the shady kerb, vehicles on the carriageway. Routing is **time-aware**: each street is costed by the sun that will be on it when the traveller arrives, not the sun at departure — over a 100-minute walk the azimuth swings ~25°, and freezing it routes people into shade that has moved. At 13:00 in late September the shade-first walk across this zone carries **46% shade against the fastest route's 23%**, for 15 extra minutes and 10 fewer risk points.
- **Travel modes** (`services/modes.py`): walk / cycle / bike / car / bus, composed with persona rather than baked into it — a senior on a bike is a senior's vulnerability at a bike's speed. Each mode sets its pace (scaled by the congestion curve, which puts a car below a two-wheeler in the evening peak, as Pune does), the streets it may use (cars and two-wheelers off footways and steps; buses also off service lanes), and `heat_exposure` — how much of the weather actually reaches the traveller. That last one is what keeps a car from detouring a kilometre for a tree it is sealed away from.
- **Bus itineraries** (`services/transit.py`, `services/transit_routing.py`): walk → wait → ride → walk over **98 real OSM bus stops** (31 tagged PMPML, 20 with shelters). Stop choice trades walking distance against shelter, because the wait is the most exposed part of the trip. No PMPML timetable is published for this corridor, so the headway and ride time are **modelled** and say so everywhere they appear.
- **Turn-by-turn navigation** (`services/navigation.py`): maneuvers derived from the route's own display segments, so each step carries the sun exposure of the stretch it describes — the HUD warns that the next street is in full sun before you are standing in it.
- **Explainability** (`services/explanation_service.py`): every score ships with a rule-based "why" (shade %, peak °C along a named street, water points, trade-off vs. the fastest route), with an optional LLM polish that falls back silently.
- **Simulate** (`POST /api/routes/simulate`): advance the clock or spike the temperature. Every route is re-scored in under 1 s, and you get a reroute suggestion if your route is no longer the safest.

## The 3D Heat Twin renderer

Heat Twin mode is a Three.js scene rendered *inside MapLibre's own WebGL context* as a
custom layer (`components/map/three/`), sharing its camera and depth buffer — not an
overlay floating above the map.

| Piece | What it does |
|---|---|
| `origin.ts` | Renders in the backend's own local metric frame (metres from the zone's SW corner, `services/geo.py`), composing MapLibre's matrix on top. Keeps vertices in a range where float32 is precise instead of pushing Mercator's ~1e-8 units through the GPU. |
| `sunExposure.ts` | Re-marches `shadow_engine.sun_exposure()` on the GPU every time the sun moves, at 6× the physics grid (1302×1098) in **~0.3 ms**. Adds a distance-scaled penumbra. This buffer lights the scene *and* tints the ground, so the shade you see is derived from the same height raster the temperatures came from. |
| `groundHeat.ts` | The heat surface, with the colour ramp applied per fragment from a LUT texture, plus isotherm contours, sky-view ambient occlusion and live shadow tint. |
| `buildings.ts` | All 998 footprints merged into one draw call (~16.5k triangles). Windows, mullions, spandrels, entrances and parapets are generated in the fragment shader from wall UVs and a stable per-building seed — no facade geometry. |
| `roads.ts` | The 473 real OSM ways as ground ribbons at their true widths, with kerbs and dashed centre lines on classified roads. Drawn *below* the heat plane so the carriageway reads through it and gets tinted by the temperature above. |
| `reveal.ts` | Progressive reveal: a coverage field painted by each position fix. Ground already walked stays visible, so the twin builds up along the route taken. Every shader multiplies by it, so heat, roads, buildings and canopy appear together. |
| `trees.ts` | 2,452 canopies + trunks as two InstancedMeshes, sized from the zone's own `radius_m` / `density`. Canopy planted by the intervention simulator is appended live and casts real shadow on the next march. |
| `sunDisc.ts` | The sun itself, on a dome around the view centre at its true azimuth and elevation, billboarded in clip space so its pixel size is exact whatever the projection does with pitch. Shadows have always been cast from the NOAA position; nothing on screen said where the light was coming from, so they swung across the streets as the timeline scrubbed for no visible reason. |
| `overlayLayer.ts` | A second custom layer, added *after* the route lines, that renders the twin's annotation scene through the same renderer and camera. The twin sits below `labels` so route lines and symbols stay legible over the buildings — which also meant the route line painted over the temperature plaques describing it. Depth state cannot arbitrate between two MapLibre layers in a painter's algorithm; a later paint slot can. |
| `lib/solar.ts` | Port of the backend NOAA solar algorithm, so sun position is continuous while scrubbing instead of snapping between 15-minute keyframes. |

Two things this replaced, both worth knowing about:

- **Keyframe blending was mixing colours, not temperatures.** Thirteen PNG data-URL image
  sources were cross-faded by opacity, so a moment halfway between "now" (teal) and "+1h"
  (orange) rendered as an olive that matches no temperature on the scale. The two keyframes
  are now mixed in encoded temperature space and the ramp applied afterwards.
- **Building shadow polygons were geometrically wrong.** They were cast as the convex hull of
  the footprint and its translated copy; the true shadow is a Minkowski sum, so any
  non-convex (L- or U-shaped) building over-covered its own notch. The map layer is gone.
  `GET /api/shadow` still serves the polygons — it is public API and listed in the open-data
  catalog — but the twin no longer draws them.

## Anthropogenic heat — traffic and industry

Waste heat people put into the street, separate from anything the sun does
(`services/anthropogenic.py`).

- **Traffic.** The per-road-class weight was a constant — a trunk road contributed the
  same 2.2 °C at 04:00 as in the evening jam. It is now the *jam-hour* value, scaled by a
  diurnal congestion profile with the usual twin Indian commute peaks. Zone-mean
  anthropogenic heat runs 0.05 °C at 04:00 and 0.45 °C at 19:00, peaking at **4.5 °C** on
  the bypass in the evening jam.
- **Industry.** Waste heat over inferred-industrial footprints with a working-hours duty
  cycle, decaying over ~80 m.

**Both are modelled, and the README says so because the data does not exist.** There is
no free real-time traffic feed for this zone, and the Overpass extract contains *no*
industrial tags at all — the only land-use tags present are `residential` (×17) and
`education` (×2). `set_congestion_source()` is the seam where a paid traffic API (TomTom,
HERE, Google Roads) would attach without touching anything else. Both layers appear in
`/api/meta` provenance as `modelled`, and `GET /api/anthropogenic` returns the profiles
and caveats in full.

## Start from where you are

`components/hud/MyLocation.tsx` sets your position as the trip origin and reveals the twin
only along the ground you have covered.

The twin models ~4 km², so standing outside it is a real outcome rather than an error:
`lib/geolocation.ts` carries an explicit `outside` state that says so and offers the
campus instead. A simulated 1.4 m/s walker is included for demoing away from Narhe — it is
labelled `simulated` in the search bar, in the popover and by a different marker colour, so
it can never be mistaken for a real fix.

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
GET  /api/zone/fields                  height / canopy / sky-view-factor / surface rasters for GPU upload
GET  /api/anthropogenic?time           traffic-congestion + industrial waste heat (modelled; see provenance)
GET  /api/heat/twin?scenario&time&offset_min&temp_delta&format=grid|geojson
GET  /api/heat/predict?horizon=30m|1h|2h|3h
GET  /api/heat/layers?time              cooling corridors, hot streets, hotspots (Heat Twin mode)
GET  /api/heat/point?lat&lon           probe one location
GET  /api/shadow?time                  building shadow polygons
GET  /api/pois?type=water,rest,shade,cooling_center
GET  /api/transit/stops                real OSM bus stops (name, operator, shelter) as GeoJSON
GET  /api/transit/describe             what the transit layer measures vs. assumes
POST /api/routes/compare               { origin, destination, persona, mode, scenario, depart_at }
                                       mode: walk | cycle | bike | car | bus
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
| Bus stops | **Real** (OSM public-transport tags; PMPML operator where recorded) |
| Bus timetable | **Modelled** — none published for this corridor; headway and ride time are assumed, not scheduled |
| Sun position | **Real** (NOAA algorithm) |
| Weather | Open-Meteo at the live current time · Pune climatology fallback (offline) |
| Heat surface | **Modelled** (physics-informed synthetic, PRD §9) |

To rebuild the zone from a fresh OSM extract: replace `backend/data/osm_raw.json`, delete `backend/data/zone.json`, then run `python scripts/ingest_osm.py` from `backend/`.

## Traffic, route checks and place photos

Copy `backend/.env.example` to `backend/.env`, then set `HEATMIND_TOMTOM_KEY`
and optionally `HEATMIND_MAPILLARY_TOKEN`. Restart the backend after editing.
Never commit `.env` or put these server credentials in frontend variables.

Route allocation reuses the existing street search, with localized TomTom speed
samples for vehicle travel times and the existing twin's temperature, shade and
industrial waste heat. The transparent preference index weighs heat 55%, traffic
15%, shade 15%, industrial heat 10%, and mapped rest/water access 5%. It remains
separate from the persona heat-risk score. Candidates stay within the existing
detour limit; a detour needs at least a two-point index improvement.

Traffic is sampled on demand at up to four points across candidate corridors,
cached for five minutes, and capped at 18,000 attempted requests per UTC month by
default (`HEATMIND_TRAFFIC_MONTHLY_LIMIT`, maximum 18,000). Run one backend worker
so the local counter stays authoritative. Other apps using the same provider key
can consume its allowance too. Missing keys, stale/low-confidence data, quota
errors, and future departures use the existing congestion model. Live coverage
is shown per route; road matching is approximate and not direction-specific.
Walking keeps its pedestrian pace but prefers less-congested sampled corridors;
vehicle timing also changes with observed speed. The classifier's traffic factor
uses observed congestion on sampled roads and an estimated road-heat proxy on
other roads, with an additional delay contribution for vehicles.
Industrial heat is estimated from mapped/inferred premises, already part of
feels-like; no industrial radiation or air-pollutant sensors are connected.

Benches, toilets, water dispensers and rest facilities open an anchored popup with
OSM access, hours, fees and accessibility tags where recorded. Linked Wikimedia
Commons/Wikidata photos include credits; Mapillary fallback is labelled nearby
street imagery with distance and capture date. Missing coverage never substitutes
a stock photo. Estimated points and shops are not public refill guarantees.
Gemini trip tips are opt-in, use one bounded request, and never change the route.

Validation: `python -m unittest discover -s tests -v` from `backend/`; `npm run build`
and targeted ESLint from `frontend/`.

## City Lab demonstrations

Open **City Lab** in the website navigation (`/city-lab`). Cooling investment
offers three mapped neighbourhoods, a separate 1:30 PM heatwave demo or current
conditions, editable INR cost assumptions, manual project selection and a greedy
budget proposal. Tree canopy, pavement and shade use the existing intervention
simulator at separated sites. Before/after temperatures are weighted averages
over evaluated patches, not a citywide reduction or a population-impact estimate.
Water refills are proposed access points only, with no temperature benefit assumed.
Trees assume mature canopy; costs are demonstrations, not deployment quotations.
Exported proposals include these assumptions. Nothing modifies routes or the twin.

Sensor validation shows paired observations, a scatter plot, MAE, RMSE, signed
bias and share within a chosen tolerance. The synthetic demo is explicitly
labelled and cannot establish accuracy. Real comparisons accept a CSV with
`lat,lon,time,metric,observed_c` and optional `predicted_c,label`; timestamps need a
timezone, coordinates must be in the zone and each file must use one metric
(`surface_c`, `air_c` or `feels_c`). Up to 60 readings / 60 KB are accepted.
Download the live prediction template to save model references, then fill observed
values from comparable measurements at those locations and times. Without saved
predictions, only the last 24 hours with matching weather can be reconstructed;
this is not an archived forecast. Uploaded references are user-supplied, not
independently verified. Data is compared in memory and never recalibrates the
model. Exported synthetic results retain their demo label if imported again.

## Stack

Next.js 16 (App Router) · Tailwind CSS v4 · MapLibre GL 6 · Zustand · lucide-react · Geist — FastAPI · NumPy · httpx · SQLite.

The current build runs entirely on SQLite + in-memory rasters — that's what's actually wired up and what the demo uses. `backend/app/db/migrations/001_postgis.sql` is a draft schema for the Phase 2 city-scale migration (see Roadmap below); it is **not** applied or used by the app today.

## Roadmap

Phase 2: Landsat 8/9 and Sentinel-3 LST ingestion, plus a gradient-boosted residual model trained on historical LST and weather. City-wide coverage on PostGIS with tiled rasters. Phase 3: municipal heat-action-plan integration and a B2B API for delivery and construction workforce heat safety.
