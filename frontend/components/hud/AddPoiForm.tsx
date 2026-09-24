"use client";

import { Droplets, Loader2, TreePine, Umbrella, X } from "lucide-react";
import { useState } from "react";
import { cancelAddPoi, submitCommunityPoi } from "@/lib/actions";
import type { CommunityPoiKind } from "@/lib/api";
import { useMap } from "@/lib/store";

const KINDS: { id: CommunityPoiKind; label: string; icon: React.ElementType; color: string }[] = [
  { id: "water", label: "Water", icon: Droplets, color: "#38bdf8" },
  { id: "rest", label: "Rest", icon: Umbrella, color: "#a78bfa" },
  { id: "shade", label: "Shade", icon: TreePine, color: "#2dd4bf" },
];

/** SDG 6 — floating form for the point the user just tapped on the map. */
export default function AddPoiForm() {
  const draft = useMap((s) => s.addPoiDraft);
  const [kind, setKind] = useState<CommunityPoiKind>("water");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (!draft) return null;

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const r = await submitCommunityPoi(kind, name.trim());
    setBusy(false);
    if (r) {
      setDone(true);
      setTimeout(() => setDone(false), 2200);
      setName("");
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-end sm:place-items-center pointer-events-none p-3">
      <div className="glass-strong pointer-events-auto w-full sm:w-[320px] rounded-[26px] p-4 pop-in" role="dialog" aria-label="Add a community water or rest point">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[15px] font-semibold text-ink-100 tracking-tight">Add a cooling point · SDG 6</div>
          <button onClick={cancelAddPoi} className="press grid place-items-center w-7 h-7 rounded-full hover:bg-white/10 text-ink-300" aria-label="Cancel">
            <X size={14} />
          </button>
        </div>
        <p className="text-[12px] text-ink-400 mb-3 leading-snug">
          At {draft.lat.toFixed(5)}, {draft.lon.toFixed(5)}. Submissions are reviewed before appearing for everyone — you&apos;ll see yours right away as pending.
        </p>

        <div className="flex gap-1.5 mb-3">
          {KINDS.map((k) => (
            <button
              key={k.id}
              onClick={() => setKind(k.id)}
              className={`press flex-1 flex flex-col items-center gap-1 rounded-2xl py-2.5 transition-colors ${kind === k.id ? "bg-white/[0.1]" : "bg-white/[0.05] hover:bg-white/[0.08]"}`}
              style={kind === k.id ? { boxShadow: `inset 0 0 0 1.5px ${k.color}` } : undefined}
            >
              <k.icon size={16} style={{ color: k.color }} />
              <span className="text-[11px] font-semibold text-ink-100">{k.label}</span>
            </button>
          ))}
        </div>

        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="What is it? e.g. Free water tap near canteen"
          maxLength={80}
          className="w-full rounded-2xl bg-white/[0.06] px-3.5 py-2.5 text-[13px] text-ink-100 placeholder:text-ink-500 outline-none focus:bg-white/[0.09]"
        />

        <button
          onClick={submit}
          disabled={busy || !name.trim()}
          className="press w-full h-11 mt-3 rounded-full font-semibold text-[14px] text-ink-950 bg-ink-100 hover:bg-white flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : done ? "Submitted for review ✓" : "Submit for review"}
        </button>
      </div>
    </div>
  );
}
