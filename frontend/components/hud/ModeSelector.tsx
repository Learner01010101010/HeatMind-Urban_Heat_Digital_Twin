"use client";

import { Bike, Bus, Car, Footprints, Zap } from "lucide-react";
import { useEffect } from "react";
import type { TravelMode } from "@/lib/api";
import { setMode } from "@/lib/actions";
import { modeAllowed, SENIOR_MODES } from "@/lib/seniorMode";
import { useMap, usePrefs } from "@/lib/store";

/**
 * Vehicle picker, in the order people actually consider them for a Pune commute.
 *
 * `Zap` stands in for the two-wheeler: lucide has no scooter glyph, and `Bike` is
 * already spoken for by the bicycle. The label is what disambiguates them — "Cycle"
 * and "Bike" mean different vehicles here, and in Indian English that is the
 * distinction riders themselves make.
 */
const OPTIONS: { key: TravelMode; label: string; Icon: typeof Bike; hint: string }[] = [
  { key: "walk", label: "Walk", Icon: Footprints, hint: "On foot — full sun, free to cross for shade" },
  { key: "cycle", label: "Cycle", Icon: Bike, hint: "Bicycle — exposed, kept off steps and untagged footways" },
  { key: "bike", label: "Bike", Icon: Zap, hint: "Two-wheeler — exposed, quicker through traffic than a car" },
  { key: "car", label: "Car", Icon: Car, hint: "Enclosed — shade barely changes the trip" },
  { key: "bus", label: "Bus", Icon: Bus, hint: "PMPML stops — walk, wait, ride (headway is modelled)" },
];

export default function ModeSelector({ compact = false }: { compact?: boolean }) {
  const mode = usePrefs((s) => s.mode);
  const senior = usePrefs((s) => s.seniorMode);
  const loading = useMap((s) => s.loading);

  // Senior Mode drops the bicycle and the two-wheeler. Anyone already on one when
  // the mode is turned on is moved to walking rather than left on a vehicle the
  // picker no longer offers — otherwise the selected tab is invisible and nothing
  // can be changed back.
  const options = senior ? OPTIONS.filter((o) => SENIOR_MODES.includes(o.key)) : OPTIONS;
  useEffect(() => {
    if (!modeAllowed(mode, senior)) setMode("walk");
  }, [mode, senior]);

  return (
    <div
      className={`glass flex items-center gap-1 rounded-full ${compact ? "p-1" : "p-1.5"}`}
      role="radiogroup"
      aria-label="Travel mode"
    >
      {options.map(({ key, label, Icon, hint }) => {
        const on = mode === key;
        return (
          <button
            key={key}
            role="radio"
            aria-checked={on}
            title={hint}
            // Switching mode re-plans the trip, so it is disabled mid-flight rather
            // than queueing a second comparison that would race the first.
            disabled={loading}
            onClick={() => setMode(key)}
            className={`flex items-center gap-1.5 rounded-full font-semibold transition-colors disabled:opacity-50 ${
              compact ? "h-8 px-2.5 text-[11.5px]" : "h-9 px-3 text-[12.5px]"
            } ${on ? "bg-white/[0.12] text-ink-100" : "text-ink-400 hover:text-ink-200"}`}
          >
            <Icon size={compact ? 13 : 14} aria-hidden />
            {/* Below the widest breakpoint the labels go and the icons carry it, but
                "Cycle" vs "Bike" is exactly the pair icons alone cannot separate — so
                the active one keeps its label at every size. */}
            <span className={compact && !on ? "hidden" : ""}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
