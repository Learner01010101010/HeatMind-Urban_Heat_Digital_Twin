import unittest

import numpy as np

from app.services import geo, jam_sim
from app.services.live_routing import _axes, _best_for_traveller, _clear_of_jam


class FakeGraph:
    """Three pieces in a line, 10 m apart, near the middle of the zone."""

    def __init__(self):
        lat, lon = 18.4636, 73.8228
        x, y = geo.to_xy(lat, lon)
        self.p_mid = np.array([[x, y], [x + 10, y], [x + 400, y]], dtype=float)
        self.p_len = np.array([10.0, 10.0, 10.0])

    def path_pieces(self, path):
        return np.asarray(path, dtype=int), None


def route(rid, *, minutes, km, dose, shade, pois, score, geometry, tags=("street",)):
    return {"id": rid, "tags": list(tags), "duration_min": minutes, "distance_m": km * 1000,
            "metrics": {"heat_dose": dose, "pct_shaded": shade},
            "pois_along_route": [{"id": i} for i in range(pois)],
            "optimization": {"score": score, "factors": [{"key": "traffic", "raw": 60.0}]},
            "geometry": geometry}


class JamSimTests(unittest.TestCase):
    def setUp(self):
        self.graph = FakeGraph()

    def test_jam_lands_on_the_road_ahead_not_behind(self):
        jam = jam_sim.ahead_on(self.graph, [0, 1, 2], metres=15)
        self.assertIsNotNone(jam)
        # The first two pieces are within 10 m of each other; the third is 400 m away.
        self.assertEqual(jam_sim.pieces_hit(self.graph, [0, 1], jam), 2)
        self.assertEqual(jam_sim.pieces_hit(self.graph, [2], jam), 0)

    def test_jam_marks_the_field_as_simulated_never_as_live_observation(self):
        """A fabricated reading must stay distinguishable from a measured one."""
        field = {"congestion": np.full(3, np.nan), "speed_ms": np.full(3, np.nan),
                 "closed": np.zeros(3, bool), "live": np.zeros(3, bool),
                 "simulated": np.zeros(3, bool), "observed_at": "2026-01-01T00:00:00Z"}
        jam = jam_sim.ahead_on(self.graph, [0, 1, 2], metres=5)
        out = jam_sim.apply(self.graph, field, jam)
        self.assertTrue(out["simulated"][:2].all())
        self.assertFalse(out["simulated"][2])
        self.assertTrue(out["live"][:2].all())
        # An observation timestamp would imply the jam was measured somewhere.
        self.assertIsNone(out["observed_at"])
        self.assertFalse(out["closed"].any(), "a jam is a crawl, not a closure")

    def test_no_jam_leaves_the_field_untouched(self):
        field = {"congestion": np.full(3, np.nan), "speed_ms": np.full(3, np.nan),
                 "closed": np.zeros(3, bool), "live": np.zeros(3, bool), "observed_at": "x"}
        out = jam_sim.apply(self.graph, field, None)
        self.assertFalse(out["live"].any())
        self.assertEqual(out["observed_at"], "x")


class JamChoiceTests(unittest.TestCase):
    def setUp(self):
        self.jam = jam_sim.Jam(lat=18.4636, lon=73.8228, radius_m=180.0)
        # Through the jam.
        self.current = route("cur", minutes=20, km=6.0, dose=50, shade=40, pois=100, score=30,
                             geometry=[[18.4636, 73.8228]], tags=("street", "current"))
        # Clear of it, and better on most axes.
        self.good = route("good", minutes=18, km=6.4, dose=40, shade=55, pois=110, score=25,
                          geometry=[[18.4700, 73.8300]])
        # Clear of it, but worse on everything that matters.
        self.poor = route("poor", minutes=26, km=9.0, dose=70, shade=20, pois=60, score=45,
                          geometry=[[18.4710, 73.8310]])

    def test_routes_through_the_jam_are_not_candidates(self):
        clear = _clear_of_jam([self.current, self.good, self.poor], self.jam)
        self.assertEqual({r["id"] for r in clear}, {"good", "poor"})

    def test_the_candidate_winning_on_more_axes_is_chosen(self):
        best = _best_for_traveller([self.good, self.poor], self.current)
        self.assertEqual(best["id"], "good")

    def test_axes_report_losses_rather_than_hiding_them(self):
        """A detour is longer; the panel has to say so instead of claiming a win."""
        axes = {a["label"]: a for a in _axes(self.current, self.good)}
        self.assertTrue(axes["Travel time"]["improved"])
        self.assertTrue(axes["Heat exposure"]["improved"])
        self.assertTrue(axes["Shade cover"]["improved"])
        self.assertTrue(axes["Water & rest stops"]["improved"])
        self.assertFalse(axes["Distance"]["improved"])
        self.assertEqual(axes["Distance"]["delta"], 0.4)


if __name__ == "__main__":
    unittest.main()
