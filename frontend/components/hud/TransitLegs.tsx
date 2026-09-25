"use client";

import { Bus, Footprints, Hourglass, Info, Sun } from "lucide-react";
import type { TransitPlan } from "@/lib/api";
import { fmtDist } from "@/lib/heatColorScale";

const ICON = { walk: Footprints, wait: Hourglass, ride: Bus } as const;

/**
 * A bus trip, leg by leg.
 *
 * The wait is given the same visual weight as the ride because on a hot afternoon it
 * carries more of the heat dose than either walk: standing still on an unsheltered
 * kerb for seven minutes is a bigger exposure than seven minutes of walking, and it
 * is the part a rider can do something about by choosing a different stop.
 *
 * The disclaimer is not small print. Nothing here is a timetable, and a rider who
 * reads the wait as a departure will miss buses by it.
 */
export default function TransitLegs({ plan }: { plan: TransitPlan }) {
  return (
    <div className="rounded-[20px] bg-white/[0.03] border border-white/[0.06] p-3">
      <div className="flex items-baseline gap-2 mb-2.5">
        <span className="text-[13px] font-semibold text-ink-100">{Math.round(plan.total_min)} min total</span>
        <span className="text-[11.5px] text-ink-400">
          {fmtDist(plan.walk_m)} on foot · {fmtDist(plan.ride_m)} by bus
        </span>
      </div>

      <ol className="flex flex-col gap-0.5">
        {plan.legs.map((leg, i) => {
          const Icon = ICON[leg.kind];
          const exposed = leg.kind === "walk" || (leg.kind === "wait" && !leg.sheltered);
          return (
            <li key={i} className="flex items-center gap-2.5 py-1.5">
              <span
                className={`grid place-items-center w-7 h-7 rounded-full shrink-0 ${
                  leg.kind === "ride" ? "bg-[#5bb8d4]/20 text-[#8fd4e8]" : "bg-white/[0.06] text-ink-300"
                }`}
              >
                <Icon size={13} aria-hidden />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-ink-200 truncate">
                  {leg.kind === "wait"
                    ? `Wait at ${leg.from_name}`
                    : leg.kind === "ride"
                      ? `Bus to ${leg.to_name}`
                      : `Walk to ${leg.to_name}`}
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-ink-500 tabular">
                  <span>{Math.round(leg.minutes)} min</span>
                  {leg.distance_m > 0 && <span>· {fmtDist(leg.distance_m)}</span>}
                  {exposed && (
                    <span className="flex items-center gap-0.5 text-heat-4">
                      <Sun size={10} aria-hidden /> in the open
                    </span>
                  )}
                  {leg.kind === "wait" && leg.sheltered && <span className="text-cool-300">· sheltered</span>}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="flex gap-1.5 mt-2.5 pt-2.5 border-t border-white/[0.06] text-[11px] leading-relaxed text-ink-400">
        <Info size={12} className="shrink-0 mt-0.5" aria-hidden />
        <span>{plan.disclaimer}</span>
      </p>
    </div>
  );
}
