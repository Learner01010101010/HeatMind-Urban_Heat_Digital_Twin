"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import CoolingInvestment from "@/components/city-lab/CoolingInvestment";

export default function CityLabPage() {
  return <main className="min-h-dvh bg-ink-950 pb-24 md:pb-12">
    <div className="max-w-6xl mx-auto px-4 md:px-8 pt-7 md:pt-24 space-y-7">
      <Link href="/" className="inline-flex gap-1.5 items-center text-xs text-ink-300"><ArrowLeft size={14} />Back to the twin</Link>
      <header className="space-y-3"><div className="text-[11px] uppercase tracking-[.2em] text-[#8ad8b0]">HeatMind · City Lab</div><h1 className="text-3xl md:text-5xl font-semibold tracking-tight max-w-3xl">Plan cooler streets.<br />Test the twin.</h1><p className="text-sm md:text-base text-ink-300 max-w-2xl leading-relaxed">Turn a city budget into a costed cooling proposal on mapped streets, built on the same digital twin the routing runs on.</p></header>
      <CoolingInvestment />
    </div>
  </main>;
}
