"use client";

import { Brain, ChevronLeft, Clock3, ExternalLink, Fingerprint, Moon, Route as RouteIcon, Stamp, Thermometer } from "lucide-react";
import Link from "next/link";
import Logo from "@/components/shell/Logo";
import { useMeta } from "@/lib/hooks";

const ENGINES = [
  {
    icon: Thermometer,
    title: "Urban Heat Digital Twin",
    body: "A 10 m raster of pedestrian feels-like temperature. It fuses OSM surface materials, building mass, tree canopy, traffic heat and lake cooling with NOAA heat index, instead of using one city-wide number.",
    api: "/api/heat/twin",
  },
  {
    icon: Moon,
    title: "AI Shadow Engine",
    body: "NOAA solar ephemeris gives the sun's elevation and azimuth. Every cell ray-marches toward the sun through building heights and tree canopy, so shade is computed rather than guessed. Building shadows are cast at h/tan(elevation).",
    api: "/api/shadow",
  },
  {
    icon: Clock3,
    title: "Future Heat Prediction",
    body: "A physics-informed nowcast from now to +3 h. The shadow engine is re-run for the future sun position, and ambient temperature is interpolated from the Open-Meteo hourly forecast. That answers the question \"leave now or later?\"",
    api: "/api/heat/predict?horizon=1h",
  },
  {
    icon: Fingerprint,
    title: "Personalized Heat Risk Engine",
    body: "Six transparent factors, each weighted per persona and scaled to 0–100. Speed, vulnerability shift and daily budget also differ by persona. The engine produces a real factor breakdown, not a cosmetic label swap.",
    api: "/api/risk/weights",
  },
  {
    icon: Stamp,
    title: "Digital Heat Passport",
    body: "Cumulative minutes in danger-level heat, shaded distance, rest stops, streaks and badges. It turns a one-off trip planner into a daily health habit.",
    api: "/api/passport/{user_id}",
  },
];

const STATUS: Record<string, string> = {
  real: "bg-emerald-400/15 text-emerald-300",
  mixed: "bg-sky-400/15 text-sky-300",
  estimated: "bg-amber-400/15 text-amber-300",
  modelled: "bg-fuchsia-400/15 text-fuchsia-300",
};

