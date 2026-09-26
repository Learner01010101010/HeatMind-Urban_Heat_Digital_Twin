"use client";

import { ArrowLeft, FlaskConical, TreePine } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import CoolingInvestment from "@/components/city-lab/CoolingInvestment";
import SensorValidation from "@/components/city-lab/SensorValidation";

export default function CityLabPage() {
  const [tab, setTab] = useState<"cooling" | "validation">("cooling");
  return <main className="min-h-dvh bg-ink-950 pb-24 md:pb-12">
    <div className="max-w-6xl mx-auto px-4 md:px-8 pt-7 md:pt-24 space-y-7">
      <Link href="/" className="inline-flex gap-1.5 items-center text-xs text-ink-300"><ArrowLeft size={14} />Back to the twin</Link>
      <header className="space-y-3"><div className="text-[11px] uppercase tracking-[.2em] text-[#8ad8b0]">HeatMind · City Lab</div><h1 className="text-3xl md:text-5xl font-semibold tracking-tight max-w-3xl">Plan cooler streets.<br />Test the twin.</h1><p className="text-sm md:text-base text-ink-300 max-w-2xl leading-relaxed">Turn a city budget into a visible cooling proposal, then compare model predictions with temperature readings. Two hands-on demonstrations built on the same digital twin.</p></header>
      <div role="tablist" aria-label="City Lab demonstrations" className="grid sm:grid-cols-2 gap-3">
        {[{ id: "cooling" as const, label: "Cooling investment", hint: "Budget → projects → before & after", Icon: TreePine, color: "#8ad8b0" }, { id: "validation" as const, label: "Sensor validation", hint: "Readings → comparison → model error", Icon: FlaskConical, color: "#a9d7fa" }].map(({ id, label, hint, Icon, color }) => <button key={id} role="tab" id={`tab-${id}`} aria-controls={`panel-${id}`} aria-selected={tab === id} onClick={() => setTab(id)} className="text-left rounded-2xl border p-4 flex gap-3 items-center transition-colors" style={{ borderColor: tab === id ? `${color}66` : "#ffffff15", background: tab === id ? `${color}0a` : "#ffffff03" }}><span className="rounded-xl p-2.5" style={{ color, background: `${color}15` }}><Icon size={22} /></span><span><span className="block font-semibold">{label}</span><span className="block text-xs text-ink-400 mt-1">{hint}</span></span></button>)}
      </div>
      <section role="tabpanel" id="panel-cooling" aria-labelledby="tab-cooling" hidden={tab !== "cooling"}><CoolingInvestment /></section>
      <section role="tabpanel" id="panel-validation" aria-labelledby="tab-validation" hidden={tab !== "validation"}><SensorValidation /></section>
    </div>
  </main>;
}
