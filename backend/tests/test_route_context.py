import json
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np

from app.services import geo
from app.services.traffic import TrafficService, TTL_S
from app.services.osm_ingest import _amenity_poi
from app.services.route_classifier import classify, usable_stop
from app.services.routing_service import StreetGraph
from app.services.modes import get as mode
from app.services.route_planner import traffic_times
from app.services.risk_scoring import PERSONAS


class RouteContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.service = TrafficService(key="test-key", budget_path=Path(self.tmp.name) / "budget.json")
        self.now = datetime.now(timezone.utc)

    def provider(self, status=200):
        response = MagicMock()
        response.status_code = status
        response.json.return_value = {"flowSegmentData": {"currentSpeed": 10, "freeFlowSpeed": 40, "confidence": .9, "roadClosure": False,
            "coordinates": {"coordinate": [{"latitude": 18.46, "longitude": 73.84}, {"latitude": 18.461, "longitude": 73.84}]}}}
        client = MagicMock()
        client.__enter__.return_value = client
        client.get.return_value = response
        return client

    def test_no_key_or_forecast_never_calls_provider(self):
        with patch("app.services.traffic.httpx.Client") as client:
            self.service.key = ""
            self.assertEqual(self.service.refresh([(18.46, 73.84)], self.now), [])
            self.service.key = "test-key"
            self.assertEqual(self.service.refresh([(18.46, 73.84)], self.now + timedelta(hours=1)), [])
            self.assertIsNone(self.service.factor(self.now + timedelta(hours=1)))
            client.assert_not_called()

    def test_cache_freshness_and_persistent_budget(self):
        client = self.provider()
        with patch("app.services.traffic.httpx.Client", return_value=client):
            readings = self.service.refresh([(18.46, 73.84)], self.now)
            self.assertAlmostEqual(readings[0]["congestion"], .75)
            self.service.refresh([(18.46, 73.84)], self.now)
            self.assertEqual(client.get.call_count, 1)
            self.assertTrue(self.service.describe()["live"])
            self.assertEqual(json.loads(self.service.budget_path.read_text())["used"], 1)
            readings[0]["fetched"] = time.time() - TTL_S - 1
            self.assertFalse(self.service.describe()["live"])
            self.assertIsNone(self.service.factor(self.now))
            self.service.monthly_limit = 1
            self.assertEqual(self.service.refresh([(18.46, 73.84)], self.now), [])
            self.assertEqual(client.get.call_count, 1)
            self.assertEqual(self.service.last_error, "monthly_limit")

    def test_provider_failure_is_not_live_and_backs_off(self):
        client = self.provider(429)
        with patch("app.services.traffic.httpx.Client", return_value=client):
            self.assertEqual(self.service.refresh([(18.46, 73.84)], self.now), [])
            self.service.refresh([(18.46, 73.84)], self.now)
            self.assertEqual(client.get.call_count, 1)
            self.assertFalse(self.service.describe()["live"])
            self.assertEqual(self.service.last_error, "provider_limit")

    def test_geometry_does_not_spread_traffic_to_parallel_far_road(self):
        a = np.asarray(geo.to_xy(18.46, 73.84))
        b = np.asarray(geo.to_xy(18.461, 73.84))
        graph = SimpleNamespace(p_len=np.array([100, 100]), p_edge=np.array([0, 1]), eroad=np.array([0, 1]),
            p_start=np.array([a, a + [60, 0]]), p_end=np.array([b, b + [60, 0]]),
            p_mid=np.array([(a + b) / 2, (a + b) / 2 + [60, 0]]),
            zone=SimpleNamespace(data={"roads": [{"highway": "primary"}, {"highway": "primary"}]}),
            path_pieces=lambda p: (np.array([0, 1]), np.array([True, True])))
        client = self.provider()
        with patch("app.services.traffic.httpx.Client", return_value=client):
            field = self.service.route_field(graph, [object()], self.now)
        np.testing.assert_array_equal(field["live"], [True, False])
        self.assertTrue(np.isnan(field["congestion"][1]))

    def test_amenities_preserve_toilet_and_water_metadata(self):
        pois = []
        _amenity_poi(pois, {"amenity": "toilets", "fee": "no", "opening_hours": "24/7", "wheelchair": "yes"}, 18.46, 73.84, "node/123")
        _amenity_poi(pois, {"amenity": "water_dispenser", "access": "private"}, 18.46, 73.84)
        self.assertEqual(pois[0]["detail"], "toilets")
        self.assertEqual(pois[0]["opening_hours"], "24/7")
        self.assertTrue(usable_stop(pois[0]))
        self.assertFalse(usable_stop(pois[1]))
        self.assertFalse(usable_stop({"source": "seeded", "detail": "bench"}))
        self.assertFalse(usable_stop({"source": "osm", "detail": "restaurant"}))
        _amenity_poi(pois, {"shop": "electronics"}, 18.46, 73.84)
        self.assertEqual(len(pois), 2, "An electronics shop is not a water stop")

    def test_classifier_does_not_change_existing_heat_score(self):
        route = {"heat_risk_score": 42, "metrics": {"mean_feels_c": 35, "pct_shaded_street": 50, "max_gap_min": 10}, "pois_along_route": []}
        c = classify(route, industrial=np.array([.5, 1.5]), traffic_heat=np.array([1, 1]), seconds=np.array([60, 60]),
            lengths=np.array([100, 100]), traffic={"live": np.array([True, False]), "congestion": np.array([.75, np.nan]), "observed_at": None}, free_seconds=np.array([30, 30]))
        self.assertEqual(route["heat_risk_score"], 42)
        self.assertEqual(c["industrial"]["mean_c"], 1)
        self.assertEqual(c["industrial"]["heat_dose_c_min"], 2)
        self.assertEqual(c["traffic"]["coverage_pct"], 50)
        self.assertEqual(c["traffic"]["delay_min"], 1)
        self.assertEqual(sum(f["weight"] for f in c["factors"]), 1)
        self.assertLessEqual(c["score"], 100)

    def test_existing_router_avoids_slow_corridor(self):
        graph = StreetGraph.__new__(StreetGraph)
        graph.eu = np.array([0, 1, 0, 2]); graph.ev = np.array([1, 3, 2, 3]); graph.eroad = np.arange(4)
        graph.elen = np.array([100., 100., 120., 120.]); graph.p_edge = np.arange(4)
        graph.p_len = graph.elen.copy()
        graph.node_xy = np.array([[0., 0.], [100., 0.], [0., 120.], [100., 120.]])
        graph.node_ll = np.array([[18.46, 73.84]] * 4)
        graph.adj = [[(1, 0, 1), (2, 2, 1)], [(0, 0, -1), (3, 1, 1)], [(0, 2, -1), (3, 3, 1)], [(1, 1, -1), (2, 3, -1)]]
        # Reuse existing candidate search with localized vehicle travel times.
        paths = graph.candidate_paths(0, 3, np.array([600., 600., 30., 30.]), np.zeros(4))
        self.assertEqual(paths[0].nodes, [0, 2, 3])

    def test_traffic_changes_vehicle_eta_not_pedestrian_pace(self):
        graph = SimpleNamespace(p_len=np.array([100., 100.]))
        field = {"live": np.array([True, False]), "congestion": np.array([.8, np.nan]),
                 "speed_ms": np.array([1., np.nan]), "closed": np.array([False, False])}
        model = np.array([20., 20.])
        walk = traffic_times(graph, field, mode("walk"), PERSONAS["student"], model)
        car = traffic_times(graph, field, mode("car"), PERSONAS["student"], model)
        np.testing.assert_array_equal(walk, model)
        self.assertEqual(car[0], 100)
        self.assertEqual(car[1], 20)
        np.testing.assert_array_equal(model, [20, 20])
        field["closed"][0] = True
        self.assertEqual(traffic_times(graph, field, mode("car"), PERSONAS["student"], model)[0], 1e9)


if __name__ == "__main__":
    unittest.main()
