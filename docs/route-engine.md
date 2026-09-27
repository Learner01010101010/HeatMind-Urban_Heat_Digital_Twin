# Route planning

The app generates street alternatives using distance-based Dijkstra, time-based A* and heat-weighted Dijkstra. It calculates travel time, heat exposure, shade, traffic, industrial waste-heat estimates and public rest/water access. Persona heat scoring and travel-mode access restrictions remain in use.

The planner recommends a route automatically. A lower preference score wins only if the detour stays within fastest time × 1.5 + 4 minutes and improves the score by at least two points. Route cards show the recommendation, alternatives and measured comparisons. Qwen3 through Ollama explains their trade-offs without changing the ranking.

Route-priority selection, automatic navigation monitoring, the live recheck endpoint, simulated traffic-jam rerouting and route-training logging have been removed. Navigation follows the route the user selected. The temperature and departure-time simulator remains a manual planning tool.

Optional [dynamic route suggestions](dynamic-rerouting.md) can now be enabled inside navigation. They use an isolated XGBoost condition layer with physics fallback and existing Dijkstra, and require explicit Reroute confirmation. They never switch automatically.

Available traffic observations are cached up to five minutes; unobserved roads use estimates. Industrial heat is modelled waste heat, not a live pollution measurement. Transit planning remains separate.
