# Optional dynamic rerouting

Start normal navigation, then enable **Suggest route updates** in its guidance card.
It starts off. Checks run every 60 seconds while this page is visible. Existing
navigation, trip planning, the heat twin and three-hour forecasts are unchanged
when the feature is off.

The first check establishes a condition baseline. A later changed condition
snapshot can offer **Conditions changed → Reroute?**, with **Reroute** and
**Continue**. A sampled closure can prompt immediately. Merely checking, ignoring
the notice or choosing Continue never changes the active trip. Continue suppresses
requests for five minutes; the same unchanged condition snapshot does not keep
raising notices. Suggestions expire after 90 seconds.

Both remaining routes are costed from the current position using the same new
physics/weather/traffic snapshot. The original destination, mode, persona and
rest-point preference are retained. The existing `StreetGraph.dijkstra` generates
time-first, balanced and heat-averse candidates. Eligible alternatives are compared
using the same balanced time/heat cost. XGBoost only adjusts road-condition estimates; it
never ranks routes or learns route labels.

Checks support street journeys, including walking alternatives beside a bus
comparison. Bus itineraries continue to use their existing transit navigation.

Default notification gates:

| Setting in backend/.env | Default | Meaning |
| --- | --- | --- |
| REROUTE_TIME_SAVING_MIN | 5 | At least five minutes quicker, without higher accumulated heat |
| REROUTE_HEAT_IMPROVEMENT_PERCENT | 15 | At least 15% lower estimated heat dose |
| REROUTE_HEAT_DOSE_REDUCTION_MIN | 5 | Also reduce at least 5 °C·min to avoid large percentages of tiny doses |
| REROUTE_MAX_EXTRA_MINUTES | 5 | Cooler alternatives cannot add more than this; short journeys have a tighter cap |
| REROUTE_CONTINUE_COOLDOWN_SECONDS | 300 | Pause requests after Continue |
| REROUTE_CHECK_INTERVAL_SECONDS | 60 | Visible-page check interval (minimum 30 seconds) |

`HEATMIND_DYNAMIC_REROUTE_ENABLED=0` disables the server feature;
`HEATMIND_XGBOOST_ENABLED=0` keeps suggestions running on existing physics and
traffic without ML. Configuration values are bounded and invalid values fall back
to defaults. Traffic provider caches (up to five minutes) and weather caches (up to
30 minutes) still apply. A hidden or closed mobile browser may pause monitoring.

Real checks require a recent GPS update (within 30 seconds) with reported accuracy
at most 50 m. Once a trip has used real GPS, a lost fix pauses checks rather than
rerouting from a fabricated point. Explicit trip playback can use its preview
position, labelled as a preview in the notification. Reroute submits the latest
position and replans; a moved or stale trip cannot accept another trip's result.
Guidance continues through errors and timeouts.

## XGBoost setup and limits

From backend, using the backend virtual environment:

```powershell
python -m pip install -r requirements-ml.txt
python scripts/train_area_correction.py
```

Restart the backend. Generated models live in gitignored `backend/data/ml/`.
`HEATMIND_XGBOOST_MODEL_DIR` can select another compatible model directory.
The base requirements do not include XGBoost, so the existing application still
starts with neither this dependency nor these files. Missing packages/models,
incompatible features or area, invalid predictions and inference exceptions all
fall back atomically to the existing condition arrays.

No trained correction layer or measured training dataset existed in this checkout.
The added bootstrap script trains two XGBoost regressors on public mapped street
pieces across this Pune zone, using current and future weather, shade, road heat,
area coordinates and forecast horizon. Targets are **modelled** 15/30/60-minute
changes in feels-like heat and congestion. They imitate the existing forecast and
daily traffic curve; they are not sensor-calibrated corrections, live traffic
observations or proof of safer trips. No personal trip data is collected.

Validation holds out road edges and a time block. Metrics, feature order, area and
training provenance are written to `metadata.json`; errors are against modelled
targets, not measured accuracy. To improve real forecasting, retrain the same
feature contract with independent time-stamped street measurements and validate
on held-out dates and locations.

Inference blends a bounded residual into **copies** of the dynamic check's
forecasts. It does not add the already forecast warming twice, modify cached
physics frames or replace the product's three-hour heat prediction. Corrections
past 60 minutes fall back to physics. Traffic predictions never claim to be live,
reopen closures or slow walking speed. Existing mapped amenities and industrial
heat estimates are reused.

## Additive APIs

- `GET /api/routes/dynamic/settings`: non-secret feature thresholds.
- `POST /api/routes/dynamic/check`: `compare_id`, `route_id`, `position:{lat,lon}`;
  returns condition provenance and potential gains, with `comparison:null`.
- `POST /api/routes/dynamic/accept`: the same fields plus required `consent:true`;
  replans from the submitted current position and stores a new comparison only
  if the alternative still meets the improvement gates.

The existing compare, simulate, navigation, explanation and heat APIs keep their
signatures. The old automatic `/api/routes/recheck` endpoint is not restored.

Run checks from their respective backend/frontend directories:

```powershell
python -m unittest discover -s tests
node --loader ./scripts/ts-test-loader.mjs --test scripts/test-*.mjs
npx eslint components/hud/RouteUpdateNotice.tsx lib/dynamicRerouting.ts components/hud/NavHud.tsx
npm run build
```

Tests: backend unittest suite; frontend `test-dynamic-rerouting.mjs` covers opt-in,
no mutation on checks/decline, cooldown, explicit acceptance, stale results and
failure recovery. Backend tests cover bounded thresholds, model fallback, remaining
suffix, closure/pace invariants and consent validation.
