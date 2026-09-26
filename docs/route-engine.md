# Multi-algorithm route engine

Choose **Balanced**, **Fastest**, **Shortest**, or **Least heat** in the expanded route comparison. A route can earn several labels. Recommendations still explain their measurable trade-offs without an external AI API.

The engine reuses the existing OSM graph, persona heat scores, street heat forecasts and amenity priorities:

| Part | Algorithm / behaviour |
| --- | --- |
| Shortest | Dijkstra with street distance as the cost |
| Fastest | A* with estimated travel seconds; admissible great-circle lower bound |
| Cooler alternatives | Existing heat-weighted Dijkstra searches with different heat penalties |
| Compare trade-offs | Pareto comparison of generated candidates: time, distance, heat dose and combined preference score |
| Balanced choice | Existing preference weights; detour no longer than fastest × 1.5 + 4 min and improvement at least 2 points |
| Classification | Explainable rules; no trained ML classifier yet |

“Least heat” applies to the generated candidates, not every possible path in the city. Exact time/distance searches apply to the available mapped graph and its modelled costs. Bus itineraries remain separate, with estimated service times and no automatic street rerouting while riding.

## Continuous navigation

**Auto reroute during navigation** is enabled by default and can be turned off. The monitor stays mounted when route cards are replaced by turn-by-turn guidance. While the page is open it:

1. Checks the remaining journey every 60 seconds, including while navigation is paused.
2. Uses a recent GPS fix (at most 30 seconds old, reported accuracy at most 50 m). A deviation over 45 m requests an earlier check, at most once per 10 seconds. A paced preview is explicitly labelled simulated navigation when real GPS is unavailable.
3. Reuses the planner from the current position, preserving the actual remaining suffix for a fair comparison. It checks updated weather, heat forecasts and available road-speed/closure samples.
4. Updates remaining guidance and ETA if the route is retained. It switches automatically when the selected objective has a meaningful gain, a sampled road closes, or a valid GPS fix is off-route. Small gains are ignored to reduce route oscillation.
5. Keeps guidance on errors, timeouts and stale responses. Turning monitoring off cancels the pending request. A manual check can still offer **Use updated route**.

Traffic observations are cached for up to five minutes; the weather provider cache lasts up to 30 minutes. Unobserved roads and future traffic use estimates. A sudden temperature or traffic change can only be detected once it reaches an available feed; this is not a continuous street-sensor measurement. A closed/backgrounded mobile browser may throttle or stop the monitor.

## Jury demonstration

Plan a trip, expand the comparison, switch objectives and point out the objective labels and route explanation. Select a less suitable alternative and press **Start**: the monitor checks whether a meaningful improvement warrants switching. During guidance, expand **Algorithms, live data & training** and use **Test +5°C (simulation)** to trigger a heat recheck. A heat spike does not guarantee a different route; the engine switches only when the comparison supports it. Use **Reset simulation** afterwards.

## Local training examples

Comparisons append aggregate route features to `backend/data/route_training.sqlite3`, a gitignored SQLite database capped at 10,000 examples. It stores mode/persona, modelled route metrics, traffic coverage and rule-derived objective/risk labels. It stores no coordinates, place names, user IDs or API keys. Logging failure never blocks routing.

Measured trip duration and heat exposure remain null. These examples can support a later clearly labelled imitation model; they do not prove measured safety or forecast accuracy. A genuinely validated Random Forest classifier/regressor needs suitable observed outcomes and separate held-out evaluation.

Checks: from `backend`, run `python -m unittest discover -s tests -v`. From `frontend` (Node 22.6+), run `node --experimental-strip-types --experimental-loader ./scripts/ts-test-loader.mjs --test scripts/test-live-routing.mjs scripts/test-route-recommendation.mjs`, then `npm run build`.
