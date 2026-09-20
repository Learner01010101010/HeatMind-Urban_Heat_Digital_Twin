"use client";

import { Box, Map as MapIcon } from "lucide-react";
import { useMap } from "@/lib/store";

/** Map ↔ Heat Twin segmented control with a sliding indicator. */
export default function ModeToggle({ compact = false }: { compact?: boolean }) {
  const mode = useMap((s) => s.mode);
  const set = useMap((s) => s.set);
  if (compact) {
    const twin = mode === "twin";
    return (
      <button
        onClick={() => set({ mode: twin ? "map" : "twin" })}
        className="press glass grid place-items-center w-11 h-11 rounded-full"
        style={twin ? { background: "linear-gradient(135deg, rgba(251,138,31,.95), rgba(239,68,68,.9))" } : undefined}
        aria-label={twin ? "Switch to Map" : "Switch to Heat Twin (3D)"}
        aria-pressed={twin}
      >
        <Box size={18} className={twin ? "text-white" : "text-ink-200"} />
      </button>
    );
  }
  const items = [
    { id: "map" as const, label: "Map", icon: MapIcon },
    { id: "twin" as const, label: "Heat Twin", icon: Box },
  ];
  return (
    <div className="glass relative flex h-11 rounded-full p-1" role="tablist" aria-label="View mode">
      <span
        className="absolute top-1 bottom-1 rounded-full transition-all duration-500 [transition-timing-function:cubic-bezier(.16,1,.3,1)]"
        style={{
          left: mode === "map" ? 4 : "calc(50% + 0px)",
          width: "calc(50% - 4px)",
          background: mode === "twin" ? "linear-gradient(135deg, rgba(251,138,31,.9), rgba(239,68,68,.85))" : "rgba(255,255,255,.12)",
          boxShadow: mode === "twin" ? "0 6px 24px -6px rgba(239,68,68,.7)" : "none",
        }}
      />
      {items.map((it) => (
        <button
          key={it.id}
          role="tab"
          aria-selected={mode === it.id}
          onClick={() => set({ mode: it.id })}
          className={`press relative z-10 flex items-center justify-center gap-1.5 w-[104px] text-[13px] font-medium transition-colors ${mode === it.id ? "text-white" : "text-ink-300 hover:text-ink-100"}`}
        >
          <it.icon size={15} />
          {it.label}
        </button>
      ))}
    </div>
  );
}
