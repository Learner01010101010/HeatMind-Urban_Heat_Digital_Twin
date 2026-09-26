"use client";

import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFrames, useNearestFrame } from "@/lib/hooks";
import { fmtTemp, heatColor } from "@/lib/heatColorScale";
import { TIMELINE, TIMELINE_MARKS, TIMELINE_MAX, useClock, useMap, usePrefs } from "@/lib/store";

function parts(ms: number) {
  const s = new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const m = s.match(/^(.*?)\s?([AaPp]\.?\s?[Mm]\.?)$/);
  return m ? { hm: m[1], ap: m[2].toUpperCase().replace(/\./g, "").replace(" ", "") } : { hm: s, ap: "" };
}

/** Future Heat timeline anchored to the live clock: Now → +30m → +1h → +2h → +3h. */
export default function Timeline({ compact = false }: { compact?: boolean }) {
  const timeMin = useMap((s) => s.timeMin);
  const set = useMap((s) => s.set);
  const units = usePrefs((s) => s.units);
  const reduce = usePrefs((s) => s.reduceMotion);
  const now = useClock((s) => s.now);
  const base = useClock((s) => s.base);
  const frames = useFrames((s) => s.frames);
  const near = useNearestFrame();
  const [playing, setPlaying] = useState(false);
  const raf = useRef(0);

  // Playback sweeps three hours in seconds, which is the same burst of sun
  // positions a drag produces — so it gets the same treatment.
  useEffect(() => {
    set({ timeScrubbing: playing });
    return () => set({ timeScrubbing: false });
  }, [playing, set]);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const speed = reduce ? 60 : 22; // timeline minutes per real second
    const step = (t: number) => {
      if (t - last < 1000 / 20) {
        raf.current = requestAnimationFrame(step);
        return;
      }
      const dt = (t - last) / 1000;
      last = t;
      const next = useMap.getState().timeMin + dt * speed;
      if (next >= TIMELINE_MAX) {
        useMap.getState().set({ timeMin: TIMELINE_MAX });
        setPlaying(false);
        return;
      }
      useMap.getState().set({ timeMin: next });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, reduce]);

  const live = timeMin < 1;
  // "Now" shows the ticking wall clock; future positions are projected from the live baseline.
  const shown = live ? now : new Date(base).getTime() + timeMin * 60000;
  const { hm, ap } = parts(shown);
  const pct = (timeMin / TIMELINE_MAX) * 100;
  const ribbon = frames.map((f, i) => `${f ? heatColor(f.stats.street_mean_c) : "#272523"} ${(TIMELINE[i] / TIMELINE_MAX) * 100}%`).join(", ");
  const toggle = () => {
    if (!playing && timeMin >= TIMELINE_MAX - 1) set({ timeMin: 0 });
    setPlaying((p) => !p);
  };

  const track = (
    <div className={`relative flex-1 min-w-0 ${compact ? "h-[36px]" : "h-[44px]"}`}>
      <div className="absolute left-0 right-0 top-[13px] h-[6px] rounded-full opacity-35" style={{ backgroundImage: `linear-gradient(90deg, ${ribbon})` }} />
      <div
        className="absolute left-0 top-[13px] h-[6px] rounded-full"
        style={{ width: `${pct}%`, backgroundImage: `linear-gradient(90deg, ${ribbon})`, backgroundSize: `${pct > 0 ? 10000 / pct : 100}% 100%`, boxShadow: "0 0 14px rgba(251,138,31,.45)" }}
      />
      {!compact &&
        TIMELINE.map((t) => <span key={t} className="absolute top-[24px] w-px h-[5px] bg-white/15" style={{ left: `${(t / TIMELINE_MAX) * 100}%` }} />)}
      {TIMELINE_MARKS.filter(([t]) => !compact || t !== 30).map(([t, l]) => (
        <button
          key={l}
          onClick={() => {
            setPlaying(false);
            set({ timeMin: t });
          }}
          className={`absolute ${compact ? "top-[22px] text-[9.5px]" : "top-[30px] text-[10.5px]"} -translate-x-1/2 font-medium transition-colors ${Math.abs(timeMin - t) < 4 ? "text-ink-100" : "text-ink-400 hover:text-ink-200"}`}
          style={{ left: `clamp(10px, ${(t / TIMELINE_MAX) * 100}%, calc(100% - 12px))` }}
        >
          {l}
        </button>
      ))}
      <div className="absolute top-[4px] -translate-x-1/2 pointer-events-none" style={{ left: `${pct}%` }}>
        <div className="w-[6px] h-[24px] rounded-full bg-white" style={{ boxShadow: "0 0 0 4px rgba(255,255,255,.12), 0 0 18px rgba(255,255,255,.55)" }} />
      </div>
      <input
        type="range"
        className="hm-range absolute inset-x-0 top-0 w-full h-[26px]"
        min={0}
        max={TIMELINE_MAX}
        step={1}
        value={timeMin}
        onChange={(e) => {
          setPlaying(false);
          set({ timeMin: Number(e.target.value) });
        }}
        // Bracket the gesture so the twin can coarsen its shadow march during the
        // drag and re-march exactly once when it ends. onPointerUp alone is not
        // enough: a drag that leaves the control ends in a cancel, and a scrub left
        // permanently "in progress" would never settle to full granularity.
        onPointerDown={() => set({ timeScrubbing: true })}
        onPointerUp={() => set({ timeScrubbing: false })}
        onPointerCancel={() => set({ timeScrubbing: false })}
        onLostPointerCapture={() => set({ timeScrubbing: false })}
        onKeyDown={() => set({ timeScrubbing: true })}
        onKeyUp={() => set({ timeScrubbing: false })}
        onBlur={() => set({ timeScrubbing: false })}
        aria-label="Forecast time"
        aria-valuetext={live ? "now" : `plus ${Math.round(timeMin)} minutes`}
      />
    </div>
  );

  return (
    <div className={`glass flex items-center w-full ${compact ? "rounded-[22px] pl-1.5 pr-4 py-1.5 gap-3" : "rounded-[28px] pl-2.5 pr-5 py-2.5 gap-4"}`}>
      <button
        onClick={toggle}
        className={`press grid place-items-center rounded-full text-ink-950 shrink-0 ${compact ? "w-10 h-10" : "w-12 h-12"}`}
        style={{ background: "var(--cool-gradient)", boxShadow: "0 8px 24px -6px rgba(111,191,94,.6)" }}
        aria-label={playing ? "Pause" : "Play the next 3 hours"}
      >
        {playing ? <Pause size={compact ? 15 : 18} fill="currentColor" /> : <Play size={compact ? 15 : 18} fill="currentColor" className="ml-0.5" />}
      </button>

      <div className={`shrink-0 leading-none ${compact ? "w-[70px]" : "w-[96px]"}`}>
        <div className={`${compact ? "text-[19px]" : "text-[26px]"} font-semibold tracking-[-0.04em] text-ink-100 tabular whitespace-nowrap`} suppressHydrationWarning>
          {hm}
          <span className="text-[11px] font-medium text-ink-400 ml-1 tracking-normal">{ap}</span>
        </div>
        <div className={`${compact ? "text-[10px] mt-1" : "text-[11px] mt-1.5"} text-ink-400 tabular truncate flex items-center gap-1`}>
          {live ? (
            <>
              <span className="relative flex w-1.5 h-1.5">
                <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-70" />
                <span className="relative w-1.5 h-1.5 rounded-full bg-emerald-400" />
              </span>
              <span className="text-emerald-300 font-medium">LIVE</span>
            </>
          ) : (
            `+${Math.round(timeMin)} min`
          )}
          {!compact && near ? <span>· {fmtTemp(near.weather.air_c, units)} air</span> : null}
        </div>
      </div>

      {track}
      {!compact && <span className="hidden lg:block text-[10px] font-medium uppercase tracking-[0.16em] text-ink-400 shrink-0 [writing-mode:vertical-rl] rotate-180">Forecast</span>}
    </div>
  );
}
