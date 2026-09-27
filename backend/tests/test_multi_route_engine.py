import unittest
from types import SimpleNamespace

import numpy as np

from app.services.multi_route_engine import astar, augment_candidates, recommended_route
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

    def test_recommendation_respects_detour_budget_and_minimum_gain(self):
        a = route("a", 10, 800, 50, 45)
        b = route("b", 14, 700, 20, 30)
        c = route("c", 25, 1500, 5, 10)
        self.assertEqual(recommended_route([a, b, c])["id"], "b")
        b["optimization"]["score"] = 44
        self.assertEqual(recommended_route([a, b, c])["id"], "a")



if __name__ == "__main__":
    unittest.main()
