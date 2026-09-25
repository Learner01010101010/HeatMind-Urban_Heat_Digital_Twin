"use client";

import { Sunrise, Sun, Moon } from "lucide-react";
import { useMeta } from "@/lib/hooks";
import { solarPosition } from "@/lib/solar";
import { useClock, useMap } from "@/lib/store";

/** Azimuth (clockwise from north) as the compass point a person would actually say. */
const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function compass(azimuthDeg: number): string {
  return POINTS[Math.round((((azimuthDeg % 360) + 360) % 360) / 45) % 8];
}

/**
 * Where the sun is, in words, next to where it is in the sky.
 *
 * The 3D view now draws the sun itself (three/sunDisc.ts) and has always cast its
 * shadows, but neither gives you a number you can check or repeat. This reads the
 * same NOAA position the shadows are marched from — recomputed at the exact scrub
 * time, so it tracks the timeline continuously rather than snapping between the
 * backend's 15-minute keyframes.
 *
 * Below the horizon it says so plainly: there is no shade to route into at night,
 * and a chip reporting a negative elevation would imply otherwise.
 */
export default function SunChip({ compact = false }: { compact?: boolean }) {
  const meta = useMeta();
  const base = useClock((s) => s.base);
  const timeMin = useMap((s) => s.timeMin);
  const simOffset = useMap((s) => s.simOffsetMin);

  if (!meta.data || !base) return null;

  const when = new Date(new Date(base).getTime() + (simOffset + timeMin) * 60_000);
  const [lat, lon] = meta.data.zone.center;
  const { elevationDeg, azimuthDeg } = solarPosition(when, lat, lon);

  const up = elevationDeg > 0;
  // Under about 10 degrees the shadows run long enough that a street's aspect matters
  // far more than its canopy, which is worth flagging as a distinct regime.
  const low = up && elevationDeg < 10;
  const Icon = !up ? Moon : low ? Sunrise : Sun;
  const tone = !up ? "text-cool-300" : low ? "text-amber-300" : "text-amber-200";

  return (
    <div
      className={`glass flex items-center gap-2 rounded-full ${compact ? "h-9 px-3" : "h-11 px-4"} text-[12.5px] whitespace-nowrap`}
      title={
        up
          ? `Sun ${elevationDeg.toFixed(1)}° above the horizon, bearing ${Math.round(azimuthDeg)}° (${compass(azimuthDeg)}). Shadows fall towards ${compass(azimuthDeg + 180)}.`
          : "The sun is below the horizon — no shade to route into."
      }
    >
      <Icon size={compact ? 14 : 15} className={tone} aria-hidden />
      {up ? (
        <>
          <span className="font-semibold text-ink-100 tabular">{Math.round(elevationDeg)}°</span>
          <span className="text-ink-400">from the {compass(azimuthDeg)}</span>
          {!compact && (
            <>
              <span className="text-ink-500" aria-hidden>
                ·
              </span>
              {/* The direction that matters for routing is where the shade lands, not
                  where the sun sits, so say that rather than making people invert it. */}
              <span className="text-ink-400">
                shade to the <span className="text-ink-200 font-medium">{compass(azimuthDeg + 180)}</span>
              </span>
            </>
          )}
        </>
      ) : (
        <span className="text-ink-300">Sun is down</span>
      )}
    </div>
  );
}
