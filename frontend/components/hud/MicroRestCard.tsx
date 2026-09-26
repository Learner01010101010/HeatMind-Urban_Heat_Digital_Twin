"use client";

import { Timer, X } from "lucide-react";
import { useEffect } from "react";
import { recommendRestPoint, useMicroRest } from "@/lib/microRest";
import { usePrefs } from "@/lib/store";

/**
 * One idle window, answered.
 *
 * Framed as scheduling, never as health advice: it leads with the wait the rider
 * already has and ends with "back in time", because the objection this has to clear
 * is not "I do not want to rest", it is "I cannot afford to miss the next trip".
 *
 * Shown only to the personas who work to a clock — a student between lectures has
 * no order queue to schedule around. When no rest point fits the window the card
 * says so rather than offering the nearest one anyway; a suggestion that overruns
 * the window costs a trip, which is the one thing this must never do.
 */
export default function MicroRestCard() {
  const persona = usePrefs((s) => s.persona);
  const active = useMicroRest((s) => s.active);
  const fire = useMicroRest((s) => s.fire);
  const dismiss = useMicroRest((s) => s.dismiss);
  const applies = persona === "gig_worker" || persona === "worker";

  // No order feed exists to subscribe to, so the window arrives as a mock event.
  useEffect(() => {
    if (!applies) return;
    const t = setTimeout(fire, 6000);
    return () => clearTimeout(t);
  }, [applies, fire]);

  if (!applies || !active) return null;

  const point = recommendRestPoint(active);

  return (
    <div className="glass-strong rounded-[22px] px-3.5 py-3 w-[min(340px,calc(100vw-28px))] pop-in">
      <div className="flex items-start gap-2.5">
        <span className="grid place-items-center w-8 h-8 rounded-full shrink-0" style={{ background: "rgba(221,19,103,.16)", color: "#ff7aa8" }}>
          <Timer size={15} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[10.5px] font-bold uppercase tracking-wider text-cool-400 mb-0.5">
            Micro-rest · scheduling
          </div>
          {point ? (
            <p className="text-[13px] text-ink-100 leading-snug">
              {active.label} ~{active.duration_min} min — <strong className="font-semibold">{point.name}</strong>{" "}
              {point.travel_time_min} min away, {point.amenities.join(" + ")}, back in time.
            </p>
          ) : (
            <p className="text-[13px] text-ink-200 leading-snug">
              {active.label} ~{active.duration_min} min — too short to reach anywhere and return. Stay
              in whatever shade you have.
            </p>
          )}
        </div>
        <button
          onClick={dismiss}
          className="press grid place-items-center w-6 h-6 rounded-full hover:bg-white/10 text-ink-400 shrink-0"
          aria-label="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
