"use client";

import { Award, ChevronLeft, ChevronRight, Clock3, Droplets, Flame, Footprints, Gauge, HeartPulse, Package, Route as RouteIcon, Sparkles, Sun, TreePine, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Passport, type PassportDay } from "@/lib/api";
import { ensureUser, useHydrated } from "@/lib/hooks";
import { fmtDist, riskColor } from "@/lib/heatColorScale";
import { personaOf } from "@/lib/personas";
import { usePrefs } from "@/lib/store";
import AnimatedNumber from "@/components/ui/AnimatedNumber";

// Apple-Health-style category colours
const C = {
  exposure: "#ff375f",
  shade: "#30d7b4",
  hydrate: "#0a84ff",
  trips: "#ff9f0a",
  risk: "#ffd60a",
  streak: "#bf5af2",
};

function Ring({ r, stroke, pct, color, delay }: { r: number; stroke: number; pct: number; color: string; delay: number }) {
  const c = 2 * Math.PI * r;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setShown(pct), 80 + delay);
    return () => clearTimeout(t);
  }, [pct, delay]);
  const p = Math.min(shown, 1);
  return (
    <>
      <circle cx="100" cy="100" r={r} stroke={color} strokeOpacity={0.18} strokeWidth={stroke} fill="none" />
      <circle
        cx="100"
        cy="100"
        r={r}
        stroke={color}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - p)}
        style={{ transition: "stroke-dashoffset 1.4s cubic-bezier(.16,1,.3,1)", filter: `drop-shadow(0 0 8px ${color}88)` }}
      />
    </>
  );
}

function Sparkbars({ values, color, max }: { values: number[]; color: string; max?: number }) {
  const m = max ?? Math.max(...values, 1);
  return (
    <div className="flex items-end gap-[3px] h-9 w-[76px]" aria-hidden>
      {values.map((v, i) => (
        <span key={i} className="flex-1 rounded-full" style={{ height: `${Math.max(8, (v / m) * 100)}%`, background: color, opacity: i === values.length - 1 ? 1 : 0.4 }} />
      ))}
    </div>
  );
}

function MetricRow({ icon: I, label, color, value, unit, series, max, note }: { icon: React.ElementType; label: string; color: string; value: number; unit: string; series: number[]; max?: number; note?: string }) {
  return (
    <div className="flex items-center gap-4 rounded-[22px] bg-white/[0.045] px-5 py-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color }}>
          <I size={14} fill={color} fillOpacity={0.25} />
          {label}
          <span className="ml-auto text-[12px] font-normal text-ink-400">{note ?? "Today"}</span>
        </div>
        <div className="mt-1.5 flex items-baseline gap-1.5">
          <span className="text-[30px] font-semibold tracking-[-0.03em] tabular">
            <AnimatedNumber value={value} duration={900} />
          </span>
          <span className="text-[14px] text-ink-400 font-medium">{unit}</span>
        </div>
      </div>
      <Sparkbars values={series} color={color} max={max} />
    </div>
  );
}

