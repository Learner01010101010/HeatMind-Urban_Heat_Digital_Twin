import unittest

from app.services.traffic import PROVIDERS, TrafficService, _here_parse, _tomtom_parse


class ProviderSelectionTests(unittest.TestCase):
    def test_explicit_provider_wins_and_label_is_reported(self):
        for name, spec in PROVIDERS.items():
            service = TrafficService(key="test-key", provider=name)
            self.assertEqual(service.provider, name)
            self.assertEqual(service.describe()["provider_label"], spec["label"])

    def test_without_a_key_nothing_is_reported_as_live(self):
        """No key must mean modelled congestion, never a fabricated reading."""
        service = TrafficService(key="", provider="here")
        described = service.describe()
        self.assertFalse(described["configured"])
        self.assertFalse(described["live"])
        self.assertEqual(described["source"], "modelled")
        self.assertEqual(service.refresh([(18.46, 73.82)], _now()), [])
        self.assertEqual(service.last_error, "key_missing")

    def test_request_carries_the_key_in_params_not_the_url(self):
        """A credential in the URL path would end up in logs and error strings."""
        for name, spec in PROVIDERS.items():
            url, params = spec["request"](18.46, 73.82, "secret")
            self.assertNotIn("secret", url, name)
            self.assertIn("secret", "".join(str(v) for v in params.values()), name)


class TomTomParseTests(unittest.TestCase):
    def test_reads_speeds_closure_and_shape(self):
        cur, free, confidence, coords, closed = _tomtom_parse({"flowSegmentData": {
            "currentSpeed": 12, "freeFlowSpeed": 40, "confidence": 0.9, "roadClosure": False,
            "coordinates": {"coordinate": [{"latitude": 18.46, "longitude": 73.82},
                                           {"latitude": 18.461, "longitude": 73.821}]}}})
        self.assertEqual((cur, free, confidence), (12.0, 40.0, 0.9))
        self.assertEqual(len(coords), 2)
        self.assertFalse(closed)


class HereParseTests(unittest.TestCase):
    """HERE Traffic v7 `flow`, shaped per its published schema.

    Not exercised against the live service — that needs a key this checkout does
    not have — so these cover the parsing and unit conversion only.
    """

    @staticmethod
    def link(points, speed, free, confidence=0.9, jam=0.0):
        return {"location": {"shape": {"links": [{"points": points}]}},
                "currentFlow": {"speed": speed, "freeFlow": free, "confidence": confidence, "jamFactor": jam}}

    def test_metres_per_second_become_kmh(self):
        points = [{"lat": 18.46, "lng": 73.82}, {"lat": 18.461, "lng": 73.821}]
        cur, free, confidence, coords, closed = _here_parse({"results": [self.link(points, 10.0, 20.0)]})
        self.assertAlmostEqual(cur, 36.0)   # 10 m/s
        self.assertAlmostEqual(free, 72.0)  # 20 m/s
        self.assertEqual(confidence, 0.9)
        self.assertEqual(len(coords), 2)
        self.assertFalse(closed)

    def test_the_most_congested_link_in_the_circle_wins(self):
        points = [{"lat": 18.46, "lng": 73.82}, {"lat": 18.461, "lng": 73.821}]
        payload = {"results": [self.link(points, 18.0, 20.0), self.link(points, 2.0, 20.0)]}
        cur, free, *_ = _here_parse(payload)
        self.assertAlmostEqual(cur / free, 0.1, places=6)

    def test_a_full_jam_factor_reads_as_closed(self):
        points = [{"lat": 18.46, "lng": 73.82}, {"lat": 18.461, "lng": 73.821}]
        *_, closed = _here_parse({"results": [self.link(points, 0.0, 20.0, jam=10.0)]})
        self.assertTrue(closed)

    def test_unusable_payloads_return_nothing_rather_than_guessing(self):
        for payload in ({}, {"results": []},
                        {"results": [self.link([{"lat": 18.46, "lng": 73.82}], 10.0, 20.0)]},  # one point
                        {"results": [{"location": {"shape": {"links": []}}, "currentFlow": {}}]}):
            self.assertIsNone(_here_parse(payload), payload)


def _now():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc)


if __name__ == "__main__":
    unittest.main()
