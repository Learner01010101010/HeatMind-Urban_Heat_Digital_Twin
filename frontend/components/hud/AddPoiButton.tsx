"use client";

import { Droplets } from "lucide-react";
import { useMap } from "@/lib/store";

/** SDG 6 — arms "tap the map to add a water/rest/shade point" mode. */
export default function AddPoiButton({ compact = false }: { compact?: boolean }) {
  const pickMode = useMap((s) => s.pickMode);
  const set = useMap((s) => s.set);
  const active = pickMode === "add_poi";

  return (
    <button
      onClick={() => set({ pickMode: active ? null : "add_poi", addPoiDraft: null })}
      className={`press glass flex items-center justify-center gap-2 rounded-full text-[14px] font-semibold ${compact ? "w-11 h-11" : "h-12 pl-3.5 pr-4"} ${active ? "glow-pulse" : ""}`}
      aria-label="Add a community water or rest point"
      aria-pressed={active}
      style={active ? { background: "linear-gradient(135deg, rgba(56,189,248,.95), rgba(167,139,250,.9))", color: "#04140f" } : undefined}
    >
      <Droplets size={16} className={active ? "" : "text-ink-200"} />
      {compact ? null : active ? "Tap the map" : "Add water point"}
    </button>
  );
}
