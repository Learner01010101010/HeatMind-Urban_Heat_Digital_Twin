import json
import unittest
from unittest.mock import patch
import httpx
from app.services import route_advice as advice

def result():
    return {"recommended_id":"a","routes":[{
        "id":"a","duration_min":10,"distance_m":800,"heat_risk_score":70,
        "metrics":{"heat_dose":200,"pct_shaded_street":20,"shielded":False},
        "pois_along_route":[{"id":"water","source":"osm","detail":"drinking_water"},
            {"id":"private","source":"osm","detail":"drinking_water","access":"private"}]}]}

def output():
    return {"routes":{"a":{"summary":"A direct journey, but take shade breaks when needed.",
        "tips":["Carry drinking water with you.","Check a cooler departure time before leaving."]}}}

class AdviceFactsTest(unittest.TestCase):
    def test_grounding_and_privacy(self):
        trip=result()
        trip["origin"]={"lat":18.4,"lon":73.8}
        trip["routes"][0]["geometry"]=[[73.8,18.4]]
        facts=advice.route_facts(trip)
        self.assertEqual(facts["routes"][0]["public_water_points"],1)
        self.assertFalse(facts["routes"][0]["traffic_live"])
        self.assertNotIn("geometry",json.dumps(facts))
        self.assertNotIn("origin",facts)
    def test_invalid_measurements_are_null(self):
        trip=result();trip["routes"][0]["metrics"]["heat_dose"]=float("nan")
        self.assertIsNone(advice.route_facts(trip)["routes"][0]["modelled_heat_dose"])
    def test_malformed_incomplete_or_invented_numbers_are_rejected(self):
        for raw in ["not json",json.dumps({"routes":[]})]:
            with self.assertRaises(ValueError):advice.validate_response(raw,{"a"})
        data=output();data["routes"]["a"]["summary"]="This route saves 10 minutes."
        with self.assertRaises(ValueError):advice.validate_response(json.dumps(data),{"a"})
    def test_valid_text_only_returns_final_copy(self):
        text = json.dumps(output()) + "\nAdditional model text must not be returned."
        self.assertEqual(advice.validate_response(text,{"a"})["routes"]["a"]["tips"][0],
                         "Carry drinking water with you.")
        self.assertNotIn("Additional",str(advice.validate_response(text,{"a"})))
    def test_shade_is_not_a_claim_of_less_total_heat(self):
        facts={"routes":[{"id":"a","comparison":{"heat":"more","time":"longer"}}]}
        with self.assertRaises(ValueError):
            advice.validate_grounding({"routes":{"a":{"summary":"More shade and less heat."}}},facts)
        advice.validate_grounding({"routes":{"a":{"summary":"More shade, with a longer walk and more accumulated heat."}}},facts)
        facts["routes"][0]["comparison"]["shade"]="more"
        with self.assertRaises(ValueError):
            advice.validate_grounding({"routes":{"a":{"summary":"A longer walk with less shade."}}},facts)

class AdviceInferenceTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        advice._cache.clear()
    async def test_real_request_shape_thinking_and_cache(self):
        calls=[]
        async def handler(request):
            body=json.loads(request.content);calls.append(body)
            return httpx.Response(200,json={"message":{"content":json.dumps(output()),"thinking":"not user-facing"}})
        original=httpx.AsyncClient
        with patch.object(advice.httpx,"AsyncClient",side_effect=lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs)):
            first=await advice.generate_advice(result())
            second=await advice.generate_advice(result())
        self.assertEqual(first,second);self.assertEqual(len(calls),1)
        self.assertEqual(calls[0]["think"],advice.EXTENDED_THINKING);self.assertFalse(calls[0]["stream"])
        self.assertNotIn("thinking",json.dumps(first))
    async def test_timeout_releases_gate_and_does_not_cache(self):
        async def handler(request):raise httpx.ReadTimeout("timeout")
        original=httpx.AsyncClient
        with patch.object(advice.httpx,"AsyncClient",side_effect=lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs)):
            with self.assertRaises(httpx.ReadTimeout):await advice.generate_advice(result())
        self.assertFalse(advice._gate.locked());self.assertEqual(len(advice._cache),0)
    async def test_invalid_answer_has_one_bounded_correction_attempt(self):
        calls=[]
        async def handler(request):
            calls.append(json.loads(request.content))
            body={"routes":{}} if len(calls)==1 else output()
            return httpx.Response(200,json={"message":{"content":json.dumps(body)}})
        original=httpx.AsyncClient
        with patch.object(advice.httpx,"AsyncClient",side_effect=lambda **kwargs:original(transport=httpx.MockTransport(handler),**kwargs)):
            data=await advice.generate_advice(result())
        self.assertIn("a",data["routes"]);self.assertEqual(len(calls),2)
        self.assertIn("Correct this issue",calls[1]["messages"][0]["content"])
