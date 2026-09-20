from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..services.explanation_service import polish
from ..services.risk_scoring import weights_table
from ..services.route_planner import get_planner

router = APIRouter(prefix="/api/risk", tags=["risk engine"])


@router.get("/explain")
async def explain(route_id: str, polish_llm: bool = False):
    """Structured factor breakdown + plain-language explanation. `polish_llm=true` adds an optional
    LLM rewrite (falls back to the rule-based text if unavailable or slow)."""
    found = get_planner().find_route(route_id)
    if not found:
        raise HTTPException(404, "route not found")
    st, r = found
    out = {"route_id": route_id, "heat_risk_score": r["heat_risk_score"], "band": r["band"],
           "factors": r["factors"], "metrics": r["metrics"], "explanation": r["explanation"]}
    if polish_llm:
        p = await polish(r, st["persona"])
        out["polished"] = p
    return out


@router.get("/weights")
def weights():
    """The persona weighting model, exposed as a transparent config table."""
    return weights_table()
