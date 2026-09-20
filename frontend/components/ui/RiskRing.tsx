"use client";

import { riskColor } from "@/lib/heatColorScale";
import AnimatedNumber from "./AnimatedNumber";

/** 0–100 heat-risk gauge with a gradient arc and glow. */
export default function RiskRing({ score, size = 64, stroke = 6, label }: { score: number; size?: number; stroke?: number; label?: string }) {
  const r = size / 2 - stroke;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const color = riskColor(score);
  const id = `rr-${size}-${stroke}`;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`Heat risk ${Math.round(score)} of 100`}>
      <svg width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#facc15" />
            <stop offset="1" stopColor={color} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,.07)" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          style={{ transition: "stroke-dashoffset .5s cubic-bezier(.16,1,.3,1), stroke .4s", filter: `drop-shadow(0 0 6px ${color}66)` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="font-semibold tracking-tight" style={{ fontSize: Math.round(size * 0.32), color }}>
          <AnimatedNumber value={score} duration={350} />
        </span>
        {label && <span className="text-[9px] uppercase tracking-[0.12em] text-ink-400 mt-0.5">{label}</span>}
      </div>
    </div>
  );
}
