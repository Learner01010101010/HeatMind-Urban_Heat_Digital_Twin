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
      className={`press glass flex items-center justify-center gap-2 rounded-full text-[14px] font-semibold ${compact ? "w-11 h-11" : "h-12 pl-3.5 pr-4"} ${active ? "glow-pulse bg-ink-100 text-ink-950" : "text-ink-200"}`}
      aria-label="Add a community water or rest point"
      aria-pressed={active}
    >
      <Droplets size={16} />
      {compact ? null : active ? "Tap the map" : "Add water point"}
    </button>
  );
}
