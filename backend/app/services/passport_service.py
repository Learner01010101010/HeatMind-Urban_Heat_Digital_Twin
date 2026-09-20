"""Digital Heat Passport — cumulative personal heat exposure, streaks and badges."""
from __future__ import annotations

import json
import random
from datetime import datetime, timedelta

from ..config import TZ
from ..db.session import db
from .risk_scoring import PERSONAS


def get_or_create_user(session_token: str, persona: str | None = None, seed_sample: bool = False) -> dict:
    with db() as con:
        row = con.execute("SELECT * FROM users WHERE session_token = ?", (session_token,)).fetchone()
        if row is None:
            con.execute("INSERT INTO users (session_token, persona) VALUES (?, ?)", (session_token, persona or "student"))
            row = con.execute("SELECT * FROM users WHERE session_token = ?", (session_token,)).fetchone()
            created = True
        else:
            created = False
            if persona and persona != row["persona"]:
                con.execute("UPDATE users SET persona = ? WHERE id = ?", (persona, row["id"]))
                row = con.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
        user = dict(row)
    if seed_sample:
        with db() as con:
            n = con.execute("SELECT COUNT(*) FROM passport_log WHERE user_id = ?", (user["id"],)).fetchone()[0]
        if n == 0:
            _seed_sample_week(user["id"], user["persona"])
    user["created"] = created
    return user


def _seed_sample_week(user_id: int, persona: str) -> None:
    """A clearly-flagged sample week so the passport isn't empty on first open."""
    rng = random.Random(user_id)
    now = datetime.now(TZ)
    trips = ["TSSM → Zeal College", "Hostel → TSSM BSCOER", "TSSM → Swami Narayan Temple", "Narhe Gaon Rd → TSSM",
             "TSSM → Jambhulwadi Lake", "TSSM → Vision English School"]
    rows = []
    for d in range(6, 0, -1):
        day = now - timedelta(days=d)
        for _ in range(rng.randint(2, 4)):
            hour = rng.choice([8, 9, 11, 13, 14, 15, 17, 18])
            hot = hour in (11, 13, 14, 15)
            total = rng.uniform(6, 22)
            shaded = rng.uniform(0.3, 0.75)
            exposed = total * (rng.uniform(0.5, 0.95) if hot else rng.uniform(0, 0.25))
            dist = total * 60 * PERSONAS[persona]["speed_ms"]
            rows.append((user_id, day.replace(hour=hour, minute=rng.randint(0, 59)).isoformat(), rng.choice(trips),
                         round(total, 1), round(exposed, 1), round(exposed * rng.uniform(9, 17), 1),
                         round(shaded * 100, 1), round(dist), round(dist * shaded), rng.randint(0, 2),
                         round(rng.uniform(55, 75) if hot else rng.uniform(15, 40), 1), persona))
    with db() as con:
        con.executemany(
            """INSERT INTO passport_log (user_id, logged_at, trip_label, minutes_total, minutes_exposed, heat_dose,
               pct_shaded, distance_m, shaded_m, rest_stops_taken, heat_risk_score, persona, is_sample)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)""", rows)


def log_trip(user_id: int, route: dict | None, fields: dict) -> dict:
    now = datetime.now(TZ)
    route_row_id = None
    with db() as con:
        if route:
            geom = "LINESTRING(" + ", ".join(f"{lo} {la}" for la, lo in route["geometry"]) + ")"
            o, d = route["geometry"][0], route["geometry"][-1]
            cur = con.execute(
                """INSERT INTO routes (user_id, route_key, label, origin, destination, geom, duration_min, distance_m,
                   heat_risk_score, factors_json) VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (user_id, route["id"], fields.get("trip_label") or route["label"], f"POINT({o[1]} {o[0]})",
                 f"POINT({d[1]} {d[0]})", geom, route["duration_min"], route["distance_m"], route["heat_risk_score"],
                 json.dumps(route["factors"])))
            route_row_id = cur.lastrowid
        m = route["metrics"] if route else {}
        dist = fields.get("distance_m", m.get("distance_m", 0))
        pct = fields.get("pct_shaded", m.get("pct_shaded", 0))
        cur = con.execute(
            """INSERT INTO passport_log (user_id, route_id, logged_at, trip_label, minutes_total, minutes_exposed,
               heat_dose, pct_shaded, distance_m, shaded_m, rest_stops_taken, heat_risk_score, persona)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (user_id, route_row_id, now.isoformat(), fields.get("trip_label") or (route["label"] if route else "Trip"),
             fields.get("minutes_total", m.get("duration_min", 0)), fields.get("minutes_exposed", m.get("minutes_danger", 0)),
             fields.get("heat_dose", m.get("heat_dose", 0)), pct, dist, dist * pct / 100,
             fields.get("rest_stops_taken", 0), fields.get("heat_risk_score", route["heat_risk_score"] if route else 0),
             fields.get("persona")))
        return {"ok": True, "log_id": cur.lastrowid, "route_id": route_row_id, "logged_at": now.isoformat()}


