"use client";

import { Check, ChevronLeft, ChevronRight, HeartPulse, Package, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Passport, type PassportDay } from "@/lib/api";
import { ensureUser, useHydrated } from "@/lib/hooks";
import { fmtDist, fmtTemp, riskColor } from "@/lib/heatColorScale";
import { personaOf } from "@/lib/personas";
import { usePrefs } from "@/lib/store";

const DANGER_C = 39; // matches risk_scoring.DANGER_C

/** Colour for "minutes used out of the daily limit": calm → amber → red. */
function budgetColor(pct: number) {
  if (pct >= 100) return "#ef4444";
  if (pct >= 75) return "#fb8a1f";
  if (pct >= 50) return "#facc15";
  return "#34e2c6";
}

function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between mb-2.5">
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em] text-ink-400">{children}</h2>
      {aside}
    </div>
  );
}

function Today({ data }: { data: Passport }) {
  const t = data.today;
  const budget = data.daily_budget_min;
  const used = Math.round(t.minutes_exposed);
  const pct = (t.minutes_exposed / budget) * 100;
  const col = budgetColor(pct);
  const left = Math.max(0, budget - used);

  return (
    <section className="glass rounded-2xl p-5">
      <div className="flex items-baseline gap-2">
        <span className="text-[44px] font-bold tracking-tight tabular leading-none" style={{ color: col }}>
          {used}
        </span>
        <span className="text-[15px] text-ink-300">of {budget} min in danger heat</span>
      </div>

      <div className="relative mt-4 h-2.5 rounded-full bg-white/[0.07] overflow-hidden">
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.min(100, pct)}%`, background: col }} />
      </div>
      <p className="text-[13px] text-ink-300 mt-2.5">
        {t.trips === 0
          ? "Nothing logged today."
          : pct >= 100
            ? `Over today's limit by ${used - budget} min. Keep the rest of today's trips short and shaded.`
            : `${left} min left before you reach today's limit.`}
      </p>

      <dl className="grid grid-cols-3 mt-5 pt-4 border-t hairline text-center">
        <div>
          <dt className="text-[11.5px] text-ink-400">Trips</dt>
          <dd className="text-[20px] font-semibold tabular mt-0.5">{t.trips}</dd>
        </div>
        <div className="border-x hairline">
          <dt className="text-[11.5px] text-ink-400">In shade</dt>
          <dd className="text-[20px] font-semibold tabular mt-0.5">{t.pct_shaded == null ? "–" : `${Math.round(t.pct_shaded)}%`}</dd>
        </div>
        <div>
          <dt className="text-[11.5px] text-ink-400">Water / rest stops</dt>
          <dd className="text-[20px] font-semibold tabular mt-0.5">{t.rest_stops}</dd>
        </div>
      </dl>

      {t.trips === 0 && (
        <Link href="/" className="press mt-4 flex items-center justify-between rounded-xl bg-white/[0.05] hover:bg-white/[0.08] px-4 h-12 text-[14px] font-medium">
          Plan a trip on the map
          <ChevronRight size={17} className="text-ink-400" />
        </Link>
      )}
    </section>
  );
}

