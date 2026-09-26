"use client";

import { ArrowRight, Download, Droplets, Loader2, RefreshCw, Sparkles, Trash2, TreePine } from "lucide-react";
import { useEffect, useState } from "react";
import { AREAS, cityLabApi, DEFAULT_COSTS, downloadText, KIND_COLORS, KIND_LABELS, money, type CoolingPlan, type LabArea, type LabCatalog, type LabKind, type LabMode, type LabProject } from "@/lib/cityLabApi";
import { PlanningMap, Stat } from "./LabVisuals";

export default function CoolingInvestment() {
  const [area, setArea] = useState<LabArea>("narhe");
  const [mode, setMode] = useState<LabMode>("demo");
  const [budget, setBudget] = useState(150000);
  const [costs, setCosts] = useState(DEFAULT_COSTS);
  const [data, setData] = useState<LabCatalog | null>(null);
  const [plan, setPlan] = useState<CoolingPlan | null>(null);
  const [active, setActive] = useState("site-1");
  const [kind, setKind] = useState<LabKind>("trees");
  const [after, setAfter] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    cityLabApi.catalog(area, mode, controller.signal).then((d) => { setData(d); setLoading(false); }).catch((e: Error) => { if (!controller.signal.aborted) { setError(e.message); setLoading(false); } });
    return () => controller.abort();
  }, [area, mode, reload]);
  const changeArea = (next: LabArea, nextMode: LabMode) => {
    setArea(next); setMode(nextMode); setLoading(true); setData(null); setPlan(null); setActive("site-1"); setError("");
  };
  const run = async (projects?: LabProject[]) => {
    setBusy(true); setError("");
    try { setPlan(await cityLabApi.plan(area, mode, budget, costs, projects, data?.time)); setDirty(false); setAfter(true); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not evaluate the plan."); }
    finally { setBusy(false); }
  };
  const projects = plan?.projects.map(({ site_id, kind }) => ({ site_id, kind })) ?? [];
  const site = data?.sites.find((s) => s.id === active);
  const choice = site && kind !== "water_refill" ? site.choices[kind] : null;
  const add = () => run([...projects.filter((p) => p.site_id !== active), { site_id: active, kind }]);
  const exportPlan = () => {
    if (!data || !plan) return;
    downloadText("heatmind-cooling-proposal.json", JSON.stringify({ area: data.area_name, scenario: mode, time: data.time, costs_are_assumptions: true, budget, costs, ...plan, modelling_note: data.note }, null, 2), "application/json");
  };

  return <div className="space-y-5">
    <div className="rounded-2xl border border-[#8ad8b0]/20 bg-[#8ad8b0]/5 p-4 text-sm text-ink-200">
      <strong className="text-[#8ad8b0]">Where should the city invest?</strong> Set a budget, compare cooling fixes and build a proposal on mapped streets. Every temperature change comes from the existing twin.
    </div>
    {plan && <div className="rounded-2xl border border-[#8ad8b0]/20 bg-[#8ad8b0]/5 p-4 flex flex-wrap items-center justify-between gap-3"><div><span className="text-xs text-ink-300">{money(plan.spent)} proposal · {plan.projects.length} projects</span><p className="text-xl font-semibold mt-1 tabular">{plan.before_c !== null ? <>{plan.before_c.toFixed(1)}°C <ArrowRight size={17} className="inline mx-2 text-ink-400" /><span className="text-[#8ad8b0]">{plan.after_c?.toFixed(1)}°C</span></> : "Access proposals only"}</p></div><p className="text-xs text-ink-300 max-w-xs">{plan.before_c !== null ? "Modelled feels-like average in selected patches. Remaining streets are unchanged." : "Water refills are proposals, with no temperature reduction assumed."}</p></div>}
    <div className="grid lg:grid-cols-[300px_1fr] gap-5 items-start">
      <aside className="glass rounded-3xl p-5 space-y-5 order-last lg:order-first">
        <div className="flex items-center gap-2"><TreePine size={18} className="text-[#8ad8b0]" /><h2 className="font-semibold">Investment settings</h2></div>
        <label className="block text-xs text-ink-300">Neighbourhood<select aria-label="Planning neighbourhood" value={area} disabled={busy || loading} onChange={(e) => changeArea(e.target.value as LabArea, mode)} className="mt-2 w-full rounded-xl bg-ink-800 p-3 text-sm text-ink-100">{Object.entries(AREAS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
        <label className="block text-xs text-ink-300">Conditions<select aria-label="Planning conditions" value={mode} disabled={busy || loading} onChange={(e) => changeArea(area, e.target.value as LabMode)} className="mt-2 w-full rounded-xl bg-ink-800 p-3 text-sm text-ink-100"><option value="demo">Demo heatwave · 1:30 PM</option><option value="live">Current live conditions</option></select></label>
        <div>
          <label htmlFor="lab-budget" className="text-xs text-ink-300">Available budget · INR</label>
          <input id="lab-budget" type="number" min="0" max="1000000" step="1000" value={budget} disabled={busy} onChange={(e) => { setBudget(Number(e.target.value)); setDirty(!!plan); }} className="mt-2 w-full rounded-xl bg-ink-800 p-3 text-xl font-semibold tabular" />
          <input aria-label="Adjust investment budget" type="range" min="0" max="1000000" step="5000" value={Math.max(0, Math.min(1000000, budget))} disabled={busy} onChange={(e) => { setBudget(Number(e.target.value)); setDirty(!!plan); }} className="w-full mt-3 accent-[#8ad8b0]" />
          <div className="flex justify-between text-[10px] text-ink-400"><span>₹0</span><span>₹10 lakh</span></div>
        </div>
        <details className="text-xs text-ink-300"><summary className="cursor-pointer">Edit assumed cost per project</summary><div className="space-y-3 mt-3">{Object.keys(costs).map((k) => <label key={k} className="block">{KIND_LABELS[k as LabKind]}<input aria-label={`${KIND_LABELS[k as LabKind]} unit cost`} type="number" min="1000" max="500000" step="1000" value={costs[k as LabKind]} disabled={busy} onChange={(e) => { setCosts({ ...costs, [k]: Number(e.target.value) }); setDirty(!!plan); }} className="mt-1 w-full rounded-lg bg-ink-800 p-2 tabular" /></label>)}</div></details>
        <p className="text-[11px] text-ink-400">Costs are demo assumptions, not vendor quotes. Cooling fixes represent a 20 m model radius; trees represent mature canopy.</p>
        <button disabled={busy || loading} onClick={() => { setLoading(true); setPlan(null); setError(""); setReload(reload + 1); }} className="text-xs text-ink-300 flex items-center gap-1.5 disabled:opacity-40"><RefreshCw size={12} />Refresh sites · clears proposal</button>
        <button disabled={!data || busy || loading} onClick={() => void run()} className="w-full rounded-xl bg-[#8ad8b0] text-ink-950 p-3 font-semibold text-sm flex justify-center items-center gap-2 disabled:opacity-40">{busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}{busy ? "Evaluating…" : "Suggest projects within budget"}</button>
        {plan && <button disabled={busy} onClick={() => void run(projects)} className="w-full rounded-xl border border-white/10 p-3 text-xs">Re-evaluate my selected projects</button>}
      </aside>
      <div className="space-y-4 min-w-0 order-first lg:order-last">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-xl font-semibold">See the cooling impact</h2><p className="text-xs text-ink-400 mt-1">{data ? `${data.area_name} · ${new Date(data.time).toLocaleString("en-IN", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST` : "Loading street candidates…"}</p></div>
          <div className="flex rounded-full bg-white/5 p-1" aria-label="Planning map comparison">{[false, true].map((v) => <button key={String(v)} aria-pressed={after === v} onClick={() => setAfter(v)} className={`px-4 py-2 text-xs rounded-full ${after === v ? "bg-white/15" : "text-ink-400"}`}>{v ? "After proposal" : "Before"}</button>)}</div>
        </div>
        <button disabled={!data || busy || loading} onClick={() => void run()} className="lg:hidden w-full rounded-xl bg-[#8ad8b0] text-ink-950 p-3 font-semibold text-sm disabled:opacity-40">{busy ? "Evaluating…" : `Suggest a ${money(budget)} plan`}</button>
        {loading ? <div className="skeleton rounded-2xl aspect-[4/3] grid place-items-center text-sm text-ink-400">Finding mapped hot streets…</div> : data ? <PlanningMap data={data} plan={plan} after={after} active={active} onSelect={setActive} /> : <div className="rounded-2xl border border-white/10 p-8">Street candidates unavailable. Switch conditions or try again.</div>}
        {mode === "demo" && <p className="text-[11px] text-[#ffc48a]">DEMO · Simulated afternoon heatwave, separate from the live map and weather.</p>}
        {site && <div className="glass rounded-2xl p-4 space-y-3">
          <div><div className="text-[10px] text-ink-400 uppercase tracking-wider">Candidate {active.replace("site-", "")}</div><h3 className="font-semibold mt-1">{site.name}</h3><p className="text-xs text-ink-300 mt-1">{site.before.feels_c.toFixed(1)}°C feels-like · {site.before.shaded_pct.toFixed(0)}% shade in the patch</p></div>
          <div className="flex flex-wrap gap-2">{Object.entries(KIND_LABELS).map(([k, label]) => <button key={k} onClick={() => setKind(k as LabKind)} aria-pressed={kind === k} className="rounded-xl border px-3 py-2 text-xs" style={{ borderColor: kind === k ? KIND_COLORS[k as LabKind] : "#ffffff15", color: kind === k ? KIND_COLORS[k as LabKind] : "#adaaa5" }}>{label}</button>)}</div>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="text-sm">{choice ? <span>{choice.before.feels_c.toFixed(1)}°C <ArrowRight size={14} className="inline mx-1 text-ink-400" /> <strong className="text-[#8ad8b0]">{choice.after.feels_c.toFixed(1)}°C</strong><span className="block text-[10px] text-ink-400 mt-1">Modelled patch average · {Math.max(0, -choice.delta_c).toFixed(1)}°C reduction</span></span> : <span className="flex items-start gap-2 text-[#77d9f5]"><Droplets size={16} />Proposed refill access only<span className="block text-[10px] text-ink-400">No temperature reduction assumed</span></span>}</div>
            <button disabled={busy || loading || dirty} onClick={() => void add()} className="rounded-xl bg-white/10 px-4 py-2.5 text-xs font-semibold disabled:opacity-40">{projects.some((p) => p.site_id === active) ? "Replace project" : "Add project"} · {money(costs[kind])}</button>
          </div>
        </div>}
      </div>
    </div>
    {error && <p role="alert" className="rounded-xl bg-red-400/10 border border-red-400/20 p-3 text-sm text-red-200">{error}</p>}
    {dirty && <p role="status" className="rounded-xl bg-[#ffc48a]/10 p-3 text-xs text-[#ffc48a]">Settings changed. Suggest a new plan or re-evaluate your projects to update these results.</p>}
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Stat label="Planned investment" value={money(plan?.spent ?? 0)} hint={`${money(plan?.remaining ?? budget)} unallocated`} />
      <Stat label="Cooling in selected patches" value={`${plan?.reduction_c.toFixed(2) ?? "0.00"}°C`} hint="Weighted average · model estimate" color="#8ad8b0" />
      <Stat label="Evaluated ground area" value={`${(plan?.evaluated_ground_m2 ?? 0).toLocaleString("en-IN")} m²`} hint="Separate model patches · not citywide" />
      <Stat label="Proposed water refills" value={plan?.proposed_water_points ?? 0} hint="Planning only · no facilities installed" color="#77d9f5" />
    </div>
    {plan && <section className="glass rounded-3xl p-5 space-y-4">
      <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Your proposal · {plan.projects.length} projects</h2><button onClick={exportPlan} className="text-xs text-ink-300 inline-flex items-center gap-1.5"><Download size={14} /> Export proposal</button></div>
      {plan.before_c !== null && <div className="rounded-2xl bg-[#8ad8b0]/5 p-4 flex flex-wrap items-center gap-5"><div><span className="block text-[10px] text-ink-400">Before investment</span><strong className="text-2xl tabular">{plan.before_c.toFixed(1)}°C</strong></div><ArrowRight size={20} className="text-ink-400" /><div><span className="block text-[10px] text-ink-400">After proposal</span><strong className="text-2xl tabular text-[#8ad8b0]">{plan.after_c?.toFixed(1)}°C</strong></div><span className="text-xs text-ink-300">Average feels-like in the selected patches</span></div>}
      {!plan.projects.length && <p className="text-sm text-ink-400">No cooling project fits this budget with a positive estimated benefit. Increase the budget or add a proposal manually.</p>}
      <div className="grid md:grid-cols-2 gap-3">{plan.projects.map((p) => <article key={p.site_id} className="rounded-2xl border border-white/10 p-3 flex gap-3 items-start"><span className="rounded-lg px-2 py-1 text-xs" style={{ background: `${KIND_COLORS[p.kind]}15`, color: KIND_COLORS[p.kind] }}>{p.site_id.replace("site-", "#")}</span><div className="min-w-0 flex-1"><h3 className="text-sm font-medium">{KIND_LABELS[p.kind]}</h3><p className="text-[11px] text-ink-400 mt-1 break-words">{p.name}</p><p className="text-xs mt-2">{money(p.cost)} · {p.result ? `${Math.max(0, -p.result.delta_c).toFixed(1)}°C modelled reduction` : "planned water access"}</p></div><button aria-label={`Remove project at ${p.site_id}`} disabled={busy || dirty} onClick={() => void run(projects.filter((s) => s.site_id !== p.site_id))} className="text-ink-400 hover:text-red-200 p-1 disabled:opacity-30"><Trash2 size={14} /></button></article>)}</div>
      <details className="text-[11px] text-ink-400"><summary className="cursor-pointer">Assumptions and allocation method</summary><p className="mt-2 leading-relaxed">{plan.method}</p><p className="mt-2 leading-relaxed">{data?.note}</p></details>
    </section>}
  </div>;
}
