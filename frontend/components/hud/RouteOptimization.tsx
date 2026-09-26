"use client";

import { Armchair, Car, Check, Factory, Loader2, Sparkles, Thermometer, TreePine } from "lucide-react";
import { useState } from "react";
import type { Route } from "@/lib/api";
import { generateRouteAdvice } from "@/lib/generateRouteAdvice";

const ICONS = { heat: Thermometer, traffic: Car, shade: TreePine, industry: Factory, rest: Armchair };

export default function RouteOptimization({ route }: { route: Route }) {
  const c = route.optimization;
  const [tips, setTips] = useState<{ id: string; text: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!c) return null;
  const color = c.score < 30 ? "#8ad8b0" : c.score < 60 ? "#ffd08a" : "#fca5a5";
  const getTips = async () => {
    setBusy(true);
    try { setTips({ id: route.id, text: await generateRouteAdvice(route) }); }
    finally { setBusy(false); }
  };
  return <section className="rounded-[22px] border border-white/10 bg-white/[0.035] p-4 space-y-3" aria-label="Route optimization checks">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-[15px] font-semibold">Route checks</h3>
      <span className="text-[11px] rounded-full px-2 py-1" style={{ color, background: `${color}18` }}>{c.rating}</span>
    </div>
    <p className="text-[10px] text-ink-400">Checks at departure · the timeline shows your heat forecast.</p>
    <div className="grid grid-cols-2 gap-2">
      {c.factors.map((f) => {
        const Icon = ICONS[f.key as keyof typeof ICONS] ?? Thermometer;
        const tone = f.raw < 30 ? "#8ad8b0" : f.raw < 60 ? "#ffd08a" : "#fca5a5";
        return <div key={f.key} className="rounded-xl bg-black/15 p-2.5" title={f.source}>
          <div className="flex gap-1.5 items-center text-[10px] text-ink-400"><Icon size={12} />{f.label}</div>
          <div className="text-[16px] mt-1 font-semibold tabular">{f.value}</div>
          <div className="h-1 mt-2 rounded-full bg-white/10 overflow-hidden" role="meter" aria-label={`${f.label} exposure`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(f.raw)}>
            <div className="h-full rounded-full" style={{ background: tone, width: `${Math.max(3, Math.min(100, f.raw))}%` }} />
          </div>
          <div className="text-[9px] text-ink-500 mt-1">{f.key === "rest" ? "Mapped · confirm access" : f.key === "industry" ? "Estimated waste heat" : "Shorter bar = lower exposure"}</div>
        </div>;
      })}
    </div>
    <div className="rounded-xl bg-black/15 px-3 py-2 text-[11px] text-ink-300">
      <span className="font-medium" style={{ color: c.traffic.live ? "#8ad8b0" : "#ffd08a" }}>{c.traffic.live ? `Live traffic · ${c.traffic.coverage_pct}% of route sampled` : "Traffic estimated · live feed unavailable"}</span>
      {c.traffic.live && c.traffic.observed_at && <span className="block text-ink-400 mt-1">Observed {new Date(c.traffic.observed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · up to 5 min old</span>}
      <div className="mt-1 text-ink-400">Remaining streets and future traffic use estimates.</div>
    </div>
    <div>
      <h4 className="font-medium text-[12px] mb-2">{route.tags.includes("recommended") ? "Why this route is recommended" : "How this route compares"}</h4>
      <ul className="space-y-2">{c.reasons.map((reason) => <li key={reason} className="flex gap-2 text-[11px] text-ink-300 leading-relaxed"><Check size={12} className="shrink-0 mt-1 text-cool-300" /><span>{reason}</span></li>)}</ul>
    </div>
    <details className="text-[10px] text-ink-400"><summary className="cursor-pointer">How these checks work · index {c.score}/100</summary><p className="mt-2">{c.note}</p><p className="mt-1">{c.industrial.note}</p><p className="mt-1">{c.traffic.note}</p></details>
    <button onClick={getTips} disabled={busy} className="w-full rounded-xl bg-cool-300/10 text-cool-300 py-2.5 text-[12px] flex items-center justify-center gap-2 disabled:opacity-50">
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}{busy ? "Preparing tips…" : "Get AI trip tips"}
    </button>
    {tips?.id === route.id && <ul aria-live="polite" className="space-y-2 text-[12px] text-ink-200">{tips.text.map((tip) => <li key={tip} className="rounded-xl bg-cool-300/5 p-2.5">{tip}</li>)}</ul>}
  </section>;
}