def clear_sample(user_id: int) -> int:
    with db() as con:
        return con.execute("DELETE FROM passport_log WHERE user_id = ? AND is_sample = 1", (user_id,)).rowcount


def summary(user_id: int) -> dict:
    with db() as con:
        user = con.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user:
            raise KeyError(user_id)
        rows = [dict(r) for r in con.execute(
            "SELECT * FROM passport_log WHERE user_id = ? ORDER BY logged_at DESC", (user_id,)).fetchall()]
    persona = user["persona"]
    budget = PERSONAS.get(persona, PERSONAS["student"])["daily_budget_min"]
    today = datetime.now(TZ).date()

    days = []
    for i in range(6, -1, -1):
        d = today - timedelta(days=i)
        dr = [r for r in rows if r["logged_at"][:10] == d.isoformat()]
        dist = sum(r["distance_m"] or 0 for r in dr)
        shaded = sum(r["shaded_m"] or 0 for r in dr)
        days.append({
            "date": d.isoformat(), "weekday": d.strftime("%a"), "trips": len(dr),
            "minutes_exposed": round(sum(r["minutes_exposed"] or 0 for r in dr), 1),
            "minutes_total": round(sum(r["minutes_total"] or 0 for r in dr), 1),
            "heat_dose": round(sum(r["heat_dose"] or 0 for r in dr), 1),
            "distance_m": round(dist), "pct_shaded": round(shaded / dist * 100, 1) if dist else None,
            "rest_stops": sum(r["rest_stops_taken"] or 0 for r in dr),
            "within_budget": sum(r["minutes_exposed"] or 0 for r in dr) <= budget,
        })

    # Streak: consecutive days (ending today or yesterday) with trips logged and exposure within budget
    streak = 0
    for dd in reversed(days):
        if dd["trips"] == 0 and dd["date"] == today.isoformat():
            continue
        if dd["trips"] > 0 and dd["within_budget"]:
            streak += 1
        else:
            break

    week = [r for r in rows if r["logged_at"][:10] >= (today - timedelta(days=6)).isoformat()]
    wdist = sum(r["distance_m"] or 0 for r in week)
    wshaded = sum(r["shaded_m"] or 0 for r in week)
    week_stats = {
        "trips": len(week),
        "minutes_exposed": round(sum(r["minutes_exposed"] or 0 for r in week), 1),
        "heat_dose": round(sum(r["heat_dose"] or 0 for r in week), 1),
        "distance_km": round(wdist / 1000, 2),
        "shaded_km": round(wshaded / 1000, 2),
        "pct_shaded": round(wshaded / wdist * 100, 1) if wdist else 0,
        "rest_stops": sum(r["rest_stops_taken"] or 0 for r in week),
        "avg_risk": round(sum(r["heat_risk_score"] or 0 for r in week) / len(week), 1) if week else 0,
    }
    early = sum(1 for r in week if int(r["logged_at"][11:13]) < 10 or int(r["logged_at"][11:13]) >= 17)
    badges = [
        {"id": "shade_seeker", "name": "Shade Seeker", "desc": "Walk 50%+ of your weekly distance in shade",
         "earned": week_stats["pct_shaded"] >= 50, "progress": min(1, week_stats["pct_shaded"] / 50)},
        {"id": "hydration_hero", "name": "Hydration Hero", "desc": "Take 5 water/rest stops this week",
         "earned": week_stats["rest_stops"] >= 5, "progress": min(1, week_stats["rest_stops"] / 5)},
        {"id": "cool_timer", "name": "Cool Timer", "desc": "Make 5 trips outside peak heat (before 10 AM / after 5 PM)",
         "earned": early >= 5, "progress": min(1, early / 5)},
        {"id": "streak_3", "name": "Heat-Smart Streak", "desc": "3 days in a row within your exposure budget",
         "earned": streak >= 3, "progress": min(1, streak / 3)},
        {"id": "first_trip", "name": "Twin Walker", "desc": "Log your first HeatMind-planned trip",
         "earned": any(not r["is_sample"] for r in rows), "progress": 1 if any(not r["is_sample"] for r in rows) else 0},
    ]
    today_row = days[-1]
    return {
        "user_id": user_id, "persona": persona, "persona_label": PERSONAS.get(persona, PERSONAS["student"])["label"],
        "daily_budget_min": budget,
        "today": {**today_row, "budget_used_pct": round(today_row["minutes_exposed"] / budget * 100, 1)},
        "days": days, "week": week_stats, "streak_days": streak, "badges": badges,
        "has_sample": any(r["is_sample"] for r in rows),
        "recent": [{k: r[k] for k in ("id", "logged_at", "trip_label", "minutes_total", "minutes_exposed", "pct_shaded",
                                      "distance_m", "heat_risk_score", "rest_stops_taken", "is_sample")} for r in rows[:12]],
    }
