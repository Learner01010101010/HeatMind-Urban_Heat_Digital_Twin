"use client";

import { ArrowRight, Loader2, ShieldCheck, Sun, TreePine } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Logo from "@/components/shell/Logo";
import AuroraBackground from "@/components/ui/AuroraBackground";
import PersonaSelector from "@/components/ui/PersonaSelector";
import { ensureUser } from "@/lib/hooks";
import { usePrefs } from "@/lib/store";

export default function Onboarding() {
  const router = useRouter();
  const persona = usePrefs((s) => s.persona);
  const units = usePrefs((s) => s.units);
  const set = usePrefs((s) => s.set);
  const [sample, setSample] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      await ensureUser(sample);
    } catch {
      setErr("Couldn't reach the HeatMind engine — you can still explore, but the Passport needs the backend on :8000.");
    }
    set({ onboarded: true });
    router.push("/");
  };

  return (
    <main className="min-h-dvh relative bg-ink-950 overflow-hidden">
      <AuroraBackground />
      <div className="relative z-10 max-w-5xl mx-auto px-5 py-10 md:py-16 grid md:grid-cols-[1fr_1.15fr] gap-10 items-start">
        <section
          className="relative rounded-[40px] p-6 md:p-8 -m-6 md:-m-8"
          style={{ background: "radial-gradient(closest-side, rgba(3,5,9,0.55), rgba(3,5,9,0.22) 65%, transparent 100%)" }}
        >
          <div className="flex items-center gap-3 mb-8">
            <Logo size={40} />
            <div>
              <div className="font-extrabold text-xl text-ink-100 leading-none">HeatMind AI</div>
              <div className="text-[12px] text-ink-400">Urban heat digital twin</div>
            </div>
          </div>
          <h1 className="text-4xl md:text-5xl font-extrabold leading-[1.05] tracking-tight text-ink-100">
            The same street can be 10°C hotter than the one next to it.
          </h1>
          <p className="text-ink-400 mt-5 text-[15px] leading-relaxed max-w-md">
            Weather apps give one number for the whole city. HeatMind models heat street by street across the TSSM BSCOER campus in Narhe, Pune, forecasts it three hours ahead, and routes you through the shade.
          </p>
          <ul className="mt-7 space-y-3 text-[14px] text-ink-200">
            <li className="flex gap-3">
              <Sun size={18} className="text-ink-400 shrink-0 mt-0.5" /> Live sun-angle shadow simulation from real building footprints
            </li>
            <li className="flex gap-3">
              <TreePine size={18} className="text-ink-400 shrink-0 mt-0.5" /> Routes scored for <i>your</i> body, not a generic average
            </li>
            <li className="flex gap-3">
              <ShieldCheck size={18} className="text-ink-400 shrink-0 mt-0.5" /> Every score explained in plain language
            </li>
          </ul>
        </section>

        <section className="bg-ink-900/90 border border-white/[0.08] rounded-3xl p-5 md:p-6">
          <h2 className="font-extrabold text-lg text-ink-100">Who&apos;s heading out?</h2>
          <p className="text-[13px] text-ink-400 mb-4">Identical heat isn&apos;t equally risky for everyone. Your persona sets how the risk engine weighs each factor.</p>
          <PersonaSelector value={persona} onChange={(p) => set({ persona: p })} />

          <div className="mt-5 grid sm:grid-cols-2 gap-3">
            <div className="rounded-2xl bg-white/[0.03] border border-white/[0.07] p-3">
              <div className="text-[12px] font-bold text-ink-300 mb-2">Units</div>
              <div className="flex rounded-xl bg-ink-950 p-1" role="radiogroup" aria-label="Temperature units">
                {(["C", "F"] as const).map((u) => (
                  <button key={u} role="radio" aria-checked={units === u} onClick={() => set({ units: u })} className={`flex-1 rounded-lg py-1.5 text-[13px] font-bold ${units === u ? "bg-white/[0.1] text-ink-100" : "text-ink-400"}`}>
                    °{u}
                  </button>
                ))}
              </div>
            </div>
            <label className="rounded-2xl bg-white/[0.03] border border-white/[0.07] p-3 flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} className="mt-1 accent-ink-100 w-4 h-4" />
              <span>
                <span className="block text-[13px] font-bold text-ink-100">Preload a sample week</span>
                <span className="block text-[11.5px] text-ink-400">Fills your Heat Passport with clearly-labelled sample trips (removable).</span>
              </span>
            </label>
          </div>

          {err && <p className="text-[12.5px] text-ink-300 mt-3">{err}</p>}
          <button
            onClick={start}
            disabled={busy}
            className="mt-5 w-full flex items-center justify-center gap-2 rounded-full bg-ink-100 hover:bg-white text-ink-950 font-semibold py-3.5 text-[15px] transition disabled:opacity-60"
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : null}
            Enter the heat twin <ArrowRight size={18} />
          </button>
        </section>
      </div>
    </main>
  );
}
