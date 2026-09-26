import unittest
from datetime import timedelta
from unittest.mock import patch

from fastapi import HTTPException
from app.routers.city_lab import PlanRequest, create_plan

from app.services.city_lab import parse_readings, plan, validate_readings
from app.services.weather import base_time


def result(before=40, after=37, cells=10):
    return {"before": {"feels_c": before}, "after": {"feels_c": after},
            "delta_c": after - before, "cells_affected": cells}


class CityLabTests(unittest.TestCase):
    def setUp(self):
        self.data = {"sites": [
            {"id": "a", "name": "A", "lat": 18.44, "lon": 73.83, "choices": {"trees": result(), "shade_structure": result(after=35)}},
            {"id": "b", "name": "B", "lat": 18.45, "lon": 73.84, "choices": {"trees": result(before=38, after=36, cells=20)}},
        ]}

    def csv(self, rows, extra=""):
        return "lat,lon,time,metric,observed_c,predicted_c" + extra + "\n" + "\n".join(rows)

    def test_budget_and_weighted_patch_results(self):
        out = plan(self.data, 50000, {})
        self.assertEqual(out["spent"], 50000)
        self.assertEqual(len(out["projects"]), 2)
        self.assertEqual(out["evaluated_ground_m2"], 3000)
        self.assertEqual(out["before_c"], 38.7)
        self.assertEqual(out["after_c"], 36.3)
        self.assertEqual(out["reduction_c"], 2.33)
        self.assertEqual(out["remaining"], 0)
        self.assertEqual(plan(self.data, 0, {})["projects"], [])
        self.assertEqual(self.data["sites"][0]["choices"]["trees"]["after"]["feels_c"], 37)

    def test_water_proposal_cannot_claim_temperature_reduction(self):
        out = plan(self.data, 30000, {}, [{"site_id": "a", "kind": "water_refill"}])
        self.assertEqual(out["proposed_water_points"], 1)
        self.assertEqual(out["evaluated_ground_m2"], 0)
        self.assertEqual(out["reduction_c"], 0)
        self.assertIsNone(out["before_c"])

    def test_invalid_or_duplicate_projects_and_overspending(self):
        for projects in ([{"site_id": "missing", "kind": "trees"}],
                         [{"site_id": "a", "kind": "trees"}] * 2,
                         [{"site_id": "a", "kind": "shade_structure"}]):
            with self.assertRaises(ValueError):
                plan(self.data, 25000, {}, projects)

    def test_changed_live_snapshot_requires_refresh(self):
        with patch("app.routers.city_lab.catalog", return_value={**self.data, "time": "new"}):
            with self.assertRaises(HTTPException) as error:
                create_plan(PlanRequest(catalog_time="old"))
            self.assertEqual(error.exception.status_code, 422)

    def test_known_error_metrics_and_temperature_matching(self):
        rows = parse_readings(self.csv([
            "18.44,73.83,2026-09-26T13:30:00+05:30,surface_c,30,32",
            "18.45,73.84,2026-09-26T13:30:00+05:30,surface_c,30,29",
        ]))
        out = validate_readings(rows, 1)
        self.assertEqual(out["stats"]["mae_c"], 1.5)
        self.assertEqual(out["stats"]["rmse_c"], 1.581)
        self.assertEqual(out["stats"]["bias_c"], .5)
        self.assertEqual(out["stats"]["within_tolerance_pct"], 50)
        self.assertEqual(out["source"], "uploaded_observations")

    def test_rejects_wrong_metric_outside_zone_nan_naive_time_duplicates(self):
        base = "18.44,73.83,2026-09-26T13:30:00+05:30,surface_c,30,32"
        for rows in ([base, base.replace("surface_c", "air_c").replace("18.44", "18.45")],
                     [base.replace("18.44", "90")], [base.replace(",30,", ",nan,")],
                     [base.replace("+05:30", "")], [base, base],
                     [base, base.replace("13:30:00+05:30", "08:00:00Z")]):
            with self.assertRaises(ValueError):
                parse_readings(self.csv(rows))

    def test_imported_synthetic_demo_stays_labelled(self):
        rows = parse_readings(self.csv(["18.44,73.83,2026-09-26T13:30:00+05:30,surface_c,30,32,synthetic_demo"], ",reference_source"))
        self.assertEqual(validate_readings(rows)["source"], "synthetic_demo")

    def test_old_readings_without_saved_prediction_do_not_claim_accuracy(self):
        when = (base_time() - timedelta(days=2)).isoformat()
        rows = parse_readings(self.csv([f"18.44,73.83,{when},surface_c,30,"]))
        with patch("app.services.city_lab.get_twin") as twin:
            with self.assertRaises(ValueError):
                validate_readings(rows)
            twin.assert_not_called()

    def test_fallback_weather_cannot_be_reported_as_sensor_validation(self):
        rows = parse_readings(self.csv([f"18.44,73.83,{base_time().isoformat()},surface_c,30,"]))
        with patch("app.services.city_lab.get_twin") as twin:
            twin.return_value.frame.return_value.weather.source = "climatology_fallback"
            with self.assertRaises(ValueError):
                validate_readings(rows)


if __name__ == "__main__":
    unittest.main()
