"""Grounded route copy from a local Qwen reasoning model; never selects a route."""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
import time
from collections import OrderedDict

import httpx

MODEL = os.getenv("HEATMIND_ADVICE_MODEL", "qwen3:4b")
OLLAMA_URL = os.getenv("HEATMIND_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
# Qwen3's extended thinking can exhaust the interactive deadline. Its compact
# mode generates grounded copy promptly; extended thinking is opt-in for hosts
# with sufficient throughput. This does not replace inference with templates.
EXTENDED_THINKING = os.getenv("HEATMIND_ADVICE_THINK", "0") == "1"
_cache: OrderedDict[str, tuple[float, dict]] = OrderedDict()
_gate = asyncio.Semaphore(1)
PUBLIC = {"drinking_water", "water_point", "water_dispenser", "bench", "toilets", "shelter"}


def clean(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value


def route_facts(result: dict) -> dict:
    facts = []
    routes = result["routes"]
    for route in result["routes"]:
        m, opt = route["metrics"], route.get("optimization") or {}
        peers = [r for r in routes if not r.get("transit") and r.get("mode", "walk") == route.get("mode", "walk")]
        fastest = min(peers, key=lambda r: r["duration_min"]) if peers else None
        chosen = next((r for r in peers if r["id"] == result["recommended_id"]), None)
        reference = fastest if route["id"] == result["recommended_id"] else chosen
        comparison = None
        if reference and not route.get("transit"):
            extra = round(route["duration_min"] - reference["duration_min"], 1)
            baseline = reference["metrics"].get("heat_dose", 0)
            heat_delta = round((m.get("heat_dose", 0) - baseline) / baseline * 100, 1) if baseline > 0 else None
            comparison = {
                "reference": "fastest" if route["id"] == result["recommended_id"] else "recommended",
                "time": "longer" if extra > .1 else "quicker" if extra < -.1 else "similar",
                "extra_minutes": extra,
                "heat": "more" if heat_delta is not None and heat_delta > 1 else "less" if heat_delta is not None and heat_delta < -1 else "similar",
                "heat_change_pct": heat_delta,
                "shade": "more" if m.get("pct_shaded_street", 0) > reference["metrics"].get("pct_shaded_street", 0) + 1 else "less" if m.get("pct_shaded_street", 0) < reference["metrics"].get("pct_shaded_street", 0) - 1 else "similar",
            }
        facilities = {p["id"]: p for p in route.get("pois_along_route", [])
                      if p.get("source") == "osm" and p.get("access") not in ("private", "no", "customers")
                      and p.get("detail") in PUBLIC and p.get("drinking_water") != "no"}
        traffic = opt.get("traffic") or {}
        facts.append({
            "id": route["id"], "recommended": route["id"] == result["recommended_id"],
            "mode": route.get("mode", "walk"),
            "comparison": comparison,
            "is_fastest": fastest is not None and fastest["id"] == route["id"],
            "is_shortest": bool(peers) and route["distance_m"] == min(r["distance_m"] for r in peers),
            "minutes": route["duration_min"], "metres": route["distance_m"],
            "heat_risk": route["heat_risk_score"], "modelled_heat_dose": m.get("heat_dose"),
            "street_shade_pct": m.get("pct_shaded_street"), "vehicle_shielding": m.get("shielded", False),
            "public_water_points": sum(p.get("detail") in ("drinking_water", "water_point", "water_dispenser") for p in facilities.values()),
            "public_rest_points": len(facilities),
            "traffic_live": traffic.get("live", False), "traffic_coverage_pct": traffic.get("coverage_pct", 0),
            "estimated_traffic_delay_min": traffic.get("delay_min"),
            "estimated_industry_heat_c": (opt.get("industrial") or {}).get("mean_c"),
            "bus": {"walk_m": route["transit"]["walk_m"], "estimated_wait_min": route["transit"]["wait_min"]} if route.get("transit") else None,
        })
    return clean({"routes": facts})


def validate_response(raw: str, ids: set[str]) -> dict:
    # Some Ollama releases append prose after the JSON envelope. Decode only the
    # first complete object, then strictly validate it; never return trailing text.
    start = raw.find("{")
    if start < 0:
        raise ValueError("Missing recommendation data")
    parsed, _ = json.JSONDecoder().raw_decode(raw[start:])
    if not isinstance(parsed, dict):
        raise ValueError("Invalid recommendation envelope")
    rows = parsed.get("routes")
    if not isinstance(rows, dict) or set(rows) != ids:
        raise ValueError("Incomplete recommendations")
    found = {}
    for rid, row in rows.items():
        if not isinstance(row, dict):
            raise ValueError("Invalid recommendation row")
        summary, tips = row.get("summary"), row.get("tips")
        if rid not in ids or rid in found or not isinstance(summary, str) or not 8 <= len(summary.strip()) <= 200:
            raise ValueError("Invalid recommendation")
        if not isinstance(tips, list) or len(tips) != 2 or any(not isinstance(t, str) or not 8 <= len(t.strip()) <= 160 for t in tips):
            raise ValueError("Invalid journey tips")
        # Measurements are rendered from authoritative data, never generated text.
        if any(any(c.isdigit() or ord(c) < 32 for c in t) or "<" in t or ">" in t for t in [summary, *tips]):
            raise ValueError("Unexpected measurements or markup")
        found[rid] = {"summary": summary.strip(), "tips": [t.strip() for t in tips]}
    return {"routes": found}


def validate_grounding(data: dict, facts: dict) -> None:
    for route in facts["routes"]:
        c = route.get("comparison") or {}
        summary = data["routes"][route["id"]]["summary"].lower()
        if c.get("heat") == "more" and re.search(r"less (?:total |accumulated )?heat|lower heat|cooler|without (?:adding |extra )?heat", summary):
            raise ValueError("A route with more accumulated heat was described as cooler.")
        if c.get("heat") == "less" and re.search(r"more (?:total |accumulated )?heat|higher heat", summary):
            raise ValueError("A route with less accumulated heat was described as hotter.")
        if c.get("time") == "longer" and re.search(r"quicker|sooner|gets? there faster", summary):
            raise ValueError("A longer journey was described as quicker.")
        if c.get("shade") == "less" and re.search(r"more shade|shadier", summary):
            raise ValueError("A route with less shade was described as shadier.")
        if c.get("shade") == "more" and re.search(r"less shade|less shaded", summary):
            raise ValueError("A route with more shade was described as having less shade.")
        if c.get("reference") == "fastest" and "than recommended" in summary:
            raise ValueError("The recommended route was compared to itself.")


async def generate_advice(result: dict) -> dict:
    facts = route_facts(result)
    payload = json.dumps(facts, sort_keys=True, allow_nan=False)
    key = hashlib.sha256((MODEL + payload).encode()).hexdigest()
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < 300:
        return hit[1]
    try:
        await asyncio.wait_for(_gate.acquire(), timeout=3)
    except TimeoutError as exc:
        raise ValueError("Recommendations are busy. Please try again.") from exc
    try:
        hit = _cache.get(key)
        if hit and time.monotonic() - hit[0] < 300:
            return hit[1]
        ids = [r["id"] for r in facts["routes"]]
        row_schema = {
            "type": "object", "properties": {
            "summary": {"type": "string", "pattern": "^[^0-9<>]*$"},
            "tips": {"type": "array", "items": {"type": "string", "pattern": "^[^0-9<>]*$"}, "minItems": 2, "maxItems": 2}},
            "required": ["summary", "tips"], "additionalProperties": False}
        schema = {"type": "object", "properties": {"routes": {"type": "object",
            "properties": {rid: row_schema for rid in ids}, "required": ids, "additionalProperties": False}},
            "required": ["routes"], "additionalProperties": False}
        # Absolute risk is a different metric from accumulated heat. Give the
        # writer explicit relationships so it cannot confuse the two quantities.
        writing_facts = {"routes": [{
            "id": r["id"], "recommended": r["recommended"], "mode": r["mode"],
            "is_fastest": r["is_fastest"], "is_shortest": r["is_shortest"],
            "comparison": {k: v for k, v in (r["comparison"] or {}).items() if k in ("reference", "time", "heat", "shade")},
            "heat_attention": r["heat_risk"] is not None and r["heat_risk"] >= 60,
            "public_water_points": r["public_water_points"], "public_rest_points": r["public_rest_points"],
            "vehicle_shielding": r["vehicle_shielding"], "traffic_live": r["traffic_live"], "bus": bool(r["bus"]),
        } for r in facts["routes"]]}
        system = (
            "Write friendly route recommendations based ONLY on the supplied measurements. "
            "The planner already chose the recommended route. Explain that choice and each alternative; never rerank. "
            "Compare routes of the same mode; bus walking and waiting are separate. "
            "Each summary is ONE plain sentence, maximum 24 words. Give TWO brief practical journey tips. "
            "Do not use digits or repeat measurements; the app shows exact numbers separately. "
            "Do not mention algorithms, models, scores, rules, training, APIs, AI, or reasoning. "
            "Do not name reference routes or use the words balanced, recommended or fastest in the summary. "
            "The visual tiles already name the reference. Just explain the trade-off in everyday language. "
            "If the chosen route is also is_fastest, explain the benefit of arriving sooner; do not compare it with itself. "
            "Heat and industry are estimates, not pollution measurements. Vehicle shielding is not street shade. "
            "Never promise safety, clean water, working facilities, or live traffic when traffic_live is false. "
            "Mapped facilities need access confirmation. Never invent places, weather, shade, delays, or advantages. "
            "If no public water point is mapped, one tip should suggest carrying your own water. "
            "When heat_attention is true, advise shade, water and checking a cooler departure time. "
            "Use everyday language: quicker, shorter walk, more shade, less heat, rest stops. "
            "Use the explicit comparison.time, comparison.heat and comparison.shade facts. "
            "If time is longer NEVER say faster, quicker, sooner or shortest. "
            "If heat is more NEVER say cooler, less heat or no extra heat. "
            "Do not describe a higher shade percentage as lower total heat exposure. "
            "Never say a route has rest or water points if its public point count is zero. "
            "For the chosen route explain its trade-off, not that it wins every metric. "
            "Suggest checking a cooler departure time, rather than claiming earlier will be cooler. "
            "Return JSON: routes is an object keyed by every supplied route id; each value has summary and exactly two tips."
        )
        deadline = time.monotonic() + 75
        async with httpx.AsyncClient(timeout=httpx.Timeout(75, connect=3), trust_env=False) as client:
            correction = ""
            for attempt in range(2):
                response = await client.post(OLLAMA_URL + "/api/chat", timeout=max(1, deadline - time.monotonic()), json={
                    "model": MODEL, "stream": False, "think": EXTENDED_THINKING, "format": schema, "keep_alive": "10m",
                    "messages": [{"role": "system", "content": system + correction},
                                 {"role": "user", "content": json.dumps(writing_facts)}],
                    "options": {"temperature": 0.1, "num_ctx": 4096, "num_predict": 1600 if EXTENDED_THINKING else 600},
                })
                response.raise_for_status()
                try:
                    data = validate_response(response.json()["message"]["content"], set(ids))
                    validate_grounding(data, facts)
                    break
                except ValueError as exc:
                    if attempt == 1:
                        raise
                    correction = " Correct this issue in your next answer: " + str(exc)
        _cache[key] = (time.monotonic(), data)
        _cache.move_to_end(key)
        while len(_cache) > 64:
            _cache.popitem(last=False)
        return data
    finally:
        _gate.release()
