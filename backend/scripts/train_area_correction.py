"""Bootstrap a demo forecaster from public area geometry + modelled forecasts.

Run from backend: python scripts/train_area_correction.py
This is surrogate training, not measured validation. Never train on user trips.
"""
from __future__ import annotations

import json
import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import xgboost as xgb

from app.config import BBOX, DATA_DIR
from app.services.condition_correction import FEATURES, features
from app.services.route_planner import get_planner
from app.services.weather import base_time


def main():
    planner = get_planner()
    graph = planner.graph
    rng = np.random.default_rng(41)
    ids = rng.choice(len(graph.p_len), size=min(600, len(graph.p_len)), replace=False)
    rows, heat_targets, traffic_targets, held_out = [], [], [], []
    day = base_time().replace(hour=0, minute=0)
    # Hold out streets AND one time block; do not leak the same piece into both sets.
    road_holdout = (graph.p_edge[ids] % 5) == 0
    for scenario in ("demo", "live"):
        for hour in (8, 11, 14, 17):
            for warming in (0, 5):
                first = planner.twin.frame(day + timedelta(hours=hour), scenario, warming)
                for shady in (False, True):
                    current = graph.piece_values(first, shady)
                    for horizon in (15, 30, 60):
                        future = planner.twin.frame(first.when + timedelta(minutes=horizon), scenario, warming)
                        following = graph.piece_values(future, shady)
                        baseline = planner._congestion(first)
                        rows.append(features(graph, current, following, first, future, baseline, ids))
                        heat_targets.append(following["feels"][ids] - current["feels"][ids])
                        traffic_targets.append(np.full(len(ids), planner._congestion(future) - baseline))
                        # Exclude validation roads from training at all times; at held-out
                        # time blocks also exclude training roads from validation.
                        held_out.append(np.where(road_holdout & (hour == 17), 1,
                                                 np.where(~road_holdout & (hour != 17), 0, -1)))
                print(f"Sampled {scenario} {hour}:00 +{warming}°C", flush=True)
    matrix = np.concatenate(rows)
    split = np.concatenate(held_out)
    folder = DATA_DIR / "ml"
    folder.mkdir(exist_ok=True)
    evaluation = {}
    for name, values in (("heat_delta", heat_targets), ("traffic_delta", traffic_targets)):
        target = np.concatenate(values)
        train = xgb.DMatrix(matrix[split == 0], label=target[split == 0], feature_names=FEATURES)
        validation = xgb.DMatrix(matrix[split == 1], label=target[split == 1], feature_names=FEATURES)
        model = xgb.train({"objective": "reg:squarederror", "max_depth": 4, "eta": .08,
                           "subsample": .85, "tree_method": "hist", "nthread": 2, "seed": 41},
                          train, num_boost_round=100)
        prediction = model.predict(validation)
        evaluation[name] = {"held_out_rmse": float(np.sqrt(np.mean((prediction - target[split == 1]) ** 2))),
                            "baseline_rmse": float(np.sqrt(np.mean(target[split == 1] ** 2)))}
        model.save_model(folder / (name + ".ubj"))
    metadata = {"features": FEATURES, "bbox": list(BBOX), "training_source": "physics_forecast_surrogate",
                "created_at": base_time().isoformat(), "train_rows": int((split == 0).sum()),
                "validation_rows": int((split == 1).sum()), "horizon_min": [15, 30, 60],
                "evaluation": evaluation,
                "limitation": "Modelled labels; no measured heat, road speeds or trip outcomes. Held-out synthetic area/time blocks only."}
    (folder / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(json.dumps(metadata, indent=2), flush=True)


if __name__ == "__main__":
    main()
