-- HeatMind AI — PostGIS schema (PRD §11).
-- The hackathon build runs on SQLite + in-memory rasters (see app/db/session.py) so it has zero
-- infrastructure dependencies. This migration is the drop-in production schema.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE roads (
  id            SERIAL PRIMARY KEY,
  osm_id        BIGINT,
  name          TEXT,
  geom          GEOMETRY(LineString, 4326),
  surface_type  TEXT,
  width_m       NUMERIC,
  walkable      BOOLEAN DEFAULT TRUE,
  bikeable      BOOLEAN DEFAULT TRUE
);

CREATE TABLE buildings (
  id        SERIAL PRIMARY KEY,
  osm_id    BIGINT,
  geom      GEOMETRY(Polygon, 4326),
  height_m  NUMERIC DEFAULT 10,
  height_source TEXT DEFAULT 'estimated'   -- 'osm' | 'estimated'
);

CREATE TABLE tree_canopy (
  id             SERIAL PRIMARY KEY,
  geom           GEOMETRY(Polygon, 4326),
  canopy_density NUMERIC DEFAULT 0.7,
  source         TEXT DEFAULT 'estimated'
);

CREATE TABLE surface_zones (
  id                 SERIAL PRIMARY KEY,
  geom               GEOMETRY(Polygon, 4326),
  surface_type       TEXT,
  base_temp_offset_c NUMERIC
);

CREATE TABLE heat_readings (
  id             SERIAL PRIMARY KEY,
  geom           GEOMETRY(Point, 4326),
  recorded_at    TIMESTAMPTZ DEFAULT now(),
  surface_temp_c NUMERIC,
  air_temp_c     NUMERIC,
  humidity_pct   NUMERIC,
  heat_index_c   NUMERIC,
  source         TEXT
);

CREATE TABLE shadow_snapshots (
  id        SERIAL PRIMARY KEY,
  geom      GEOMETRY(MultiPolygon, 4326),
  valid_at  TIMESTAMPTZ,
  horizon   TEXT
);

CREATE TABLE pois (
  id      SERIAL PRIMARY KEY,
  geom    GEOMETRY(Point, 4326),
  type    TEXT,
  name    TEXT,
  source  TEXT DEFAULT 'osm'
);

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  session_token TEXT UNIQUE,
  persona       TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE routes (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id),
  route_key       TEXT,
  label           TEXT,
  origin          GEOMETRY(Point, 4326),
  destination     GEOMETRY(Point, 4326),
  geom            GEOMETRY(LineString, 4326),
  duration_min    NUMERIC,
  distance_m      NUMERIC,
  heat_risk_score NUMERIC,
  factors_json    JSONB,
  requested_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE passport_log (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id),
  route_id         INTEGER REFERENCES routes(id),
  logged_at        TIMESTAMPTZ DEFAULT now(),
  trip_label       TEXT,
  minutes_total    NUMERIC,
  minutes_exposed  NUMERIC,
  heat_dose        NUMERIC,
  pct_shaded       NUMERIC,
  distance_m       NUMERIC,
  shaded_m         NUMERIC,
  rest_stops_taken INTEGER DEFAULT 0,
  heat_risk_score  NUMERIC,
  persona          TEXT,
  is_sample        BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_roads_geom ON roads USING GIST (geom);
CREATE INDEX idx_buildings_geom ON buildings USING GIST (geom);
CREATE INDEX idx_canopy_geom ON tree_canopy USING GIST (geom);
CREATE INDEX idx_surface_geom ON surface_zones USING GIST (geom);
CREATE INDEX idx_heat_geom ON heat_readings USING GIST (geom);
CREATE INDEX idx_pois_geom ON pois USING GIST (geom);
CREATE INDEX idx_passport_user ON passport_log (user_id, logged_at);
