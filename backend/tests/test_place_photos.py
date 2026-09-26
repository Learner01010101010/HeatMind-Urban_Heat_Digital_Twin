import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from app.routers import photo


class PlacePhotoTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        photo._cache.clear()
        self.poi = {"id": "p-test", "source": "osm", "lat": 18.46, "lon": 73.84, "wikimedia_commons": "File:Place.jpg"}
        self.client = MagicMock()
        self.client.__aenter__ = AsyncMock(return_value=self.client)
        self.client.__aexit__ = AsyncMock(return_value=None)
        self.client.get = AsyncMock()

    async def test_commons_photo_has_credit_and_place_label(self):
        r = MagicMock()
        r.json.return_value = {"query": {"pages": {"1": {"imageinfo": [{"thumburl": "https://upload.wikimedia.org/test.jpg", "descriptionurl": "https://commons.wikimedia.org/wiki/File:Place.jpg",
            "extmetadata": {"Artist": {"value": "<a>Local photographer</a>"}, "LicenseShortName": {"value": "CC BY-SA 4.0"}}}]}}}}
        self.client.get.return_value = r
        with patch.object(photo.httpx, "AsyncClient", return_value=self.client), patch.object(photo, "MAPILLARY_TOKEN", ""), patch.object(photo, "get_zone", return_value=SimpleNamespace(pois=[self.poi])):
            result = await photo.nearby(18.46, 73.84, 3, "p-test")
        self.assertTrue(result["available"])
        self.assertEqual(result["photos"][0]["kind"], "place")
        self.assertEqual(result["photos"][0]["attribution"], "Local photographer · CC BY-SA 4.0")

    async def test_nearby_photos_are_distance_filtered_not_claimed_as_place(self):
        self.poi.pop("wikimedia_commons")
        r = MagicMock()
        r.json.return_value = {"data": [
            {"id": "123", "thumb_1024_url": "https://example.test/near.jpg", "computed_geometry": {"coordinates": [73.8401, 18.46]}, "captured_at": 1700000000000},
            {"id": "124", "thumb_1024_url": "https://example.test/far.jpg", "computed_geometry": {"coordinates": [73.85, 18.46]}},
        ]}
        self.client.get.return_value = r
        with patch.object(photo.httpx, "AsyncClient", return_value=self.client), patch.object(photo, "MAPILLARY_TOKEN", "test-token"), patch.object(photo, "get_zone", return_value=SimpleNamespace(pois=[self.poi])):
            result = await photo.nearby(18.46, 73.84, 3, "p-test")
        self.assertEqual(len(result["photos"]), 1)
        self.assertEqual(result["photos"][0]["kind"], "nearby")
        self.assertLess(result["photos"][0]["distance_m"], 20)

    async def test_unavailable_provider_returns_static_empty_result(self):
        self.poi.pop("wikimedia_commons")
        self.client.get.side_effect = TimeoutError()
        with patch.object(photo.httpx, "AsyncClient", return_value=self.client), patch.object(photo, "MAPILLARY_TOKEN", "test-token"), patch.object(photo, "get_zone", return_value=SimpleNamespace(pois=[self.poi])):
            result = await photo.nearby(18.46, 73.84, 3, "p-test")
        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "provider_error")


if __name__ == "__main__":
    unittest.main()
