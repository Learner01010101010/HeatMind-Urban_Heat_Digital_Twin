"use client";

import type { ReactNode } from "react";
import { heatColor } from "@/lib/heatColorScale";
import { KIND_COLORS, type CoolingPlan, type LabCatalog } from "@/lib/cityLabApi";

export function Stat({ label, value, hint, color = "#f3f3f2" }: { label: string; value: ReactNode; hint: string; color?: string }) {
  return <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4 min-w-0">
    <div className="text-[11px] text-ink-300">{label}</div><div className="text-2xl md:text-3xl font-semibold tabular mt-2" style={{ color }}>{value}</div>
    <div className="text-[10px] text-ink-400 mt-2">{hint}</div>
  </div>;
}

export function PlanningMap({ data, plan, after, active, onSelect }: { data: LabCatalog; plan: CoolingPlan | null; after: boolean; active: string; onSelect: (id: string) => void }) {
  const [s, w, n, e] = data.bbox;
  const point = (lat: number, lon: number) => [20 + (lon - w) / (e - w) * 600, 80 + (n - lat) / (n - s) * 340];
  return <svg viewBox="0 0 640 480" className="w-full rounded-2xl bg-[#0d1719] border border-white/10" role="group" aria-label={`${after ? "After investment" : "Before investment"} street planning map`}>
    <defs><pattern id="lab-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="#ffffff" strokeOpacity=".035" /></pattern><clipPath id="lab-map-clip"><rect width="640" height="480" rx="16" /></clipPath></defs>
    <rect width="640" height="480" fill="url(#lab-grid)" />
    <g clipPath="url(#lab-map-clip)">
      <g aria-hidden="true">{data.roads.map((r, i) => <polyline key={i} points={r.points.map(([lat, lon]) => point(lat, lon).join(",")).join(" ")} fill="none" stroke="#7b969c" strokeOpacity=".32" strokeWidth="2"><title>{r.name || "Mapped street"}</title></polyline>)}</g>
      {data.sites.map((site, i) => {
        const [x, y] = point(site.lat, site.lon);
        const project = plan?.projects.find((p) => p.site_id === site.id);
        const temp = after && project?.result ? project.result.after.feels_c : site.before.feels_c;
        return <g key={site.id} role="button" tabIndex={0} aria-label={`Site ${i + 1}: ${site.name}, ${temp.toFixed(1)} degrees Celsius${project ? ", project selected" : ""}`} aria-pressed={active === site.id} onClick={() => onSelect(site.id)} onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onSelect(site.id); } }} className="cursor-pointer outline-none">
          {project && <circle cx={x} cy={y} r={22} stroke={KIND_COLORS[project.kind]} strokeWidth="2" strokeDasharray="4 3" fill={KIND_COLORS[project.kind]} fillOpacity=".08" />}
          <circle cx={x} cy={y} r={active === site.id ? 16 : 12} fill={heatColor(temp)} stroke={active === site.id ? "#fff" : "#16232b"} strokeWidth={active === site.id ? 3 : 2} />
          <text x={x} y={y + 4} textAnchor="middle" fill="#fff" fontSize="11" fontWeight="700">{i + 1}</text>
          {project?.result && <text x={x} y={y + 35} textAnchor="middle" fill={after ? "#8ad8b0" : "#ffd08a"} stroke="#0d1719" strokeWidth="3" paintOrder="stroke" fontSize="11" fontWeight="600">{after ? `−${Math.max(0, -project.result.delta_c).toFixed(1)}°C` : `${site.before.feels_c.toFixed(1)}°C`}</text>}
          {project?.kind === "water_refill" && <text x={x} y={y + 35} textAnchor="middle" fill="#77d9f5" stroke="#0d1719" strokeWidth="3" paintOrder="stroke" fontSize="11">Refill proposal</text>}
          <title>{site.name} · {temp.toFixed(1)}°C feels-like in the evaluated patch</title>
        </g>;
      })}
    </g>
    <rect x="14" y="14" width="250" height="46" rx="10" fill="#060606" fillOpacity=".9" />
    <text x="26" y="33" fill="#f3f3f2" fontSize="13" fontWeight="600">{data.area_name}</text>
    <text x="26" y="49" fill="#a5b7b8" fontSize="10">Mapped streets · tap a numbered candidate</text>
    <text x="612" y="30" textAnchor="end" fill="#c3d5d6" fontSize="11">N ↑</text>
    <text x="18" y="461" fill="#a5b7b8" fontSize="10">Dot colour = modelled patch feels-like · dashed ring = proposal</text>
  </svg>;
}
