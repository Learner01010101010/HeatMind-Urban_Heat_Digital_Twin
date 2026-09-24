"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import AddPoiButton from "@/components/hud/AddPoiButton";
import AddPoiForm from "@/components/hud/AddPoiForm";
import EquityToggle from "@/components/hud/EquityToggle";
import { InsightChip, InsightPanel } from "@/components/hud/InsightChip";
import InterventionPanel from "@/components/hud/InterventionPanel";
import ModeToggle from "@/components/hud/ModeToggle";
import { ProfileButton, ProfilePanel } from "@/components/hud/Profile";
import RouteSheet from "@/components/hud/RouteSheet";
import SearchPill from "@/components/hud/SearchPill";
import SimulateButton from "@/components/hud/SimulateButton";
import Timeline from "@/components/hud/Timeline";
import Drawer from "@/components/ui/Drawer";
import { runCompare } from "@/lib/actions";
import { useFrameLoader, useHydrated } from "@/lib/hooks";
import { INTERVENTION_STYLE } from "@/lib/interventionStyle";
import { useClock, useMap, usePrefs, type PickMode } from "@/lib/store";
import { useMedia } from "@/lib/useMedia";

const TwinMap = dynamic(() => import("@/components/map/TwinMap"), { ssr: false, loading: () => <div className="absolute inset-0 bg-ink-950" /> });

function pickModeLabel(pickMode: PickMode): string {
  if (pickMode === "origin") return "Tap the map to set the start";
  if (pickMode === "destination") return "Tap the map to set the destination";
  if (pickMode === "trees" || pickMode === "cool_pavement" || pickMode === "shade_structure") {
    return `Tap the map to preview ${INTERVENTION_STYLE[pickMode].short.toLowerCase()} here`;
  }
  if (pickMode === "add_poi") return "Tap the map where the water/rest/shade point is";
  return "";
}

export default function Home() {
  const router = useRouter();
  const hydrated = useHydrated();
  const wide = useMedia("(min-width: 768px)");
  useFrameLoader();

  const panel = useMap((s) => s.panel);
  const compare = useMap((s) => s.compare);
  const loading = useMap((s) => s.loading);
  const error = useMap((s) => s.error);
  const pickMode = useMap((s) => s.pickMode);
  const set = useMap((s) => s.set);
  const base = useClock((s) => s.base);
  const close = () => set({ panel: null });

  useEffect(() => {
    if (hydrated && !usePrefs.getState().onboarded) router.replace("/onboarding");
  }, [hydrated, router]);

  // Live re-baselining: every 5 minutes the active trip is re-scored against the new "now".
  const lastBase = useRef(base);
  useEffect(() => {
    if (lastBase.current === base) return;
    lastBase.current = base;
    const m = useMap.getState();
    if (m.origin && m.destination && !m.tempDelta && !m.simOffsetMin) void runCompare({ silent: true });
  }, [base]);

  const sheet = compare ? (
    <RouteSheet compare={compare} variant={wide ? "side" : "bottom"} />
  ) : loading ? (
    <div className={`glass-strong skeleton rounded-[26px] ${wide ? "w-[340px] h-[240px]" : "w-full h-[118px]"}`} />
  ) : null;

  return (
    <main className="fixed inset-0 overflow-clip bg-ink-950">
      <TwinMap />

      {/* ── top: search · (global nav is centred by the layout) · mode · profile ── */}
      <div className="absolute top-0 inset-x-0 z-30 p-3 md:p-5 pt-[max(12px,env(safe-area-inset-top))] pointer-events-none">
        <div className="flex items-start gap-2.5">
          <div className="pointer-events-auto flex-1 md:flex-none min-w-0">
            <SearchPill />
          </div>
          <div className="pointer-events-auto ml-auto flex items-center gap-2.5">
            <div className="hidden md:block">
              <ModeToggle />
            </div>
            <div className="hidden md:block">
              <EquityToggle />
            </div>
            <ProfileButton />
          </div>
        </div>
      </div>

      {/* ── desktop: routes dock on the LEFT, below search, out of the map's centre ── */}
      {wide && sheet && <div className="absolute left-5 top-[84px] z-30">{sheet}</div>}

      {/* ── phone: small round controls on the right edge ── */}
      {!wide && (
        <div className="absolute right-3 top-[76px] z-30 flex flex-col gap-2.5">
          <ModeToggle compact />
          <EquityToggle compact />
          <InsightChip compact />
          <SimulateButton compact />
          <InterventionPanel compact />
          <AddPoiButton compact />
        </div>
      )}

      {(error || pickMode) && (
        <div className="absolute top-20 md:top-[84px] left-1/2 -translate-x-1/2 z-40 rise-in">
          <div className="glass-strong flex items-center gap-3 rounded-full pl-4 pr-2 h-11 text-[13px]">
            <span className={error ? "text-red-300" : "text-cool-300"}>{error ?? pickModeLabel(pickMode)}</span>
            <button onClick={() => set({ error: null, pickMode: null })} className="grid place-items-center w-7 h-7 rounded-full hover:bg-white/10 text-ink-300" aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* ── bottom ── */}
      {wide ? (
        <div className="absolute bottom-0 inset-x-0 z-30 p-5 pointer-events-none flex items-end gap-3">
          <div className="pointer-events-auto shrink-0">
            <InsightChip />
          </div>
          <div className="pointer-events-auto flex-1 min-w-0 max-w-[600px] mx-auto">
            <Timeline />
          </div>
          <div className="pointer-events-auto shrink-0 flex items-end gap-3">
            <AddPoiButton />
            <InterventionPanel />
            <SimulateButton />
          </div>
        </div>
      ) : (
        <div className="absolute inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-30 p-2 flex flex-col gap-2 pointer-events-none">
          {sheet && <div className="pointer-events-auto">{sheet}</div>}
          <div className="pointer-events-auto">
            <Timeline compact />
          </div>
        </div>
      )}

      {/* ── on-demand drawers ── */}
      <Drawer open={panel === "insight"} onClose={close} eyebrow="Heat insights · live" title="One number isn't enough">
        <InsightPanel />
      </Drawer>
      <Drawer open={panel === "profile"} onClose={close} eyebrow="Profile" title="You & your settings">
        <ProfilePanel />
      </Drawer>

      <AddPoiForm />
    </main>
  );
}
