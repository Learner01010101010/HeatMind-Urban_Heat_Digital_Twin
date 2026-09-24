"""Heat-illness clinical alerts — SDG 3 (Good Health & Well-being).

Thresholds are the same NOAA/CDC heat-index action bands already used by the
risk engine (risk_scoring.CAUTION_C / DANGER_C / EXTREME_C), combined with
the user's actual cumulative exposure against their persona's daily budget
(already tracked by the Heat Passport). This turns the existing colour-coded
risk score into an advisory with real symptom guidance, not just a number.
"""
from __future__ import annotations

from .risk_scoring import CAUTION_C, DANGER_C, EXTREME_C, PERSONAS

LEVELS = {
    "none": {
        "label": "No heat alert", "color": "#6fbf5e",
        "advice": "Conditions are within a normal range for outdoor activity.",
    },
    "caution": {
        "label": "Heat Caution", "color": "#facc15",
        "advice": ("Fatigue is possible with prolonged exposure or activity in the sun. Drink water regularly, "
                    "take shade breaks, and pace yourself."),
    },
    "warning": {
        "label": "Heat Warning", "color": "#fb8a1f",
        "advice": ("Heat cramps and heat exhaustion are likely with continued activity. Watch for heavy sweating, "
                    "weakness, dizziness, nausea, headache or muscle cramps — if any appear, move to shade, sip "
                    "water, and rest until they pass."),
    },
    "danger": {
        "label": "Heat Danger", "color": "#ef4444",
        "advice": ("Heat exhaustion is likely and heat stroke is possible. Limit outdoor activity, hydrate before "
                    "you feel thirsty, and take rest stops every 20–30 minutes in the shade."),
    },
    "emergency": {
        "label": "Heat Emergency", "color": "#dc2626",
        "advice": ("Heat stroke is a medical emergency. Warning signs: confusion, hot/dry or clammy skin, a rapid "
                    "strong pulse, or loss of consciousness. If you or someone nearby shows these signs, get to a "
                    "cool place immediately and seek medical help."),
    },
}


def clinical_alert(persona: str, feels_c: float, budget_used_pct: float) -> dict:
    P = PERSONAS.get(persona, PERSONAS["student"])
    f_p = feels_c + P["vulnerability_shift_c"]  # same persona-adjusted feels-like the risk engine already uses

    if f_p >= EXTREME_C or budget_used_pct >= 150:
        level = "emergency"
    elif f_p >= DANGER_C or budget_used_pct >= 100:
        level = "danger"
    elif f_p >= CAUTION_C + 4 or budget_used_pct >= 80:
        level = "warning"
    elif f_p >= CAUTION_C:
        level = "caution"
    else:
        level = "none"

    L = LEVELS[level]
    return {
        "level": level, "label": L["label"], "color": L["color"], "advice": L["advice"],
        "feels_c": round(feels_c, 1), "persona_adjusted_feels_c": round(f_p, 1),
        "budget_used_pct": round(budget_used_pct, 1),
        "thresholds_c": {"caution": CAUTION_C, "danger": DANGER_C, "extreme": EXTREME_C},
        "source": "NOAA/CDC heat-index action bands, applied with this app's existing persona vulnerability shift",
    }
