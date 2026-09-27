import copy
import threading
import unittest
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers.dynamic_routes import router
from app.services.condition_correction import CorrectionLayer
from app.services.dynamic_rerouting import check, predicted_times, remaining_path, settings, worthwhile
from app.services.routing_service import Path, StreetGraph
from app.services.modes import get as mode


def route(minutes, dose):
    return {"duration_min": minutes, "metrics": {"heat_dose": dose}}


class DynamicRulesTests(unittest.TestCase):
    def test_tiny_changes_and_cooler_but_unreasonable_detours_do_not_prompt(self):
        config = settings()
        self.assertFalse(worthwhile(route(20, 100), route(19, 95), config)["suggest"])
        self.assertFalse(worthwhile(route(20, 100), route(30, 50), config)["suggest"])
        self.assertTrue(worthwhile(route(20, 100), route(15, 100), config)["suggest"])
        self.assertTrue(worthwhile(route(20, 100), route(22, 80), config)["suggest"])
        self.assertFalse(worthwhile(route(20, 100), route(10, 120), config)["suggest"])
        self.assertFalse(worthwhile(route(20, 0), route(20, 0), config)["suggest"])
        self.assertFalse(worthwhile(route(20, 1), route(20, .5), config)["suggest"])

    def test_configuration_is_bounded_and_invalid_values_fall_back(self):
        with patch.dict("os.environ", {"REROUTE_TIME_SAVING_MIN": "nan", "REROUTE_HEAT_IMPROVEMENT_PERCENT": "bad",
                                       "REROUTE_CHECK_INTERVAL_SECONDS": "0"}):
            value = settings()
        self.assertEqual(value["time_saving_min"], 5)
        self.assertEqual(value["heat_improvement_percent"], 15)
        self.assertEqual(value["check_seconds"], 30)

    def test_ml_never_slows_walkers_or_reopens_closures(self):
        seconds = np.array([100., 1e9])
        field = {"closed": np.array([False, True])}
        self.assertIs(predicted_times(None, field, mode("walk"), {}, seconds, np.zeros(2), np.ones(2)), seconds)
        updated = predicted_times(None, field, mode("car"), {}, seconds, np.zeros(2), np.ones(2))
        self.assertGreater(updated[0], seconds[0])
        self.assertEqual(updated[1], seconds[1])

    def test_missing_disabled_or_broken_ml_falls_back_without_mutation(self):
        values = [{"feels": np.array([40., 42.])}, {"feels": np.array([41., 43.])}]
        frames = [SimpleNamespace(when=datetime.now(timezone.utc)), SimpleNamespace(when=datetime.now(timezone.utc) + timedelta(minutes=15))]
        congestion = np.zeros(2)
        original = copy.deepcopy(values)
        layer = CorrectionLayer()
        with patch.dict("os.environ", {"HEATMIND_XGBOOST_ENABLED": "0"}):
            out, _, status = layer.apply(None, values, frames, congestion, lambda _: 0)
        self.assertIs(out, values)
        self.assertFalse(status["ml_applied"])
        with patch.object(layer, "_load", return_value=(None, None, None)):
            _, _, status = layer.apply(None, values, frames, congestion, lambda _: 0)
        self.assertEqual(status["reason"], "inference_failed")
        np.testing.assert_equal(values[0]["feels"], original[0]["feels"])

    def test_accept_endpoint_requires_explicit_consent(self):
        app = FastAPI()
        app.include_router(router)
        body = {"compare_id": "trip", "route_id": "trip-0", "position": {"lat": 18.46, "lon": 73.84}}
        with TestClient(app) as client, patch("app.routers.dynamic_routes.perform", return_value={"ok": True}) as perform:
            self.assertEqual(client.post("/api/routes/dynamic/accept", json=body).status_code, 422)
            self.assertEqual(client.post("/api/routes/dynamic/accept", json={**body, "consent": False}).status_code, 422)
            perform.assert_not_called()
            self.assertEqual(client.post("/api/routes/dynamic/accept", json={**body, "consent": True}).status_code, 200)
            self.assertTrue(perform.call_args.args[1])

    def test_ml_residual_is_bounded_and_invalid_predictions_revert_atomically(self):
        now = datetime.now(timezone.utc)
        frames = [SimpleNamespace(when=now + timedelta(minutes=n)) for n in (0, 15, 90)]
        values = [{"feels": np.array(pair, dtype=float)} for pair in ((40,42),(44,46),(50,52))]
        congestion = np.array([.4,.6])
        snapshot = copy.deepcopy(values)
        runtime = SimpleNamespace(DMatrix=lambda *a, **kw: None)
        heat = SimpleNamespace(predict=lambda _: np.array([4.,4.]))
        traffic = SimpleNamespace(predict=lambda _: np.zeros(2))
        layer = CorrectionLayer()
        with patch.object(layer, "_load", return_value=(runtime,heat,traffic)), patch("app.services.condition_correction.features", return_value=np.zeros((2,19))):
            out, _, status = layer.apply(None,values,frames,congestion,lambda _: .3)
            self.assertTrue(status["ml_applied"])
            np.testing.assert_equal(out[1]["feels"], values[1]["feels"])  # Forecast warming isn't applied twice.
            self.assertIs(out[0], values[0])
            self.assertIs(out[2], values[2])  # Beyond the trained horizon keeps physics.
            heat.predict = lambda _: np.array([100.,-100.])
            traffic.predict = lambda _: np.array([100.,-100.])
            out, updated, _ = layer.apply(None,values,frames,congestion,lambda _: .3)
            np.testing.assert_allclose(out[1]["feels"]-values[1]["feels"], [.75,-.75])
            np.testing.assert_allclose(updated-congestion, [.05,-.05])
            traffic.predict = lambda _: np.array([np.nan,0.])
            out, updated, status = layer.apply(None,values,frames,congestion,lambda _: .3)
            self.assertFalse(status["ml_applied"])
            self.assertIs(out,values)
            np.testing.assert_equal(updated,congestion)
        for a,b in zip(values,snapshot):
            np.testing.assert_equal(a["feels"],b["feels"])

    def test_remaining_path_uses_current_position_and_existing_dijkstra_connector(self):
        graph = SimpleNamespace(snap=lambda *a, **kw: 2, node_ll={1:(18.46,73.84),2:(18.4601,73.84),3:(18.4602,73.84)})
        src, suffix = remaining_path(graph, Path([1,2,3],[0,1]), (18.4601,73.84), mode("walk"))
        self.assertEqual(src, 2)
        self.assertEqual(suffix.nodes, [2,3])
        self.assertEqual(suffix.edges, [1])

    def test_checks_and_unsuccessful_acceptances_never_write_planner_state(self):
        planner = SimpleNamespace(_store=OrderedDict({"original": {"value": 1}}), _lock=threading.Lock())
        snapshot = copy.deepcopy(planner._store)
        with patch("app.services.dynamic_rerouting._plan", return_value=({"suggest": True}, ())) as plan:
            result = check(planner, "original", "route", (18.46,73.84))
        self.assertIsNone(result["comparison"])
        self.assertEqual(planner._store, snapshot)
        with patch("app.services.dynamic_rerouting._plan", return_value=({"suggest": False}, None)):
            check(planner, "original", "route", (18.4601,73.84), accept=True)
        self.assertEqual(planner._store, snapshot)

    def test_existing_apis_remain_and_no_auto_switch_endpoint_is_restored(self):
        from app.main import app
        paths = app.openapi()["paths"]
        for path in ("/api/routes/compare", "/api/routes/simulate", "/api/heat/twin", "/api/routes/dynamic/check", "/api/routes/dynamic/accept"):
            self.assertIn(path, paths)
        self.assertNotIn("/api/routes/recheck", paths)


if __name__ == "__main__":
    unittest.main()
