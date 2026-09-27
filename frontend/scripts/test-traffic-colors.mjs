import assert from "node:assert/strict";
import { test } from "node:test";
import { TRAFFIC_BANDS, TRAFFIC_VISIBLE_AT, trafficColor, trafficLabel, trafficPct } from "../lib/trafficColorScale.ts";

const DARK_PURPLE = ["#8b3fa8", "#4a1a63"];

test("heavy traffic is dark purple, and only heavy traffic is", () => {
  assert.ok(DARK_PURPLE.includes(trafficColor(0.7)), "0.70 should read heavy");
  assert.ok(DARK_PURPLE.includes(trafficColor(0.95)), "0.95 should read severe");
  assert.ok(DARK_PURPLE.includes(trafficColor(1)), "a stopped road should read severe");
  for (const clear of [0, 0.1, 0.24, 0.3, 0.5, 0.64]) {
    assert.ok(!DARK_PURPLE.includes(trafficColor(clear)), `${clear} must not read as heavy`);
  }
});

test("the ramp never goes backwards and every band is reachable", () => {
  const seen = new Set();
  let previous = -1;
  for (const band of TRAFFIC_BANDS) {
    assert.ok(band.from > previous, `bands must ascend: ${band.label}`);
    previous = band.from;
    seen.add(trafficColor(band.from));
  }
  assert.equal(seen.size, TRAFFIC_BANDS.length, "each band should own a distinct colour");
});

test("labels match the colour they are drawn beside", () => {
  assert.equal(trafficLabel(0), "Free flowing");
  assert.equal(trafficLabel(0.5), "Moderate");
  assert.equal(trafficLabel(0.7), "Heavy");
  assert.equal(trafficLabel(0.9), "Severe");
});

test("a barely-slowed road is not drawn as congested at all", () => {
  // The route already carries heat colour; painting every road purple-ish would
  // bury that under noise, so there is a floor below which nothing is drawn.
  assert.ok(TRAFFIC_VISIBLE_AT > 0 && TRAFFIC_VISIBLE_AT < TRAFFIC_BANDS[1].from);
});

test("congestion is phrased against free flow, not as a bare fraction", () => {
  assert.equal(trafficPct(0.62), "62% below free flow");
  assert.equal(trafficPct(0), "0% below free flow");
});
