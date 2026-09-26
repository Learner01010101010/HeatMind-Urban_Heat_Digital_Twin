import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path as FilePath
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from app.services.multi_route_engine import astar, augment_candidates, objective_choices, pareto_ids, record_examples, switch_decision
from app.services.live_routing import recheck
from app.services.routing_service import Path, StreetGraph


def route(key, minutes, metres, dose, score, risk=20):
    return {"id": key, "tags": [], "duration_min": minutes, "distance_m": metres,
            "heat_risk_score": risk, "metrics": {"duration_min": minutes, "distance_m": metres, "heat_dose": dose},
            "optimization": {"score": score, "industrial": {"mean_c": 0},
                             "traffic": {"delay_min": 0, "coverage_pct": 0}, "mapped_stops": 0},
            "mode": "walk", "band": "Low"}


class MultiRouteEngineTests(unittest.TestCase):
    def graph(self):
        graph = StreetGraph.__new__(StreetGraph)
        graph.node_ll = {1: (18.46, 73.84), 2: (18.4601, 73.84), 3: (18.46, 73.8401), 4: (18.4602, 73.84)}
        graph.eu, graph.ev = [1, 2, 1, 3], [2, 4, 3, 4]
        graph.elen = np.array([10., 10., 15., 15.])
        graph.p_edge = np.arange(4)
        graph.adj = {1: [(2, 0, 1), (3, 2, 1)], 2: [(1, 0, -1), (4, 1, 1)],
                     3: [(1, 2, -1), (4, 3, 1)], 4: [(2, 1, -1), (3, 3, -1)]}
        graph.mode_mask = lambda mode: np.ones(4, dtype=bool)
        return graph

    def test_astar_matches_dijkstra_time_and_preserves_reverse_edges(self):
        graph = self.graph()
        # Synthetic costs below geodesic edge lengths still get a safe heuristic
        # by using graph-consistent node positions for this exact fixture.
        graph.node_ll = {n: (0., n * .00000001) for n in range(1, 5)}
        costs = np.array([12., 12., 3., 3.])
        result = astar(graph, 4, 1, costs, np.ones(4, dtype=bool))
        self.assertEqual(result.edges, graph.dijkstra(4, 1, costs).edges)
        self.assertEqual(result.edges, [-4, -3])

    def test_explicit_shortest_and_fastest_are_both_present(self):
        graph = self.graph()
        graph.node_ll = {n: (0., n * .00000001) for n in range(1, 5)}
        result = augment_candidates(graph, 1, 4, np.array([12., 12., 3., 3.]), [], SimpleNamespace(key="walk"))
        self.assertEqual({tuple(p.edges) for p in result}, {(0, 1), (2, 3)})

    def test_closed_and_forbidden_edges_are_excluded(self):
        graph = self.graph()
        graph.mode_mask = lambda mode: np.array([True, False, True, True])
        traffic = {"closed": np.array([False, False, True, False])}
        self.assertEqual(augment_candidates(graph, 1, 4, np.ones(4), [Path([1, 2, 4], [0, 1])], SimpleNamespace(key="car"), traffic), [])

    def test_objectives_and_balanced_detour_budget(self):
        a = route("a", 10, 800, 50, 45)
        b = route("b", 14, 700, 20, 30)
        c = route("c", 25, 1500, 5, 10)
        choices = objective_choices([a, b, c])
        self.assertEqual([choices[k]["id"] for k in ("fastest", "shortest", "coolest", "balanced")], ["a", "b", "c", "b"])
        b["optimization"]["score"] = 44
        self.assertEqual(objective_choices([a, b, c])["balanced"]["id"], "a")

    def test_pareto_removes_only_dominated_candidates(self):
        a = route("a", 10, 800, 50, 45)
        b = route("b", 14, 700, 20, 30)
        dominated = route("d", 15, 900, 25, 40)
        self.assertEqual(set(pareto_ids([a, b, dominated])), {"a", "b"})

    def test_switch_hysteresis_and_emergency_triggers(self):
        a = route("a", 10, 800, 50, 45)
        b = route("b", 9.6, 750, 49, 44)
        for objective in ("balanced", "fastest", "shortest", "coolest"):
            self.assertFalse(switch_decision(a, b, objective)[0])
        self.assertTrue(switch_decision(a, b, "balanced", off_route=True)[0])
        self.assertTrue(switch_decision(None, b, "balanced", blocked=True)[0])
        self.assertFalse(switch_decision(None, b, "balanced")[0])

    def test_local_training_log_contains_no_location_or_measured_claims(self):
        result = {"persona": "student", "scenario": "live", "temp_delta_c": 0,
                  "conditions": {"weather": {"source": "open_meteo"}}, "routes": [route("test", 10, 800, 50, 45)]}
        with tempfile.TemporaryDirectory() as folder:
            path = FilePath(folder) / "training.sqlite3"
            self.assertEqual(record_examples(result, path)["examples"], 1)
            self.assertEqual(record_examples(result, path)["examples"], 1)
            with closing(sqlite3.connect(path)) as db:
                features, labels = db.execute("SELECT features, labels FROM examples").fetchone()
            self.assertNotIn("lat", json.loads(features))
            self.assertEqual(json.loads(labels)["source"], "rule_derived")
            self.assertIsNone(json.loads(labels)["measured_heat_exposure"])

    def test_recheck_pins_only_remaining_suffix_and_preserves_preferences(self):
        a = route("a", 10, 800, 50, 45)
        a["id"] = "old-0"
        new_a = route("new-0", 5, 400, 25, 40)
        new_a["tags"] = ["current"]
        state = {"origin": (18.46, 73.84), "destination": (18.47, 73.84), "persona": "senior",
                 "scenario": "live", "mode": "walk", "senior": True, "objective": "shortest",
                 "paths": {"old-0": Path([1, 2, 4], [0, 1])},
                 "result": {"routes": [a], "conditions": {"weather": {"air_c": 30}}}}
        graph = self.graph()
        graph.snap = lambda *args, **kwargs: 2 if args[0] == 18.4601 else 4
        captured = {}
        def compare(**kwargs):
            captured.update(kwargs)
            return {"recommended_id": new_a["id"], "routes": [new_a], "conditions": {"weather": {"air_c": 33}}}
        planner = SimpleNamespace(graph=graph, get=lambda cid: state, compare=compare)
        with patch("app.services.live_routing.traffic_service.route_field", return_value={"closed": np.zeros(4, dtype=bool)}):
            result = recheck(planner, compare_id="old", route_id="old-0", position=(18.4601, 73.84))
        self.assertEqual(captured["extra_paths"][0].nodes, [2, 4])
        self.assertEqual(captured["extra_paths"][0].edges, [1])
        self.assertTrue(captured["senior"])
        self.assertEqual(captured["objective"], "shortest")
        self.assertFalse(result["should_switch"])
        self.assertEqual(result["changes"], ["Air temperature changed by +3.0°C"])


if __name__ == "__main__":
    unittest.main()
