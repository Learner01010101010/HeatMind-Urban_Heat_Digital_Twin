"use client";

import { Check } from "lucide-react";
import type { Persona } from "@/lib/api";
import { PERSONAS } from "@/lib/personas";

export default function PersonaSelector({ value, onChange, dense = false }: { value: Persona; onChange: (p: Persona) => void; dense?: boolean }) {
  return (
    <div className={`grid gap-2.5 ${dense ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-2"}`} role="radiogroup" aria-label="Choose your persona">
      {PERSONAS.map((p) => {
        const on = value === p.id;
        return (
          <button
            key={p.id}
            role="radio"
            aria-checked={on}
            onClick={() => onChange(p.id)}
            className={`press relative text-left rounded-[20px] p-4 border transition-all ${on ? "bg-white/[0.06] border-white/25" : "bg-white/[0.02] border-white/[0.07] hover:bg-white/[0.04]"}`}
          >
            <span className="grid place-items-center w-10 h-10 rounded-2xl mb-3 bg-white/[0.06] text-ink-200">
              <p.icon size={20} />
            </span>
            <div className="font-semibold text-ink-100 tracking-tight">{p.label}</div>
            {!dense && <p className="text-[13px] text-ink-400 mt-0.5 leading-snug">{p.blurb}</p>}
            {on && (
              <span className="absolute top-3.5 right-3.5 grid place-items-center w-5 h-5 rounded-full bg-ink-100">
                <Check size={12} className="text-ink-950" strokeWidth={3} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
