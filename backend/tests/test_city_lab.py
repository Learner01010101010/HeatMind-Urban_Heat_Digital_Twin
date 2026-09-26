import unittest
from unittest.mock import patch

from fastapi import HTTPException
from app.routers.city_lab import PlanRequest, create_plan

from app.services.city_lab import KINDS, plan


def result(before=40, after=37, cells=10):
    return {"before": {"feels_c": before}, "after": {"feels_c": after},
            "delta_c": after - before, "cells_affected": cells}


def site(sid, choices, lat=18.44, lon=73.83, plantable=True, ground=900):
    return {"id": sid, "name": sid.upper(), "lat": lat, "lon": lon, "choices": choices,
            "feasible": {"trees": {"ok": plantable, "open_ground_m2": ground,
                                   "reason": "" if plantable else "no open ground"}}}


class CityLabTests(unittest.TestCase):
    def setUp(self):
        self.data = {"sites": [
            site("a", {"trees": result(), "shade_structure": result(after=35)}),
            site("b", {"trees": result(before=38, after=36, cells=20)}, lat=18.45, lon=73.84),
        ]}

    def test_weighted_patch_results_and_zero_budget(self):
        out = plan(self.data, 50000, {})
        self.assertEqual(len(out["projects"]), 2)
        self.assertEqual(out["spent"], 2 * KINDS["trees"]["cost"])
        self.assertEqual(out["evaluated_ground_m2"], 3000)
        self.assertEqual(out["before_c"], 38.7)
        self.assertEqual(out["after_c"], 36.3)
        self.assertEqual(out["reduction_c"], 2.33)
        self.assertEqual(plan(self.data, 0, {})["projects"], [])
        # The catalogue is read-only to the planner.
        self.assertEqual(self.data["sites"][0]["choices"]["trees"]["after"]["feels_c"], 37)

    def test_spare_budget_is_spent_upgrading_to_the_better_fix(self):
        """A budget that fits the pricier fix should end up using it.

        The greedy pass ranks by relief per rupee, which picks two cheap tree
        patches and stops with most of the money unspent. The fill pass exists to
        notice that site A can take a shade structure that cools more.
        """
        cheap = plan(self.data, 20000, {})
        self.assertEqual(cheap["spent"], 16000)
        rich = plan(self.data, 150000, {})
        self.assertEqual(dict(zip([p["site_id"] for p in rich["projects"]],
                                  [p["kind"] for p in rich["projects"]])),
                         {"a": "shade_structure", "b": "trees"})
        self.assertEqual(rich["spent"], KINDS["shade_structure"]["cost"] + KINDS["trees"]["cost"])
        self.assertGreater(rich["spent"], cheap["spent"])

    def test_allocation_note_explains_any_shortfall(self):
        self.assertEqual(plan(self.data, 142000, {})["allocation_note"], "Fully allocated.")
        self.assertIn("below the cheapest fix", plan(self.data, 145000, {})["allocation_note"])
        big = plan(self.data, 900000, {})
        self.assertGreater(big["remaining"], 0)
        self.assertIn("candidate sites", big["allocation_note"])

    def test_trees_are_refused_where_there_is_no_ground_to_plant_them(self):
        """A mature canopy cannot be proposed on a patch that is built over."""
        blocked = {"sites": [site("a", {"trees": result()}, plantable=False, ground=200)]}
        with self.assertRaises(ValueError) as error:
            plan(blocked, 500000, {}, [{"site_id": "a", "kind": "trees"}])
        self.assertIn("Mature tree canopy", str(error.exception))
        # ...and the suggester does not offer it either.
        self.assertEqual(plan(blocked, 500000, {})["projects"], [])

    def test_water_proposal_cannot_claim_temperature_reduction(self):
        out = plan(self.data, 500000, {}, [{"site_id": "a", "kind": "water_refill"}])
        self.assertEqual(out["proposed_water_points"], 1)
        self.assertEqual(out["evaluated_ground_m2"], 0)
        self.assertEqual(out["reduction_c"], 0)
        self.assertIsNone(out["before_c"])

    def test_invalid_or_duplicate_projects_and_overspending(self):
        for projects in ([{"site_id": "missing", "kind": "trees"}],
                         [{"site_id": "a", "kind": "trees"}] * 2,
                         [{"site_id": "a", "kind": "shade_structure"}]):
            with self.assertRaises(ValueError):
                plan(self.data, 20000, {}, projects)

    def test_unit_costs_carry_their_arithmetic_and_a_source(self):
        """A number a city might act on has to say where it came from."""
        for kind, info in KINDS.items():
            self.assertGreater(info["cost"], 0, kind)
            self.assertGreater(len(info["basis"]), 60, kind)
            self.assertTrue(info["source"].strip(), kind)

    def test_changed_live_snapshot_requires_refresh(self):
        with patch("app.routers.city_lab.catalog", return_value={**self.data, "time": "new"}):
            with self.assertRaises(HTTPException) as error:
                create_plan(PlanRequest(catalog_time="old"))
            self.assertEqual(error.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
