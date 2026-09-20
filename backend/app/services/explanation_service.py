"""Explainability layer — every score ships with a plain-language "why" (PRD §10.5).

Tier 1 (always on): deterministic rule-based templates from the factor breakdown.
Tier 2 (optional):  LLM polish pass via the Claude API when ANTHROPIC_API_KEY is set.
                    Strict timeout; silently falls back to tier 1 on any failure.
"""
from __future__ import annotations

import json

import httpx

from ..config import ANTHROPIC_API_KEY, LLM_MODEL, LLM_TIMEOUT_S
from .risk_scoring import PERSONAS

FACTOR_PHRASES = {
    "duration": "long cumulative time in dangerous heat",
    "peak": "very hot peak stretches",
    "shade": "little shade cover",
    "exertion": "high exertion for the heat",
    "rest": "long gaps between water/rest points",
    "surface": "radiant heat from sun-baked road surfaces",
}


def explain(route: dict, reference: dict | None, persona: str, when_iso: str, is_day: bool) -> dict:
    m = route["metrics"]
    P = PERSONAS[persona]
    bullets: list[dict] = []

    if is_day:
        txt = f"{m['pct_shaded']:.0f}% of this route is shaded at departure"
        if reference:
            d = m["pct_shaded"] - reference["metrics"]["pct_shaded"]
            if abs(d) >= 3:
                txt += f" — {abs(d):.0f} points {'more' if d > 0 else 'less'} than {reference['label']}"
        bullets.append({"icon": "shade", "text": txt + "."})
    else:
        bullets.append({"icon": "moon", "text": f"The sun is down at departure — no direct solar load; heat comes from air and stored surface heat."})

    top = max(route["segments"], key=lambda s: s["feels"][0]) if route["segments"] else None
    txt = f"Peak feels-like {m['peak_feels_c']:.0f}°C"
    if top and top.get("name"):
        txt += f" along {top['name']}"
    if reference:
        d = reference["metrics"]["peak_feels_c"] - m["peak_feels_c"]
        if abs(d) >= 0.8:
            txt += f" — {abs(d):.1f}°C {'cooler' if d > 0 else 'hotter'} than {reference['label']}"
            if d > 0 and m["pct_shaded"] > reference["metrics"]["pct_shaded"]:
                txt += " thanks to tree canopy and building shade"
    bullets.append({"icon": "thermo", "text": txt + "."})

    n_water = sum(1 for p in route["pois_along_route"] if p["type"] in ("water", "cooling_center"))
    n_rest = sum(1 for p in route["pois_along_route"] if p["type"] in ("rest", "shade"))
    bullets.append({"icon": "water", "text": (
        f"Passes {n_water} water/cooling point{'s' if n_water != 1 else ''} and {n_rest} rest/shade stop{'s' if n_rest != 1 else ''}; "
        f"longest stretch without one is {m['max_gap_min']:.0f} min.")})

    if m["pct_asphalt"] >= 25:
        bullets.append({"icon": "road", "text": f"{m['pct_asphalt']:.0f}% of the time is spent on asphalt radiating ~{m['surface_excess_c']:.0f}°C above air temperature."})

    if reference and route["id"] != reference["id"]:
        dt = m["duration_min"] - reference["metrics"]["duration_min"]
        dd = reference["metrics"]["heat_dose"]
        pct = (dd - m["heat_dose"]) / dd * 100 if dd > 0 else 0
        name = reference["label"]
        if dt >= 0.5 and pct > 0:
            bullets.append({"icon": "tradeoff", "text": f"{dt:.0f} min slower than {name}, but {pct:.0f}% less heat dose."})
        elif dt <= -0.5 and pct > 0:
            bullets.append({"icon": "tradeoff", "text": f"{abs(dt):.0f} min faster than {name} and {pct:.0f}% less heat dose."})
        elif abs(dt) < 0.5 and pct > 0:
            bullets.append({"icon": "tradeoff", "text": f"Same time as {name} with {pct:.0f}% less heat dose — a free win."})
        elif dt >= 0.5 and pct <= 0:
            ds = reference["heat_risk_score"] - route["heat_risk_score"]
            if ds >= 1.5:
                bullets.append({"icon": "tradeoff", "text": f"{dt:.0f} min slower than {name} with a similar heat dose, but {ds:.0f} points lower risk from shade and cooler peaks."})
            else:
                bullets.append({"icon": "tradeoff", "text": f"{dt:.0f} min slower than {name} with no heat benefit — not worth the detour."})
        elif dt <= -0.5:
            bullets.append({"icon": "tradeoff", "text": f"Saves {abs(dt):.0f} min vs {name}, at the cost of {abs(pct):.0f}% more heat dose."})

    ranked = sorted(route["factors"], key=lambda f: -f["contribution"])[:3]
    drivers = ", ".join(FACTOR_PHRASES[f["key"]] for f in ranked if f["contribution"] > 2) or "low overall heat load"
    who = P["label"].lower()
    art = "an" if who[0] in "aeiou" else "a"
    if "recommended" in route["tags"]:
        summary = (f"Recommended for {art} {who}: scores {route['heat_risk_score']:.0f}/100 ({route['band'].lower()} risk). "
                   f"Remaining risk comes mainly from {drivers}.")
    else:
        summary = (f"{route['label']} scores {route['heat_risk_score']:.0f}/100 ({route['band'].lower()} risk) for {art} {who}, "
                   f"driven by {drivers}.")
    return {"summary": summary, "bullets": bullets, "top_factors": [f["key"] for f in ranked], "source": "rule_based"}


async def polish(route: dict, persona: str) -> dict | None:
    """Optional LLM rewrite of the rule-based explanation. Returns None on any failure."""
    if not ANTHROPIC_API_KEY:
        return None
    payload = {
        "persona": PERSONAS[persona]["label"], "route": route["label"], "score": route["heat_risk_score"],
        "band": route["band"], "metrics": route["metrics"],
        "factors": [{k: f[k] for k in ("label", "contribution", "weight_level")} for f in route["factors"]],
        "facts": [b["text"] for b in route["explanation"]["bullets"]],
    }
    prompt = ("You explain pedestrian heat-risk route scores to the public. Using ONLY the facts in this JSON, "
              "write 2 short, warm, plain-language sentences (max 55 words) telling this person why this route is "
              "or isn't a good choice in the heat and one practical tip. No numbers that aren't in the JSON. "
              "No preamble.\n\n" + json.dumps(payload))
    try:
        async with httpx.AsyncClient(timeout=LLM_TIMEOUT_S) as client:
            r = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01",
                         "content-type": "application/json"},
                json={"model": LLM_MODEL, "max_tokens": 200, "messages": [{"role": "user", "content": prompt}]},
            )
            r.raise_for_status()
            text = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text").strip()
            return {"summary": text, "source": "llm", "model": LLM_MODEL} if text else None
    except Exception:
        return None