function TrendChart({ days, budget }: { days: PassportDay[]; budget: number }) {
  const peak = Math.max(...days.map((d) => d.minutes_exposed), 1);
  const max = peak * 1.25;
  const avg = days.reduce((a, d) => a + d.minutes_exposed, 0) / days.length;
  const showBudget = budget <= max;
  return (
    <div>
      <div className="relative h-40 flex items-end gap-3 pt-6">
        {showBudget && (
          <div className="absolute inset-x-0 border-t border-dashed border-[#ff375f]/50" style={{ bottom: `${(budget / max) * 100}%` }}>
            <span className="absolute right-0 -top-5 text-[10.5px] text-[#ff7a93]">budget {budget}m</span>
          </div>
        )}
        <div className="absolute inset-x-0 border-t border-white/15" style={{ bottom: `${(avg / max) * 100}%` }}>
          <span className="absolute left-0 -top-5 text-[10.5px] text-ink-400">avg {Math.round(avg)}m</span>
        </div>
        {days.map((d, i) => (
          <div key={d.date} className="relative flex-1 flex flex-col items-center justify-end h-full">
            <div
              className="w-full max-w-[18px] rounded-t-full rounded-b-[4px] rise-in"
              style={{
                height: `${Math.max(2, (d.minutes_exposed / max) * 100)}%`,
                background: d.minutes_exposed > budget ? "linear-gradient(#ff375f,#b3123a)" : "linear-gradient(#ff8fa6,#ff375f)",
                opacity: i === days.length - 1 ? 1 : 0.8,
                animationDelay: `${i * 50}ms`,
              }}
              title={`${d.minutes_exposed} min in danger heat`}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-3 mt-2">
        {days.map((d, i) => (
          <span key={d.date} className={`flex-1 text-center text-[11px] ${i === days.length - 1 ? "text-ink-100 font-semibold" : "text-ink-400"}`}>
            {i === days.length - 1 ? "Today" : d.weekday.slice(0, 1)}
          </span>
        ))}
      </div>
      {!showBudget && <p className="text-[11.5px] text-ink-400 mt-3">Every day stayed well under your {budget}-minute budget.</p>}
    </div>
  );
}

export default function PassportPage() {
  const hydrated = useHydrated();
  const persona = usePrefs((s) => s.persona);
  const [data, setData] = useState<Passport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const p = personaOf(persona);

  useEffect(() => {
    if (!hydrated) return;
    let alive = true;
    ensureUser()
      .then((uid) => api.passport(uid))
      .then((d) => alive && (setData(d), setErr(null)))
      .catch(() => alive && setErr("Couldn't reach the HeatMind engine on :8000."));
    return () => {
      alive = false;
    };
  }, [hydrated, persona, nonce]);

  // Only computed once data has loaded on the client, so it never mismatches the server render.
  const today = data ? new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) : " ";

  return (
    <main className="min-h-dvh bg-black pb-28 md:pb-16">
      <div className="max-w-[720px] mx-auto px-5">
        {/* nav */}
        <div className="sticky top-0 z-20 -mx-5 px-5 pt-[max(12px,env(safe-area-inset-top))] pb-3 bg-black/70 backdrop-blur-xl flex items-center justify-between">
          <Link href="/" className="press flex items-center gap-1 text-[15px] text-[#0a84ff] font-medium">
            <ChevronLeft size={20} /> Map
          </Link>
          <span className="grid place-items-center w-9 h-9 rounded-full" style={{ background: `${p.accent}22`, color: p.accent }}>
            <p.icon size={17} />
          </span>
        </div>

        <header className="mt-2 mb-6">
          <div className="text-[13px] font-semibold uppercase tracking-wide text-ink-400">{today}</div>
          <h1 className="text-[40px] font-bold tracking-[-0.03em] leading-tight">Summary</h1>
        </header>

        {err && <div className="rounded-[22px] bg-red-500/10 p-4 text-red-200 text-sm">{err}</div>}
        {!data && !err && (
          <div className="space-y-3">
            <div className="skeleton h-64 rounded-[26px]" />
            <div className="skeleton h-24 rounded-[22px]" />
            <div className="skeleton h-24 rounded-[22px]" />
          </div>
        )}

        {data && (
          <div className="space-y-8 fade-in">
            {/* clinical heat alert — SDG 3 */}
            {data.clinical_alert.level !== "none" && (
              <section
                className="rounded-[26px] p-5 flex gap-3.5 items-start"
                style={{ background: `${data.clinical_alert.color}14`, boxShadow: `inset 0 0 0 1.5px ${data.clinical_alert.color}55` }}
                role="alert"
              >
                <span className="grid place-items-center w-11 h-11 rounded-full shrink-0" style={{ background: `${data.clinical_alert.color}22`, color: data.clinical_alert.color }}>
                  <HeartPulse size={20} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[16px] font-bold" style={{ color: data.clinical_alert.color }}>
                      {data.clinical_alert.label}
                    </h2>
                    <span className="text-[11px] text-ink-400 tabular">
                      {data.clinical_alert.persona_adjusted_feels_c}°C persona-adjusted
                    </span>
                  </div>
                  <p className="text-[13px] text-ink-200 mt-1 leading-relaxed">{data.clinical_alert.advice}</p>
                  <p className="text-[10.5px] text-ink-500 mt-2">{data.clinical_alert.source}</p>
                </div>
              </section>
            )}

            {/* rest-break compliance — SDG 10, Delivery Rider persona */}
            {data.rest_compliance && (
              <section
                className="rounded-[26px] p-5 flex gap-3.5 items-start"
                style={{
                  background: data.rest_compliance.compliant ? "rgba(52,226,198,.08)" : "rgba(221,19,103,.1)",
                  boxShadow: `inset 0 0 0 1.5px ${data.rest_compliance.compliant ? "#34e2c655" : "#dd136755"}`,
                }}
              >
                <span
                  className="grid place-items-center w-11 h-11 rounded-full shrink-0"
                  style={{ background: data.rest_compliance.compliant ? "#34e2c622" : "#dd136722", color: data.rest_compliance.compliant ? "#34e2c6" : "#dd1367" }}
                >
                  <Package size={20} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[16px] font-bold" style={{ color: data.rest_compliance.compliant ? "#34e2c6" : "#dd1367" }}>
                      Rest-break compliance · SDG 10
                    </h2>
                    <span className="text-[11px] text-ink-400 tabular">
                      {data.rest_compliance.breaks_taken}/{data.rest_compliance.breaks_required} breaks
                    </span>
                  </div>
                  <p className="text-[13px] text-ink-200 mt-1 leading-relaxed">{data.rest_compliance.message}</p>
                  <p className="text-[10.5px] text-ink-500 mt-2">
                    Recommended: one rest/shade stop every {data.rest_compliance.interval_min} minutes of heat exposure — {data.rest_compliance.minutes_exposed} min exposed today.
                  </p>
                </div>
              </section>
            )}

            {/* heat rings */}
            <section>
              <h2 className="text-[22px] font-bold tracking-tight mb-3">Heat Rings</h2>
              <div className="rounded-[26px] bg-white/[0.045] p-5 flex flex-col sm:flex-row items-center gap-6">
                <svg viewBox="0 0 200 200" className="w-[190px] h-[190px] -rotate-90 shrink-0" role="img" aria-label="Today's heat rings">
                  <Ring r={84} stroke={20} pct={data.today.minutes_exposed / data.daily_budget_min} color={C.exposure} delay={0} />
                  <Ring r={61} stroke={20} pct={(data.today.pct_shaded ?? 0) / 60} color={C.shade} delay={120} />
                  <Ring r={38} stroke={20} pct={data.today.rest_stops / 4} color={C.hydrate} delay={240} />
                </svg>
                <div className="flex-1 w-full space-y-4">
                  {[
                    { l: "Heat exposure", v: Math.round(data.today.minutes_exposed), g: `${data.daily_budget_min} MIN`, c: C.exposure, hint: "minutes in danger heat · lower is better" },
                    { l: "Shade", v: Math.round(data.today.pct_shaded ?? 0), g: "60 %", c: C.shade, hint: "of today's distance in shade" },
                    { l: "Hydrate", v: data.today.rest_stops, g: "4 STOPS", c: C.hydrate, hint: "water & rest breaks" },
                  ].map((x) => (
                    <div key={x.l}>
                      <div className="text-[15px] font-semibold text-ink-100">{x.l}</div>
                      <div className="text-[26px] font-bold tracking-tight tabular leading-tight" style={{ color: x.c }}>
                        <AnimatedNumber value={x.v} duration={1000} />
                        <span className="text-[16px]">/{x.g}</span>
                      </div>
                      <div className="text-[11.5px] text-ink-400">{x.hint}</div>
                    </div>
                  ))}
                </div>
              </div>
              {!data.today.trips && (
                <Link href="/" className="press mt-3 flex items-center justify-between rounded-[22px] bg-white/[0.045] px-5 h-14 text-[15px] font-medium">
                  <span className="flex items-center gap-2">
                    <Sparkles size={16} className="text-cool-300" /> Plan today&apos;s first heat-safe trip
                  </span>
                  <ChevronRight size={18} className="text-ink-500" />
                </Link>
              )}
            </section>

            {/* highlights */}
            <section>
              <h2 className="text-[22px] font-bold tracking-tight mb-3">Highlights</h2>
              <div className="space-y-3">
                <div className="rounded-[22px] bg-white/[0.045] p-5">
                  <div className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: C.shade }}>
                    <TreePine size={14} /> Shaded Distance
                  </div>
                  <p className="text-[17px] font-semibold leading-snug mt-2">
                    You walked {data.week.shaded_km} km in shade this week — {Math.round(data.week.pct_shaded)}% of your distance.
                  </p>
                  <div className="mt-4 space-y-2">
                    <div className="flex items-center gap-3">
                      <span className="w-16 text-[12px] text-ink-400">Shade</span>
                      <div className="flex-1 h-3 rounded-full bg-white/[0.06] overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${Math.min(100, data.week.pct_shaded)}%`, background: C.shade }} />
                      </div>
                      <span className="w-14 text-right text-[13px] font-semibold tabular">{data.week.shaded_km} km</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="w-16 text-[12px] text-ink-400">Total</span>
                      <div className="flex-1 h-3 rounded-full bg-white/[0.12]" />
                      <span className="w-14 text-right text-[13px] font-semibold tabular text-ink-300">{data.week.distance_km} km</span>
                    </div>
                  </div>
                </div>
                <div className="rounded-[22px] bg-white/[0.045] p-5">
                  <div className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: C.exposure }}>
                    <Flame size={14} fill={C.exposure} fillOpacity={0.3} /> Heat Exposure
                  </div>
                  <p className="text-[17px] font-semibold leading-snug mt-2">
                    {data.streak_days >= 2
                      ? `${data.streak_days} days in a row within your ${data.daily_budget_min}-minute budget. Keep it cool.`
                      : `You spent ${Math.round(data.week.minutes_exposed)} minutes in danger-level heat this week.`}
                  </p>
                  <div className="mt-4">
                    <TrendChart days={data.days} budget={data.daily_budget_min} />
                  </div>
                </div>
              </div>
            </section>

            {/* all metrics */}
            <section>
              <h2 className="text-[22px] font-bold tracking-tight mb-3">This Week</h2>
              <div className="space-y-2.5">
                <MetricRow icon={Flame} label="Danger-heat minutes" color={C.exposure} value={Math.round(data.week.minutes_exposed)} unit="min" series={data.days.map((d) => d.minutes_exposed)} note="7 days" />
                <MetricRow icon={TreePine} label="Distance in shade" color={C.shade} value={Math.round(data.week.pct_shaded)} unit="%" series={data.days.map((d) => d.pct_shaded ?? 0)} max={100} note="7 days" />
                <MetricRow icon={RouteIcon} label="Trips" color={C.trips} value={data.week.trips} unit="trips" series={data.days.map((d) => d.trips)} note="7 days" />
                <MetricRow icon={Droplets} label="Water & rest stops" color={C.hydrate} value={data.week.rest_stops} unit="stops" series={data.days.map((d) => d.rest_stops)} note="7 days" />
                <MetricRow icon={Gauge} label="Average heat risk" color={C.risk} value={Math.round(data.week.avg_risk)} unit="/ 100" series={data.days.map((d) => d.heat_dose)} note="per trip" />
                <MetricRow icon={Sun} label="Heat-smart streak" color={C.streak} value={data.streak_days} unit="days" series={data.days.map((d) => (d.trips && d.within_budget ? 1 : 0.15))} max={1} note="current" />
              </div>
            </section>

            {/* awards */}
            <section>
              <h2 className="text-[22px] font-bold tracking-tight mb-3">Awards</h2>
              <div className="rounded-[26px] bg-white/[0.045] p-5 grid grid-cols-3 sm:grid-cols-5 gap-4">
                {data.badges.map((b, i) => {
                  const col = [C.shade, C.hydrate, C.trips, C.streak, C.exposure][i % 5];
                  return (
                    <div key={b.id} className="flex flex-col items-center text-center" title={b.desc}>
                      <div className="relative w-[68px] h-[68px]">
                        <svg viewBox="0 0 68 68" className="absolute inset-0 -rotate-90">
                          <circle cx="34" cy="34" r="30" stroke="rgba(255,255,255,.08)" strokeWidth="5" fill="none" />
                          <circle cx="34" cy="34" r="30" stroke={col} strokeWidth="5" fill="none" strokeLinecap="round" strokeDasharray={188.5} strokeDashoffset={188.5 * (1 - (b.earned ? 1 : b.progress))} style={{ transition: "stroke-dashoffset 1.2s cubic-bezier(.16,1,.3,1)" }} />
                        </svg>
                        <div className="absolute inset-[9px] rounded-full grid place-items-center" style={{ background: b.earned ? `radial-gradient(circle at 35% 30%, ${col}, ${col}55)` : "rgba(255,255,255,.04)" }}>
                          <Award size={22} className={b.earned ? "text-black/70" : "text-ink-500"} />
                        </div>
                      </div>
                      <div className={`text-[12px] font-semibold mt-2 leading-tight ${b.earned ? "text-ink-100" : "text-ink-400"}`}>{b.name}</div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* recent */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-[22px] font-bold tracking-tight">Recent Trips</h2>
                {data.has_sample && (
                  <button
                    onClick={async () => {
                      await api.clearSample(data.user_id);
                      setNonce((n) => n + 1);
                    }}
                    className="flex items-center gap-1.5 text-[13px] text-[#0a84ff]"
                  >
                    <Trash2 size={13} /> Remove samples
                  </button>
                )}
              </div>
              <div className="rounded-[22px] bg-white/[0.045] divide-y divide-white/[0.06]">
                {data.recent.length === 0 && <div className="p-5 text-[14px] text-ink-400">No trips yet — plan one on the map and tap “Start trip”.</div>}
                {data.recent.map((t) => (
                  <div key={t.id} className="flex items-center gap-3.5 px-5 py-3.5">
                    <span className="grid place-items-center w-10 h-10 rounded-full text-[13px] font-bold tabular" style={{ background: `${riskColor(t.heat_risk_score)}22`, color: riskColor(t.heat_risk_score) }}>
                      {Math.round(t.heat_risk_score)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] font-medium truncate flex items-center gap-2">
                        {t.trip_label}
                        {t.is_sample ? <span className="text-[10px] font-semibold uppercase rounded-full bg-white/[0.08] text-ink-400 px-1.5 py-0.5">sample</span> : null}
                      </div>
                      <div className="text-[12.5px] text-ink-400 flex gap-3 flex-wrap tabular">
                        <span className="flex items-center gap-1">
                          <Clock3 size={11} />
                          {new Date(t.logged_at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
                        </span>
                        <span className="flex items-center gap-1">
                          <Footprints size={11} /> {fmtDist(t.distance_m)}
                        </span>
                        <span style={{ color: C.shade }}>{Math.round(t.pct_shaded)}% shade</span>
                      </div>
                    </div>
                    <span className="text-[13px] text-ink-400 tabular">{Math.round(t.minutes_total)} min</span>
                  </div>
                ))}
              </div>
            </section>

            <p className="text-[12px] text-ink-500 text-center leading-relaxed">
              {p.label} · danger heat = NOAA heat index ≥ 39°C · stored under an anonymous session, no location tracking.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
