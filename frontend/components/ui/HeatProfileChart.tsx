"use client";

import type { Route } from "@/lib/api";
import { fmtTemp, heatColor, type Units } from "@/lib/heatColorScale";
import { POI_STYLE } from "@/lib/poiStyle";
import { atTime } from "@/lib/store";

/** Feels-like heat along the route, recoloured live with the timeline. */
export default function HeatProfileChart({ route, timeMin, units }: { route: Route; timeMin: number; units: Units }) {
  const W = 360;
  const H = 110;
  const pad = { l: 28, r: 6, t: 8, b: 20 };
  const segs = route.segments;
  const total = route.distance_m || 1;
  const vals = segs.map((s) => atTime(s.feels, timeMin));
  const all = segs.flatMap((s) => s.feels);
  const lo = Math.floor(Math.min(...all) - 1);
  const hi = Math.ceil(Math.max(...all) + 1);
  const x = (m: number) => pad.l + (m / total) * (W - pad.l - pad.r);
  const y = (c: number) => pad.t + (1 - (c - lo) / Math.max(hi - lo, 1)) * (H - pad.t - pad.b);
  const pts = segs.map((s, i) => [x(s.start_m + s.length_m / 2), y(vals[i])] as const);
  // smooth path (Catmull-Rom → Bézier)
  let d = "";
  pts.forEach((p, i) => {
    if (i === 0) d = `M${p[0]},${p[1]}`;
    else {
      const p0 = pts[i - 2] ?? pts[i - 1];
      const p1 = pts[i - 1];
      const p3 = pts[i + 1] ?? p;
      d += ` C${p1[0] + (p[0] - p0[0]) / 6},${p1[1] + (p[1] - p0[1]) / 6} ${p[0] - (p3[0] - p1[0]) / 6},${p[1] - (p3[1] - p1[1]) / 6} ${p[0]},${p[1]}`;
    }
  });
  const area = `${d} L${pts[pts.length - 1]?.[0] ?? pad.l},${H - pad.b} L${pts[0]?.[0] ?? pad.l},${H - pad.b} Z`;
  const gid = `hp-${route.id}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Heat along the route">
      <defs>
        <linearGradient id={gid} x1="0" x2="1" y1="0" y2="0">
          {segs.map((s, i) => (
            <stop key={i} offset={`${((s.start_m + s.length_m / 2) / total) * 100}%`} stopColor={heatColor(vals[i])} />
          ))}
        </linearGradient>
        <linearGradient id={`${gid}-fade`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={`${gid}-m`}>
          <rect width={W} height={H} fill={`url(#${gid}-fade)`} />
        </mask>
      </defs>
      {[lo, hi].map((t) => (
        <text key={t} x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fill="#6e7a90" className="tabular">
          {fmtTemp(t, units).replace(/°[CF]/, "°")}
        </text>
      ))}
      <path d={area} fill={`url(#${gid})`} mask={`url(#${gid}-m)`} />
      <path d={d} fill="none" stroke={`url(#${gid})`} strokeWidth={2.5} strokeLinecap="round" />
      {route.pois_along_route.map((p) => (
        <circle key={p.id} cx={x(p.at_m ?? 0)} cy={H - pad.b + 8} r={3.5} fill={POI_STYLE[p.type].color}>
          <title>{p.name}</title>
        </circle>
      ))}
    </svg>
  );
}