export default function About() {
  const meta = useMeta();
  const m = meta.data;
  const model = m?.risk_model;

  return (
    <main className="min-h-dvh pb-28 md:pb-16">
      <div className="max-w-5xl mx-auto px-4 md:px-8 py-8 space-y-10">
        <Link href="/" className="press inline-flex items-center gap-1 text-[15px] text-cool-300 font-medium">
          <ChevronLeft size={20} /> Map
        </Link>
        <header className="flex items-start gap-4">
          <Logo size={48} />
          <div>
            <div className="text-[12px] font-bold uppercase tracking-wider text-cool-300">How it works</div>
            <h1 className="text-3xl md:text-4xl font-extrabold text-ink-100 tracking-tight">Five engines, one twin</h1>
            <p className="text-ink-300 mt-2 max-w-2xl">
              HeatMind isn&apos;t a route planner with a heat filter bolted on. It&apos;s a living model of how heat moves through {m?.zone.name ?? "the TSSM BSCOER campus"}, and routing is just one of the things built on top of it.
            </p>
          </div>
        </header>

        <section className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
          {ENGINES.map((e) => (
            <article key={e.title} className="glass rounded-2xl p-5">
              <span className="grid place-items-center w-10 h-10 rounded-xl bg-cool-400/12 text-cool-300 mb-3">
                <e.icon size={19} />
              </span>
              <h2 className="font-extrabold text-ink-100">{e.title}</h2>
              <p className="text-[13px] text-ink-300 mt-1.5 leading-relaxed">{e.body}</p>
              <code className="block text-[11.5px] text-ink-400 mt-3">{e.api}</code>
            </article>
          ))}
          <article className="glass rounded-2xl p-5 bg-gradient-to-br from-heat-4/10 to-transparent">
            <span className="grid place-items-center w-10 h-10 rounded-xl bg-heat-4/15 text-heat-4 mb-3">
              <RouteIcon size={19} />
            </span>
            <h2 className="font-extrabold text-ink-100">Heat-aware routing</h2>
            <p className="text-[13px] text-ink-300 mt-1.5 leading-relaxed">
              Dijkstra over the real OSM street graph, with a sweep of heat-aversion weights and a penalty method, gives a Pareto set running from fastest to coolest. Walkers are modelled on the shady side of each street; cyclists on the carriageway.
            </p>
            <a href="/docs" className="inline-flex items-center gap-1 text-[12.5px] text-cool-300 font-bold mt-3 hover:underline">
              Open the live API docs <ExternalLink size={12} />
            </a>
          </article>
        </section>

        <section id="model" className="scroll-mt-6">
          <h2 className="text-xl font-extrabold text-ink-100 mb-1">Persona weighting model</h2>
          <p className="text-[13px] text-ink-400 mb-4">
            Score = 100 × Σ(weight × factor) ÷ Σ(weight). Each factor is normalised to 0–1 from time-weighted route data. The table below is served live from <code>/api/risk/weights</code>.
          </p>
          {model ? (
            <div className="overflow-x-auto glass rounded-2xl">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-ink-400 text-[11.5px] uppercase tracking-wider">
                    <th className="p-3 font-bold">Factor</th>
                    {Object.values(model.personas).map((p) => (
                      <th key={p.label} className="p-3 font-bold">
                        {p.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {model.factors.map((f) => (
                    <tr key={f.key} className="border-t border-white/5">
                      <td className="p-3 text-ink-200 font-semibold">{f.label}</td>
                      {Object.values(model.personas).map((p) => {
                        const w = p.weights[f.key];
                        return (
                          <td key={p.label} className="p-3">
                            <span className="inline-flex items-center gap-2">
                              <span className="w-12 h-1.5 rounded-full bg-ink-700 overflow-hidden">
                                <span className="block h-full bg-heat-4" style={{ width: `${w.value * 100}%` }} />
                              </span>
                              <span className="text-ink-300 tabular">{w.level}</span>
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr className="border-t border-white/5 text-ink-400">
                    <td className="p-3">Walking speed · vulnerability shift · daily budget</td>
                    {Object.values(model.personas).map((p) => (
                      <td key={p.label} className="p-3 tabular text-[12px]">
                        {p.speed_ms} m/s · {p.vulnerability_shift_c > 0 ? "+" : ""}
                        {p.vulnerability_shift_c}°C · {p.daily_budget_min} min
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <div className="skeleton h-64 rounded-2xl" />
          )}
        </section>

        <section>
          <h2 className="text-xl font-extrabold text-ink-100 mb-1">What&apos;s real, what&apos;s modelled</h2>
          <p className="text-[13px] text-ink-400 mb-4">We&apos;re upfront about data provenance. Real geometry sets the structure; a calibrated physics model fills in the heat.</p>
          <div className="glass rounded-2xl divide-y divide-white/5">
            {m?.provenance.map((p) => (
              <div key={p.layer} className="flex flex-wrap items-center gap-3 p-3.5">
                <span className="font-semibold text-ink-100 w-52">{p.layer}</span>
                <span className="flex-1 text-[13px] text-ink-300 min-w-48">{p.source}</span>
                <span className={`text-[11px] font-bold uppercase tracking-wide rounded-full px-2.5 py-1 ${STATUS[p.status]}`}>{p.status}</span>
              </div>
            ))}
          </div>
          {m && (
            <p className="text-[12px] text-ink-400 mt-3">
              Zone data: {m.zone.counts.roads} street ways, {m.zone.counts.buildings} buildings ({m.zone.counts.buildings_height_osm} with OSM heights), {m.zone.counts.trees_estimated} estimated canopy trees, {m.zone.counts.pois_osm + m.zone.counts.pois_seeded} cooling points
              {m.zone.osm_timestamp ? ` · OSM snapshot ${m.zone.osm_timestamp.slice(0, 10)}` : ""}.
            </p>
          )}
        </section>

        <section className="glass rounded-2xl p-5 flex gap-4 items-start">
          <Brain size={22} className="text-cool-300 shrink-0 mt-0.5" />
          <div>
            <h2 className="font-extrabold text-ink-100">Is this really AI?</h2>
            <p className="text-[13px] text-ink-300 mt-1 leading-relaxed">
              The MVP uses a physics-informed nowcast: solar geometry, a shadow ray-marcher and surface-energy heuristics, calibrated against weather data. It is deterministic, explainable and robust in a live demo. Phase 2 trains a gradient-boosted model on historical Landsat/Sentinel-3 land-surface temperature and weather series to learn the per-cell residuals. Explanations are rule-based by default, with an optional LLM polish
              {m?.llm_enabled ? " (enabled on this server)" : " (set ANTHROPIC_API_KEY to enable)"}.
            </p>
            <Link href="/" className="inline-block text-[13px] font-bold text-cool-300 mt-3 hover:underline">
              Back to the twin →
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
