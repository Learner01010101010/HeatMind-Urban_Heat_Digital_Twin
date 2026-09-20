"use client";

import { BookOpen, ChevronRight, HeartPulse, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Persona } from "@/lib/api";
import { clearTrip, runCompare } from "@/lib/actions";
import { ensureUser } from "@/lib/hooks";
import { personaOf } from "@/lib/personas";
import { useMap, usePrefs } from "@/lib/store";
import PersonaSelector from "@/components/ui/PersonaSelector";

export function ProfileButton() {
  const persona = usePrefs((s) => s.persona);
  const set = useMap((s) => s.set);
  const p = personaOf(persona);
  return (
    <button
      onClick={() => set({ panel: "profile" })}
      className="press relative grid place-items-center w-11 h-11 rounded-full shrink-0"
      style={{ background: `conic-gradient(from 140deg, ${p.accent}, #34e2c6, ${p.accent})`, padding: 2 }}
      aria-label={`Profile · ${p.label}`}
    >
      <span className="grid place-items-center w-full h-full rounded-full bg-ink-900" style={{ color: p.accent }}>
        <p.icon size={18} />
      </span>
    </button>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-full bg-white/[0.05] p-1">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`press flex-1 h-8 px-3 rounded-full text-[13px] font-medium transition-colors ${value === o.id ? "bg-white/[0.14] text-ink-100" : "text-ink-400 hover:text-ink-200"}`}
          aria-pressed={value === o.id}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)} className="w-full flex items-center gap-3 px-4 py-3.5 text-left">
      <span className="flex-1">
        <span className="block text-[14px] text-ink-100">{label}</span>
        <span className="block text-[12px] text-ink-400">{hint}</span>
      </span>
      <span className={`w-12 h-7 rounded-full p-0.5 transition-colors duration-300 ${on ? "bg-cool-400" : "bg-white/10"}`}>
        <span className={`block w-6 h-6 rounded-full bg-white shadow transition-transform duration-300 [transition-timing-function:cubic-bezier(.34,1.4,.64,1)] ${on ? "translate-x-5" : ""}`} />
      </span>
    </button>
  );
}

export function ProfilePanel() {
  const prefs = usePrefs();
  const router = useRouter();
  const p = personaOf(prefs.persona);

  const setPersona = (v: Persona) => {
    prefs.set({ persona: v });
    void ensureUser().catch(() => {});
    const m = useMap.getState();
    if (m.origin && m.destination) void runCompare();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <span className="grid place-items-center w-16 h-16 rounded-full" style={{ background: `linear-gradient(135deg, ${p.accent}33, ${p.accent}10)`, color: p.accent, boxShadow: `inset 0 0 0 1.5px ${p.accent}66` }}>
          <p.icon size={28} />
        </span>
        <div>
          <div className="text-[22px] font-semibold tracking-tight">{p.label}</div>
          <div className="text-[13px] text-ink-400">{p.blurb}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <Link href="/passport" className="press rounded-[22px] p-4 bg-gradient-to-br from-[#ff375f]/25 to-[#ff9f0a]/10 hover:from-[#ff375f]/35">
          <HeartPulse size={20} className="text-[#ff5e7a]" />
          <div className="text-[15px] font-semibold mt-3">Heat Passport</div>
          <div className="text-[12px] text-ink-300">Your exposure, like Health</div>
        </Link>
        <Link href="/about" className="press rounded-[22px] p-4 bg-white/[0.04] hover:bg-white/[0.07]">
          <BookOpen size={20} className="text-cool-300" />
          <div className="text-[15px] font-semibold mt-3">How it works</div>
          <div className="text-[12px] text-ink-300">Engines & data sources</div>
        </Link>
      </div>

      <section>
        <h3 className="text-[13px] font-medium uppercase tracking-[0.12em] text-ink-400 mb-2.5">Who&apos;s heading out</h3>
        <PersonaSelector value={prefs.persona} onChange={setPersona} dense />
      </section>

      <section className="space-y-2.5">
        <h3 className="text-[13px] font-medium uppercase tracking-[0.12em] text-ink-400">Units</h3>
        <Segmented
          value={prefs.units}
          options={[
            { id: "C", label: "Celsius" },
            { id: "F", label: "Fahrenheit" },
          ]}
          onChange={(v) => prefs.set({ units: v })}
        />
      </section>

      <section>
        <h3 className="text-[13px] font-medium uppercase tracking-[0.12em] text-ink-400 mb-2.5">Accessibility</h3>
        <div className="rounded-[22px] bg-white/[0.035] divide-y divide-white/[0.05]">
          <Toggle on={prefs.seniorMode} onChange={(v) => prefs.set({ seniorMode: v })} label="Senior mode" hint="Larger text · one recommended route" />
          <Toggle on={prefs.reduceMotion} onChange={(v) => prefs.set({ reduceMotion: v })} label="Reduce motion" hint="No camera flights or animations" />
        </div>
      </section>

      <button
        onClick={() => {
          prefs.set({ onboarded: false });
          clearTrip();
          router.push("/onboarding");
        }}
        className="w-full flex items-center gap-3 rounded-[22px] bg-white/[0.035] hover:bg-white/[0.06] px-4 h-12 text-[14px] text-ink-300"
      >
        <RotateCcw size={15} /> Replay onboarding
        <ChevronRight size={15} className="ml-auto text-ink-500" />
      </button>
    </div>
  );
}