function WeekChart({ days, budget }: { days: PassportDay[]; budget: number }) {
  const max = Math.max(budget * 1.15, ...days.map((d) => d.minutes_exposed));
  const budgetY = (budget / max) * 100;
  return (
    <div>
      <div className="flex justify-end gap-4 mb-3 text-[11px] text-ink-400">
        <span className="flex items-center gap-1.5">
          <span className="w-4 border-t border-dashed border-white/40" /> daily limit ({budget} min)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-[#ef4444]" /> over limit
        </span>
      </div>
      <div className="relative h-36">
        <div className="absolute inset-x-0 border-t border-dashed border-white/25" style={{ bottom: `${budgetY}%` }} />
        <div className="absolute inset-0 flex items-end gap-2.5">
          {days.map((d, i) => {
            const isToday = i === days.length - 1;
            const h = d.trips ? Math.max(3, (d.minutes_exposed / max) * 100) : 0;
            return (
              <div key={d.date} className="flex-1 h-full flex flex-col items-center justify-end" title={`${d.weekday}: ${d.minutes_exposed} min in danger heat, ${d.trips} trips`}>
                {d.trips > 0 && <span className="text-[10.5px] text-ink-300 tabular mb-1">{Math.round(d.minutes_exposed)}</span>}
                <div
                  className="w-full max-w-[28px] rounded-[4px]"
                  style={{ height: `${h}%`, background: d.within_budget ? "#34e2c6" : "#ef4444", opacity: isToday ? 1 : 0.7 }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex gap-2.5 mt-2 pt-2 border-t hairline">
        {days.map((d, i) => (
          <span key={d.date} className={`flex-1 text-center text-[11px] ${i === days.length - 1 ? "text-ink-100 font-semibold" : "text-ink-400"}`}>
            {i === days.length - 1 ? "Today" : d.weekday}
          </span>
        ))}
      </div>
    </div>
  );
}

function weekSentence(data: Passport) {
  const active = data.days.filter((d) => d.trips > 0);
  const under = active.filter((d) => d.within_budget).length;
  if (!active.length) return "No trips logged in the last 7 days.";
  const parts = [`Under your limit on ${under} of ${active.length} day${active.length === 1 ? "" : "s"} with trips.`];
  if (data.streak_days >= 2) parts.push(`That's ${data.streak_days} days running.`);
  return parts.join(" ");
}

export default function PassportPage() {
  const hydrated = useHydrated();
  const persona = usePrefs((s) => s.persona);
  const units = usePrefs((s) => s.units);
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
      .catch(() => alive && setErr("Couldn't load your passport. Is the backend running on :8000?"));
    return () => {
      alive = false;
    };
  }, [hydrated, persona, nonce]);

  // Only computed once data has loaded on the client, so it never mismatches the server render.
  const today = data ? new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) : " ";
  const alert = data?.clinical_alert;
  const rest = data?.rest_compliance;

  return (
    <main className="min-h-dvh pb-28 md:pb-16">
      <div className="max-w-[680px] mx-auto px-4 md:px-6 py-6 space-y-7">
        <Link href="/" className="press inline-flex items-center gap-1 text-[15px] text-cool-300 font-medium">
          <ChevronLeft size={20} /> Map
        </Link>

        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight">Heat Passport</h1>
            <p className="text-[14px] text-ink-400 mt-1">{today}</p>
          </div>
          <span className="flex items-center gap-2 rounded-full px-3 h-8 text-[13px] font-medium shrink-0" style={{ background: `${p.accent}1a`, color: p.accent }}>
            <p.icon size={15} /> {p.label}
          </span>
        </header>

        {err && <div className="rounded-2xl bg-red-500/10 p-4 text-red-200 text-sm">{err}</div>}
        {!data && !err && (
          <div className="space-y-3">
            <div className="skeleton h-52 rounded-2xl" />
            <div className="skeleton h-48 rounded-2xl" />
          </div>
        )}

        {data && (
          <div className="space-y-7 fade-in">
            {alert && alert.level !== "none" && (
              <section className="rounded-2xl p-4 border-l-4 bg-white/[0.035]" style={{ borderColor: alert.color }} role="alert">
                <div className="flex items-center gap-2 font-semibold text-[15px]" style={{ color: alert.color }}>
                  <HeartPulse size={17} /> {alert.label}
                  <span className="ml-auto text-[12px] font-normal text-ink-400 tabular">
                    feels like {fmtTemp(alert.persona_adjusted_feels_c, units)} for you
                  </span>
                </div>
                <p className="text-[13.5px] text-ink-200 mt-1.5 leading-relaxed">{alert.advice}</p>
              </section>
            )}

            <div>
              <SectionTitle>Today</SectionTitle>
              <Today data={data} />
            </div>

            {rest && rest.minutes_exposed > 0 && (
              <section className="glass rounded-2xl p-4 flex items-start gap-3">
                <Package size={18} className="mt-0.5 shrink-0" style={{ color: rest.compliant ? "#34e2c6" : "#fb8a1f" }} />
                <div className="flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-[15px] font-semibold">Rest breaks</h3>
                    <span className="text-[14px] font-semibold tabular" style={{ color: rest.compliant ? "#34e2c6" : "#fb8a1f" }}>
                      {rest.breaks_taken} of {rest.breaks_required}
                    </span>
                  </div>
                  <p className="text-[13px] text-ink-300 mt-1 leading-relaxed">
                    {rest.message} One break is due for every {rest.interval_min} min in danger heat.
                  </p>
                </div>
              </section>
            )}

            <div>
              <SectionTitle>Last 7 days</SectionTitle>
              <section className="glass rounded-2xl p-5">
                <p className="text-[14px] text-ink-200 mb-5">{weekSentence(data)}</p>
                <WeekChart days={data.days} budget={data.daily_budget_min} />
                <dl className="grid grid-cols-2 sm:grid-cols-4 gap-y-3 mt-5 pt-4 border-t hairline text-[13px]">
                  <div>
                    <dt className="text-ink-400">Danger heat</dt>
                    <dd className="font-semibold tabular">{Math.round(data.week.minutes_exposed)} min</dd>
                  </div>
                  <div>
                    <dt className="text-ink-400">Shaded distance</dt>
                    <dd className="font-semibold tabular">
                      {data.week.shaded_km} / {data.week.distance_km} km
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-400">Water / rest stops</dt>
                    <dd className="font-semibold tabular">{data.week.rest_stops}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-400">Avg. trip risk</dt>
                    <dd className="font-semibold tabular">{data.week.trips ? `${Math.round(data.week.avg_risk)} / 100` : "–"}</dd>
                  </div>
                </dl>
              </section>
            </div>

            <div>
              <SectionTitle
                aside={
                  data.has_sample && (
                    <button
                      onClick={async () => {
                        await api.clearSample(data.user_id);
                        setNonce((n) => n + 1);
                      }}
                      className="press flex items-center gap-1.5 text-[13px] text-cool-300"
                    >
                      <Trash2 size={13} /> Remove sample trips
                    </button>
                  )
                }
              >
                Trip log
              </SectionTitle>
              <div className="glass rounded-2xl divide-y divide-white/[0.06]">
                {data.recent.length === 0 && (
                  <div className="p-5 text-[14px] text-ink-400">No trips yet. Pick a route on the map and tap “Start trip” to log it here.</div>
                )}
                {data.recent.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-[14.5px] font-medium truncate">
                        {t.trip_label}
                        {t.is_sample ? <span className="ml-2 text-[10.5px] text-ink-500">(sample)</span> : null}
                      </div>
                      <div className="text-[12.5px] text-ink-400 tabular">
                        {new Date(t.logged_at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })} · {fmtDist(t.distance_m)} ·{" "}
                        {Math.round(t.minutes_total)} min · {Math.round(t.pct_shaded)}% shade
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[15px] font-semibold tabular" style={{ color: riskColor(t.heat_risk_score) }}>
                        {Math.round(t.heat_risk_score)}
                      </div>
                      <div className="text-[10.5px] text-ink-500">risk</div>
                    </div>
                  </div>
                ))}
              </div>
              {data.has_sample && (
                <p className="text-[12px] text-ink-500 mt-2">Sample trips are generated so a new passport isn&apos;t empty. They count toward the charts until removed.</p>
              )}
            </div>

            <div>
              <SectionTitle>This week&apos;s goals</SectionTitle>
              <ul className="glass rounded-2xl divide-y divide-white/[0.06]">
                {data.badges.map((b) => (
                  <li key={b.id} className="flex items-center gap-3 px-4 py-3">
                    <span
                      className={`grid place-items-center w-5 h-5 rounded-full shrink-0 ${b.earned ? "bg-cool-400 text-ink-950" : "border border-ink-500"}`}
                      aria-label={b.earned ? "done" : "not done"}
                    >
                      {b.earned && <Check size={13} strokeWidth={3} />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className={`text-[14px] ${b.earned ? "text-ink-100" : "text-ink-200"}`}>{b.name}</div>
                      <div className="text-[12px] text-ink-500">{b.desc}</div>
                    </div>
                    {!b.earned && (
                      <div className="w-16 h-1.5 rounded-full bg-white/[0.07] overflow-hidden shrink-0">
                        <div className="h-full bg-ink-300" style={{ width: `${Math.round(b.progress * 100)}%` }} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <p className="text-[12px] text-ink-500 leading-relaxed">
              “Danger heat” means a heat index of {fmtTemp(DANGER_C, units)} or higher. Your daily limit of {data.daily_budget_min} min is set by the{" "}
              {p.label.toLowerCase()} profile. Trips are stored under an anonymous session. Nothing is tracked unless you log a trip.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
