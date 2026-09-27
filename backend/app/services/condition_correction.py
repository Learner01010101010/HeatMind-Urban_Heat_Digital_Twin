"""Optional area XGBoost forecast correction. Never selects or mutates routes.

The bootstrap models imitate this area's physics/congestion forecasts. They are
not calibrated against measured street outcomes; see docs/dynamic-rerouting.md.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

import numpy as np

from ..config import BASE_DIR, BBOX, DATA_DIR

FEATURES = ["feels_c", "exposure", "canopy", "surface_excess_c", "industrial_c",
            "traffic_heat_c", "air_c", "rh", "wind_ms", "congestion", "future_air_c",
            "future_rh", "future_exposure", "future_intensity", "horizon_min",
            "hour_sin", "hour_cos", "east_km", "north_km"]


def features(graph, current, future, first_frame, future_frame, congestion, indices=None):
    ids = np.arange(len(graph.p_len)) if indices is None else indices
    n = len(ids)
    hour = first_frame.when.hour + first_frame.when.minute / 60
    scalar = lambda value: np.full(n, value)
    values = [current["feels"][ids], current["exposure"][ids], current["canopy"][ids],
              current["surface_excess"][ids], current["industrial_c"][ids], current["traffic_heat_c"][ids],
              scalar(first_frame.weather.air_c), scalar(first_frame.weather.rh), scalar(first_frame.weather.wind_ms),
              np.broadcast_to(congestion, len(graph.p_len))[ids], scalar(future_frame.weather.air_c),
              scalar(future_frame.weather.rh), future["exposure"][ids], scalar(future_frame.intensity),
              scalar((future_frame.when - first_frame.when).total_seconds() / 60),
              scalar(np.sin(hour * np.pi / 12)), scalar(np.cos(hour * np.pi / 12)),
              graph.p_mid[ids, 0] / 1000, graph.p_mid[ids, 1] / 1000]
    matrix = np.column_stack(values).astype(np.float32)
    if not np.isfinite(matrix).all():
        raise ValueError("Non-finite correction features")
    return matrix


class CorrectionLayer:
    def __init__(self):
        self._lock = threading.Lock()
        self._loaded_at = 0.0
        self._models = None
        self.reason = "not_loaded"
        self.metadata = {}

    def _load(self):
        if os.getenv("HEATMIND_XGBOOST_ENABLED", "1").lower() not in ("1", "true", "yes"):
            self.reason = "disabled"
            return None
        with self._lock:
            if time.monotonic() - self._loaded_at < 60:
                return self._models
            self._loaded_at = time.monotonic()
            self._models = None
            try:
                folder = Path(os.getenv("HEATMIND_XGBOOST_MODEL_DIR", str(DATA_DIR / "ml")))
                if not folder.is_absolute():
                    folder = BASE_DIR / folder
                metadata = json.loads((folder / "metadata.json").read_text())
                if metadata.get("features") != FEATURES or metadata.get("bbox") != list(BBOX):
                    raise ValueError("Model contract or area mismatch")
                import xgboost as xgb  # Optional dependency; normal APIs never import it.
                models = []
                for name in ("heat_delta", "traffic_delta"):
                    model = xgb.Booster(params={"nthread": 2})
                    model.load_model(folder / (name + ".ubj"))
                    if model.feature_names != FEATURES or model.num_features() != len(FEATURES):
                        raise ValueError("Model feature mismatch")
                    models.append(model)
                self._models = (xgb, *models)
                self.metadata = metadata
                self.reason = "available"
            except Exception:
                self.reason = "model_or_runtime_unavailable"
            return self._models

    def apply(self, graph, pvs, frames, congestion, baseline_congestion):
        """Return fresh arrays. Failed inference falls back as one atomic operation."""
        models = self._load()
        status = {"source": "physics_traffic", "ml_applied": False, "reason": self.reason}
        if models is None:
            return pvs, congestion.copy(), status
        try:
            xgb, heat, traffic = models
            corrected = list(pvs)
            predicted_congestion = congestion.copy()
            for i, frame in enumerate(frames):
                horizon = (frame.when - frames[0].when).total_seconds() / 60
                if not 0 < horizon <= 60:
                    continue
                matrix = xgb.DMatrix(features(graph, pvs[0], pvs[i], frames[0], frame, congestion), feature_names=FEATURES, nthread=2)
                delta = np.asarray(heat.predict(matrix), dtype=float)
                if delta.shape != congestion.shape or not np.isfinite(delta).all():
                    raise ValueError("Invalid heat correction")
                # Blend a bounded forecast residual, not another copy of future warming.
                residual = pvs[0]["feels"] + delta - pvs[i]["feels"]
                corrected[i] = {**pvs[i], "feels": pvs[i]["feels"] + .25 * np.clip(residual, -3, 3)}
                if i == 1:
                    change = np.asarray(traffic.predict(matrix), dtype=float)
                    if change.shape != congestion.shape or not np.isfinite(change).all():
                        raise ValueError("Invalid traffic correction")
                    future_baseline = baseline_congestion(frame)
                    expected_change = future_baseline - baseline_congestion(frames[0])
                    predicted_congestion = np.clip(congestion + .25 * np.clip(change - expected_change, -.2, .2), 0, 1)
            status = {"source": "xgboost", "ml_applied": True,
                      "training_source": self.metadata.get("training_source", "unknown"),
                      "reason": "available"}
            return corrected, predicted_congestion, status
        except Exception:
            return pvs, congestion.copy(), {**status, "reason": "inference_failed"}


correction_layer = CorrectionLayer()
