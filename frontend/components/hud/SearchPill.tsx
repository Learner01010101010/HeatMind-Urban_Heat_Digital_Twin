"use client";

import { ArrowRight, Crosshair, Loader2, MapPin, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Place } from "@/lib/api";
import { clearTrip, setEndpoint } from "@/lib/actions";
import { useZone } from "@/lib/hooks";
import { useMap } from "@/lib/store";

const short = (s: string) =>
  s
    .replace("TSSM Bhivarabai Sawant College of Engineering (BSCOER)", "TSSM BSCOER")
    .replace(" of Engineering and Research", "")
    .replace(/^Pinned · .*/, "Dropped pin");

export default function SearchPill() {
  const zone = useZone();
  const origin = useMap((s) => s.origin);
  const destination = useMap((s) => s.destination);
  const loading = useMap((s) => s.loading);
  const pickMode = useMap((s) => s.pickMode);
  const set = useMap((s) => s.set);
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<"origin" | "destination">("destination");
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const places = useMemo(() => zone.data?.places ?? [], [zone.data]);

  const matches = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (ql ? places.filter((p) => p.name.toLowerCase().includes(ql)) : places.filter((p) => p.featured).concat(places.filter((p) => !p.featured))).slice(0, 6);
  }, [q, places]);

  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 60);
  }, [open, field]);

  const choose = (p: Place) => {
    setEndpoint(field, { lat: p.lat, lon: p.lon, label: p.name });
    setQ("");
    const st = useMap.getState();
    if (field === "origin" && !st.destination) setField("destination");
    else setOpen(false);
  };

  const hasTrip = origin || destination;

  return (
    <div className="relative w-full md:w-[300px] lg:w-[360px]">
      <div className="glass flex items-center h-13 rounded-full pl-4 pr-1.5 gap-2.5">
        {loading ? <Loader2 size={18} className="animate-spin text-cool-300 shrink-0" /> : <Search size={18} className="text-ink-300 shrink-0" />}
        <button
          onClick={() => {
            setField(origin && !destination ? "destination" : destination && !origin ? "origin" : "destination");
            setOpen(true);
          }}
          className="flex-1 min-w-0 text-left h-full flex items-center"
          aria-label="Search places"
        >
          {pickMode ? (
            <span className="text-[15px] text-cool-300 font-medium">Tap the map to drop the {pickMode === "origin" ? "start" : "destination"}…</span>
          ) : hasTrip ? (
            <span className="flex items-center gap-2 min-w-0 text-[15px] font-medium text-ink-100">
              <span className="truncate">{origin ? short(origin.label) : "Choose start"}</span>
              <ArrowRight size={14} className="text-ink-400 shrink-0" />
              <span className="truncate">{destination ? short(destination.label) : "Where to?"}</span>
            </span>
          ) : (
            <span className="text-[15px] text-ink-300">Where to?</span>
          )}
        </button>
        {hasTrip && (
          <button onClick={clearTrip} className="press grid place-items-center w-10 h-10 rounded-full hover:bg-white/8 text-ink-300" aria-label="Clear trip">
            <X size={17} />
          </button>
        )}
      </div>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className="glass-strong absolute left-0 right-0 top-full mt-2 z-20 rounded-[26px] p-2 rise-in">
            <div className="rounded-[20px] bg-white/[0.03] border border-white/[0.05]">
              {(["origin", "destination"] as const).map((f) => {
                const val = f === "origin" ? origin : destination;
                const on = field === f;
                const dot = f === "origin" ? "#6fbf5e" : "#f472b6";
                return (
                  <div
                    key={f}
                    className={`flex items-center gap-3 px-4 h-12 transition-colors ${f === "origin" ? "border-b border-white/[0.05]" : ""}`}
                    style={on ? { backgroundColor: "rgba(255,255,255,0.07)", boxShadow: `inset 3px 0 0 ${dot}` } : undefined}
                  >
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: dot }} />
                    <span className={`text-[10.5px] font-bold uppercase tracking-wide shrink-0 w-9 ${on ? "text-ink-200" : "text-ink-500"}`}>
                      {f === "origin" ? "Start" : "To"}
                    </span>
                    {on ? (
                      <input
                        ref={input}
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && matches[0]) choose(matches[0]);
                          if (e.key === "Escape") setOpen(false);
                        }}
                        placeholder={val ? short(val.label) : f === "origin" ? "Search or tap the map" : "Where to?"}
                        className="flex-1 min-w-0 bg-transparent outline-none text-[15px] text-ink-100 placeholder:text-ink-400"
                        aria-label={f === "origin" ? "Start" : "Destination"}
                      />
                    ) : (
                      <button onClick={() => setField(f)} className="flex-1 min-w-0 text-left text-[15px] truncate text-ink-300 hover:text-ink-100">
                        {val ? short(val.label) : <span className="text-ink-500">{f === "origin" ? "Start" : "Where to?"}</span>}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        set({ pickMode: f });
                        setOpen(false);
                      }}
                      className="press grid place-items-center w-8 h-8 rounded-full hover:bg-white/8 text-ink-400 hover:text-ink-100"
                      aria-label={`Drop ${f} on the map`}
                      title="Pick on map"
                    >
                      <Crosshair size={15} />
                    </button>
                  </div>
                );
              })}
            </div>
            <ul className="mt-1.5 max-h-80 overflow-y-auto scroll-thin">
              {matches.map((p) => (
                <li key={p.id}>
                  <button onClick={() => choose(p)} className="w-full flex items-center gap-3 rounded-2xl px-3 py-2.5 hover:bg-white/5 text-left">
                    <span className="grid place-items-center w-9 h-9 rounded-xl bg-white/5 text-ink-300">
                      <MapPin size={16} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[14px] font-medium text-ink-100 truncate">{short(p.name)}</span>
                      <span className="block text-[12px] text-ink-400 capitalize">{p.kind.replace(/_/g, " ")}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
