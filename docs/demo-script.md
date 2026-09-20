# HeatMind AI — 4½-minute demo script (TSSM BSCOER, Narhe, Pune)

Pre-flight: backend + frontend running, scenario pill = **Heatwave demo**, persona = **Student**, browser full-screen.

| Time | Do | Say |
|---|---|---|
| 0:00 | Open the twin (`/`) zoomed on campus. | "Every route planner tells you the fastest way somewhere. None of them know that this road is 10 degrees hotter than the one next to it." |
| 0:30 | Point at the **One city number vs. the streets** card, then tap the **Hottest street** chip (NH48 bypass) and the **Coolest street** chip (Jambhulwadi Lake). Click anywhere on the map to probe a cell. | "Weather apps say 42°C. At street level the same campus ranges from 45 to 55°C feels-like. That comes from surface material, tree canopy, building shadow and traffic heat, computed every 10 metres on real OpenStreetMap geometry." |
| 1:15 | Tap **Demo trip: TSSM → Temple**. Switch persona to **Senior** from the top-right badge. | "Same streets, different body. Route A is one minute slower but has 50% more shade, so the risk score drops by 5 points for a student and by 8 for a senior." |
| 1:45 | Open Route A → **Why this score** + **Factor breakdown** + **Street by street**. Drag the **Time vs. exposure** slider. | "Every number comes with a reason. Here are the six factors, weighted for this persona. The table is public at /api/risk/weights." |
| 2:15 | Press ▶ on **Future heat** (or drag to +1h). | "Heat isn't static. The sun moves, shadows move, and the scores update in place. This is a physics-informed nowcast for the next two hours, so you can ask 'leave now or leave later?'" |
| 3:00 | Select **Route B (Fastest)**, open **Simulate** → **Heat advisory (+5°C)**. | "Now a heat advisory hits. The system re-scores live and tells me to switch to the shaded route." |
| 3:40 | Route A detail → **Start & log trip** → open **Passport**. | "Heat exposure is cumulative, so we track it the way fitness apps track steps: minutes in danger heat against a daily budget, shaded distance, streaks." |
| 4:15 | Open **How it works** (provenance table). | "Real geometry, a modelled heat surface, and we're transparent about which is which. Five engines, one twin, and it scales from one campus to a whole city." |

**Judge Q&A crib**
- *Is it really AI?* The MVP is a physics-informed nowcast: solar ephemeris, a shadow ray-marcher, and a surface-energy model calibrated on weather data. Phase 2 learns per-cell residuals from Landsat/Sentinel-3 LST. Explanations are rule-based by default, with an optional LLM polish when `ANTHROPIC_API_KEY` is set.
- *What's synthetic?* Tree canopy (OSM has almost no tree survey here), heights for buildings without levels tags, seeded water/rest points, and the heat surface itself. Streets, buildings, land use, the lake, amenities and sun position are real.
- *Offline?* The demo scenario needs no network. Live mode falls back to Pune climatology if Open-Meteo is unreachable.
