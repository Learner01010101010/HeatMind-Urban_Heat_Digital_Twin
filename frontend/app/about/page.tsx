"use client";

import { Brain, ChevronLeft, Clock3, ExternalLink, Fingerprint, Moon, Route as RouteIcon, Stamp, Thermometer } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import Logo from "@/components/shell/Logo";
import { api, type OpenDataCatalog } from "@/lib/api";
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

const SDGS = [
  { n: 3, color: "#4C9F38", title: "Good Health & Well-being", body: "Persona-weighted heat risk scoring and the Heat Passport turn cumulative heat exposure into a trackable, actionable health signal." },
  { n: 6, color: "#26BDE2", title: "Clean Water & Sanitation", body: "Water and rest points are surfaced along every route, prioritising hydration access on hot days." },
  { n: 10, color: "#DD1367", title: "Reduced Inequalities", body: "Heat exposure isn't distributed equally — the Outdoor Worker persona models the disproportionate risk faced by people who can't choose to stay indoors." },
  { n: 11, color: "#FD9D24", title: "Sustainable Cities & Communities", body: "A street-by-street digital twin gives planners a tool to see exactly where a city retains heat, not just a citywide average." },
  { n: 13, color: "#3F7E44", title: "Climate Action", body: "The Intervention Simulator lets anyone test how trees, cool pavement or shade structures change a street's heat — real physics, not a slogan." },
  { n: 15, color: "#56C02B", title: "Life on Land", body: "Tree canopy is modelled as an active cooling input to the twin, making the case for canopy as climate infrastructure, not just landscaping." },
  { n: 17, color: "#19486A", title: "Partnerships for the Goals", body: "Every engine is exposed as an open, documented API — anyone building for a hotter city can build on this data instead of starting over." },
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
  const [catalog, setCatalog] = useState<OpenDataCatalog | null>(null);

  useEffect(() => {
    let dead = false;
    api.openDataCatalog().then((c) => !dead && setCatalog(c)).catch(() => {});
    return () => {
      dead = true;
    };
  }, []);

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

        <section>
          <h2 className="text-xl font-extrabold text-ink-100 mb-1">Open data · SDG 17</h2>
          <p className="text-[13px] text-ink-400 mb-4">
            Every engine behind this twin is a documented, CORS-open endpoint — researchers and municipalities can build on this data instead of
            starting over. Full interactive reference at{" "}
            <a href="/docs" target="_blank" rel="noreferrer" className="text-cool-300 underline underline-offset-2">
              /docs
            </a>
            .
          </p>
          {catalog ? (
            <div className="overflow-x-auto glass rounded-2xl">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-ink-400 text-[11px] uppercase tracking-wider border-b border-white/5">
                    <th className="p-3 font-bold">Dataset</th>
                    <th className="p-3 font-bold">Format</th>
                    <th className="p-3 font-bold">Provenance</th>
                    <th className="p-3 font-bold">Status</th>
                    <th className="p-3 font-bold">Endpoint</th>
                  </tr>
                </thead>
                <tbody>
                  {catalog.datasets.map((d) => (
                    <tr key={d.id} className="border-t border-white/5 align-top">
                      <td className="p-3">
                        <div className="font-semibold text-ink-100">{d.title}</div>
                        <div className="text-[11.5px] text-ink-400 mt-0.5 leading-snug max-w-[260px]">{d.description}</div>
                      </td>
                      <td className="p-3 text-ink-300 whitespace-nowrap">{d.format}</td>
                      <td className="p-3 text-ink-300 max-w-[200px]">{d.provenance}</td>
                      <td className="p-3">
                        <span className={`text-[10.5px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 whitespace-nowrap ${STATUS[d.status]}`}>{d.status}</span>
                      </td>
                      <td className="p-3">
                        <a href={d.endpoint} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-cool-300 font-mono text-[11.5px] hover:underline whitespace-nowrap">
                          {d.endpoint.split("?")[0]} <ExternalLink size={11} />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="skeleton h-48 rounded-2xl" />
          )}
          {catalog && <p className="text-[11.5px] text-ink-500 mt-3">{catalog.license}</p>}
        </section>

        <section>
          <h2 className="text-xl font-extrabold text-ink-100 mb-1">Built for the UN Sustainable Development Goals</h2>
          <p className="text-[13px] text-ink-400 mb-4">Urban heat isn&apos;t only a comfort problem — it&apos;s a health, equity and climate-adaptation problem. HeatMind is built against seven of the UN SDGs, not just the map on the homepage.</p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {SDGS.map((g) => (
              <article key={g.n} className="glass rounded-2xl p-4 flex gap-3">
                <span
                  className="grid place-items-center w-10 h-10 rounded-xl font-extrabold text-[15px] shrink-0"
                  style={{ background: `${g.color}26`, color: g.color }}
                  aria-hidden
                >
                  {g.n}
                </span>
                <div>
                  <div className="text-[10.5px] font-bold uppercase tracking-wider" style={{ color: g.color }}>
                    SDG {g.n}
                  </div>
                  <h3 className="font-bold text-ink-100 text-[13.5px] leading-tight mt-0.5">{g.title}</h3>
                  <p className="text-[12px] text-ink-300 mt-1 leading-snug">{g.body}</p>
                </div>
              </article>
            ))}
          </div>
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
