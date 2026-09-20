"""SQLite persistence for users, saved routes and the Digital Heat Passport.

The PRD targets PostGIS; geometry here is stored as GeoJSON/WKT text so the same
schema ports 1:1 to PostgreSQL + PostGIS (see db/migrations/001_postgis.sql).
"""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager

from ..config import DB_FILE

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token TEXT UNIQUE NOT NULL,
  persona       TEXT NOT NULL DEFAULT 'student',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS routes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER REFERENCES users(id),
  route_key       TEXT,
  label           TEXT,
  origin          TEXT,          -- WKT POINT
  destination     TEXT,          -- WKT POINT
  geom            TEXT,          -- WKT LINESTRING
  duration_min    REAL,
  distance_m      REAL,
  heat_risk_score REAL,
  factors_json    TEXT,
  requested_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS passport_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER REFERENCES users(id),
  route_id         INTEGER REFERENCES routes(id),
  logged_at        TEXT NOT NULL,          -- local ISO timestamp (IST)
  trip_label       TEXT,
  minutes_total    REAL,
  minutes_exposed  REAL,                   -- minutes at/above the NOAA 'danger' heat index
  heat_dose        REAL,
  pct_shaded       REAL,
  distance_m       REAL,
  shaded_m         REAL,
  rest_stops_taken INTEGER DEFAULT 0,
  heat_risk_score  REAL,
  persona          TEXT,
  is_sample        INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_passport_user ON passport_log(user_id, logged_at);
"""

_lock = threading.Lock()
_initialised = False


def _connect() -> sqlite3.Connection:
    DB_FILE.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_FILE, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def init_db() -> None:
    global _initialised
    with _lock:
        if _initialised:
            return
        con = _connect()
        con.executescript(SCHEMA)
        con.commit()
        con.close()
        _initialised = True


@contextmanager
def db():
    init_db()
    con = _connect()
    try:
        with _lock:
            yield con
            con.commit()
    finally:
        con.close()
