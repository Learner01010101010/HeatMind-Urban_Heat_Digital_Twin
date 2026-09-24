"""Crowdsourced hydration & rest points — SDG 6 (Clean Water & Sanitation).

Community-submitted water/rest/shade points start as 'pending' and only
appear on the map once approved, so the seeded/OSM POI layer (already
flagged for provenance elsewhere in this app) never gets silently diluted
with unverified submissions.
"""
from __future__ import annotations

from datetime import datetime

from ..config import TZ
from ..db.session import db

VALID_KINDS = {"water", "rest", "shade"}


def submit(session_token: str, lat: float, lon: float, kind: str, name: str, note: str | None = None) -> dict:
    if kind not in VALID_KINDS:
        raise ValueError(f"kind must be one of {sorted(VALID_KINDS)}")
    if not name or not name.strip():
        raise ValueError("name is required")
    now = datetime.now(TZ).isoformat()
    with db() as con:
        cur = con.execute(
            """INSERT INTO community_pois (session_token, lat, lon, kind, name, note, status, submitted_at)
               VALUES (?,?,?,?,?,?,'pending',?)""",
            (session_token, lat, lon, kind, name.strip()[:80], note, now))
        return {"id": cur.lastrowid, "status": "pending", "kind": kind, "name": name.strip()[:80],
                "lat": lat, "lon": lon}


def list_pois(status: str | None = "approved") -> list[dict]:
    with db() as con:
        if status:
            rows = con.execute("SELECT * FROM community_pois WHERE status = ? ORDER BY submitted_at DESC", (status,)).fetchall()
        else:
            rows = con.execute("SELECT * FROM community_pois ORDER BY submitted_at DESC").fetchall()
        return [dict(r) for r in rows]


def moderate(poi_id: int, action: str) -> dict:
    if action not in ("approve", "reject"):
        raise ValueError("action must be 'approve' or 'reject'")
    status = "approved" if action == "approve" else "rejected"
    with db() as con:
        cur = con.execute("UPDATE community_pois SET status = ? WHERE id = ?", (status, poi_id))
        if cur.rowcount == 0:
            raise KeyError(poi_id)
        return {"id": poi_id, "status": status}
