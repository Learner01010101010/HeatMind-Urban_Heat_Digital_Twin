import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from pydantic import ValidationError

from app.routers.micro_rest import ScheduleRequest
from app.services import geo
from app.services.micro_rest import rank_candidates, schedule
from app.services.routing_service import StreetGraph


def point(id="water", out=3, back=3, shade=80, water=True):
    return {"id": id, "outbound_min": out, "return_min": back,
            "shade_pct": shade, "cooler_by_c": 2, "water": water, "seating": False}


class MicroRestTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 26, 8, tzinfo=timezone.utc)

    def test_round_trip_must_include_rest_and_buffer(self):
        self.assertEqual(rank_candidates([point()], 7.99), [])
        selected = rank_candidates([point()], 8)[0]
        self.assertEqual(selected["rest_min"], 1)
        self.assertEqual(selected["required_min"], 8)

    def test_return_is_to_pickup_not_twice_outbound(self):
        self.assertEqual(rank_candidates([point(out=1, back=6)], 8), [])
        self.assertEqual(len(rank_candidates([point(out=6, back=1)], 9)), 1)

    def test_benefit_ranking_only_after_deadline_filter(self):
        best = point("best", shade=100)
        quick = point("quick", out=1, back=1, shade=0, water=False)
        self.assertEqual(rank_candidates([quick, best], 8)[0]["id"], "best")
        self.assertEqual(rank_candidates([quick, best], 7)[0]["id"], "quick")

    def test_rest_duration_is_bounded_and_never_rounds_up(self):
        p = rank_candidates([point(out=1, back=1)], 4.19)[0]
        self.assertEqual(p["rest_min"], 1.1)
        self.assertLessEqual(p["outbound_min"] + p["return_min"] + p["buffer_min"] + p["rest_min"], 4.19)
        self.assertEqual(rank_candidates([point()], 60)[0]["rest_min"], 5)

    def test_expired_window_does_not_call_model(self):
        with patch("app.services.micro_rest.get_planner") as planner:
            out = schedule(origin=(18.44, 73.83), pickup=(18.44, 73.83),
                           ready_at=self.now, persona="worker", now=self.now)
            self.assertEqual(out["status"], "expired")
            planner.assert_not_called()

    def test_input_requires_timezone_and_finite_coordinates(self):
        body = {"origin": {"lat": 18.44, "lon": 73.83}, "pickup": {"lat": 18.44, "lon": 73.83},
                "ready_at": "2026-09-26T13:30:00"}
        with self.assertRaises(ValidationError):
            ScheduleRequest(**body)
        body["ready_at"] += "+05:30"
        body["origin"]["lat"] = float("nan")
        with self.assertRaises(ValidationError):
            ScheduleRequest(**body)

    def test_existing_graph_detour_seed_private_and_forbidden_filters(self):
        # A 120 m street detour instead of the 40 m straight-line shortcut.
        a = geo.to_xy(18.44, 73.83)
        ll = [geo.to_latlon(a[0] + x, a[1] + y) for x, y in [(0, 0), (0, 40), (40, 40), (40, 0)]]
        roads = [{"nodes": [(i + 1, *p) for i, p in enumerate(ll)], "width_m": 5,
                  "name": "Test street", "highway": "residential", "walkable": True}]
        # Minimal zone raster inputs needed by the existing graph.
        import numpy as np
        zone = SimpleNamespace(data={"roads": roads}, surface=np.zeros((geo.ROWS, geo.COLS), dtype=np.uint8))
        graph = StreetGraph(zone)
        poi = {"id": "mapped", "name": "Mapped water", "lat": ll[-1][0], "lon": ll[-1][1],
               "source": "osm", "detail": "drinking_water", "opening_hours": "24/7"}
        twin = SimpleNamespace(frame=lambda *args: SimpleNamespace(weather=SimpleNamespace(source="open_meteo"), intensity=.8),
                               sample=lambda *args: {"feels_c": 38, "sun_exposure": .2})
        planner = SimpleNamespace(graph=graph, twin=twin, pois=[poi, {**poi, "id": "seed", "source": "seeded"},
                                  {**poi, "id": "private", "access": "private"}, {**poi, "id": "closed", "opening_hours": "off"}])
        out = schedule(origin=ll[0], pickup=ll[0], ready_at=self.now + timedelta(minutes=8),
                       persona="gig_worker", now=self.now, planner=planner)
        self.assertEqual([p["id"] for p in out["candidates"]], ["mapped"])
        chosen = out["candidates"][0]
        self.assertGreater(chosen["outbound_min"], 1.5)
        self.assertEqual(chosen["amenities"], ["mapped drinking water", "modelled shade"])
        self.assertEqual(datetime.fromisoformat(chosen["leave_by"]), self.now + timedelta(minutes=8 - chosen["return_min"] - 1))
        roads[0]["walkable"] = False
        blocked = StreetGraph(zone)
        planner.graph = blocked
        self.assertEqual(schedule(origin=ll[0], pickup=ll[0], ready_at=self.now + timedelta(minutes=8),
                                  persona="gig_worker", now=self.now, planner=planner)["candidates"], [])


if __name__ == "__main__":
    unittest.main()
