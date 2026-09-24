"use client";

import { AlertTriangle, ChevronLeft, MapPin, Printer } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import Logo from "@/components/shell/Logo";
import { api, type PlannerReport } from "@/lib/api";
import { fmtTemp, heatColor } from "@/lib/heatColorScale";
import { useMeta } from "@/lib/hooks";
import { SCENARIO, usePrefs } from "@/lib/store";

/** SDG 11 — Municipal Heat Action Brief: ranked worst-exposure streets, exportable via print. */
export default function PlannerPage() {
  const meta = useMeta();
  const units = usePrefs((s) => s.units);
  const [report, setReport] = useState<PlannerReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    api
      .plannerReport({ scenario: SCENARIO, top_n: 15 })
      .then((r) => !dead && setReport(r))
      .finally(() => !dead && setLoading(false));
    return () => {
      dead = true;
    };
  }, []);

  const maxPriority = report?.streets[0]?.priority_score || 1;

  return (
    <main className="min-h-dvh pb-28 md:pb-16">
      <div className="max-w-4xl mx-auto px-4 md:px-8 py-8 space-y-8 print:max-w-none print:px-0">
        <div className="flex items-center justify-between print:hidden">
          <Link href="/" className="press inline-flex items-center gap-1 text-[15px] text-cool-300 font-medium">
            <ChevronLeft size={20} /> Map
          </Link>
          <button
            onClick={() => window.print()}
            className="press glass flex items-center gap-2 rounded-full h-10 px-4 text-[13px] font-semibold text-ink-100"
          >
            <Printer size={15} /> Print / Save as PDF
          </button>
        </div>

        <header className="flex items-start gap-4">
          <Logo size={48} />
          <div>
            <div className="text-[12px] font-bold uppercase tracking-wider" style={{ color: "#fd9d24" }}>
              Municipal planner · SDG 11
            </div>
            <h1 className="text-3xl md:text-4xl font-extrabold text-ink-100 tracking-tight">Heat Action Brief</h1>
            <p className="text-ink-300 mt-2 max-w-2xl">
              {meta.data?.zone.name ?? "South Pune"} — streets ranked by pedestrian heat-exposure priority, generated from the live digital twin.
              {report && <> Generated {new Date(report.generated_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.</>}
            </p>
          </div>
        </header>

        {loading || !report ? (
          <div className="skeleton h-96 rounded-2xl" />
        ) : (
          <>
            <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { label: "City feels-like", value: fmtTemp(report.city_stats.city_level_feels_c, units) },
                { label: "Street max", value: fmtTemp(report.city_stats.street_max_c, units) },
                { label: "Above high-heat", value: `${report.city_stats.pct_above_high}%` },
                { label: "Shaded (walkable)", value: `${report.city_stats.pct_shaded}%` },
              ].map((s) => (
                <div key={s.label} className="glass rounded-2xl p-4">
                  <div className="text-[10.5px] uppercase tracking-wider text-ink-400 font-bold">{s.label}</div>
                  <div className="text-2xl font-extrabold text-ink-100 tabular mt-1">{s.value}</div>
                </div>
              ))}
            </section>

            <section className="glass rounded-2xl p-5 flex gap-3 items-start" style={{ background: "rgba(253,157,36,.06)" }}>
              <AlertTriangle size={18} style={{ color: "#fd9d24" }} className="shrink-0 mt-0.5" />
              <p className="text-[13px] text-ink-200 leading-relaxed">
                <strong className="text-ink-100">Priority streets below are ranked for intervention</strong>, not just for information — the top of this
                list is where tree planting, cool pavement or shade structures would do the most good per metre of street. Try any of them in the{" "}
                <Link href="/" className="text-cool-300 underline underline-offset-2">
                  Intervention Simulator
                </Link>
                .
              </p>
            </section>

            <section>
              <h2 className="text-xl font-extrabold text-ink-100 mb-3">Ranked by exposure priority</h2>
              <div className="glass rounded-2xl overflow-hidden">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-left text-ink-400 text-[10.5px] uppercase tracking-wider border-b border-white/5">
                      <th className="p-3 font-bold w-8">#</th>
                      <th className="p-3 font-bold">Street</th>
                      <th className="p-3 font-bold text-right">Length</th>
                      <th className="p-3 font-bold text-right">Feels-like</th>
                      <th className="p-3 font-bold text-right">Shaded</th>
                      <th className="p-3 font-bold w-32">Priority</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.streets.map((s, i) => (
                      <tr key={s.name + i} className="border-t border-white/5">
                        <td className="p-3 text-ink-400 tabular">{i + 1}</td>
                        <td className="p-3">
                          <div className="font-semibold text-ink-100 flex items-center gap-1.5">
                            <MapPin size={12} className="text-ink-500 shrink-0" /> {s.name}
                          </div>
                          <div className="text-[11px] text-ink-500 capitalize">{s.highway.replace(/_/g, " ")}</div>
                        </td>
                        <td className="p-3 text-right tabular text-ink-300">{s.length_m} m</td>
                        <td className="p-3 text-right tabular font-semibold" style={{ color: heatColor(s.mean_feels_c) }}>
                          {fmtTemp(s.mean_feels_c, units)}
                        </td>
                        <td className="p-3 text-right tabular text-ink-300">{s.shaded_pct}%</td>
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 rounded-full bg-ink-700 overflow-hidden min-w-[40px]">
                              <div className="h-full rounded-full" style={{ width: `${(s.priority_score / maxPriority) * 100}%`, background: "linear-gradient(90deg,#fd9d24,#ef4444)" }} />
                            </div>
                            <span className="tabular text-ink-300 text-[11px] w-8 text-right">{s.priority_score}</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="text-[11.5px] text-ink-500 leading-relaxed">
              <strong className="text-ink-400">Methodology:</strong> {report.methodology} Weather at generation time: {report.weather.air_c}°C air,{" "}
              {report.weather.rh}% RH, source: {report.weather.source.replace(/_/g, " ")}.
            </section>
          </>
        )}
      </div>
    </main>
  );
}
