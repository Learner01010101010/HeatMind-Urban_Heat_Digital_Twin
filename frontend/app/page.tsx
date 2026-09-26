"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import BreakSheet from "@/components/hud/BreakSheet";
import EquityToggle from "@/components/hud/EquityToggle";
import { InsightChip, InsightPanel } from "@/components/hud/InsightChip";
import InterventionPanel from "@/components/hud/InterventionPanel";
import MyLocation from "@/components/hud/MyLocation";
import ModeToggle from "@/components/hud/ModeToggle";
import ModeSelector from "@/components/hud/ModeSelector";
import NavHud from "@/components/hud/NavHud";
import { ProfileButton, ProfilePanel } from "@/components/hud/Profile";
import RouteSheet from "@/components/hud/RouteSheet";
import SearchPill from "@/components/hud/SearchPill";
import SimulateButton from "@/components/hud/SimulateButton";
import SunChip from "@/components/hud/SunChip";
import Timeline from "@/components/hud/Timeline";
import Drawer from "@/components/ui/Drawer";
import { runCompare } from "@/lib/actions";
import { useFrameLoader, useHydrated } from "@/lib/hooks";
import { INTERVENTION_STYLE } from "@/lib/interventionStyle";
import { useClock, useMap, usePrefs, type PickMode } from "@/lib/store";
import { useNav } from "@/lib/navigation";
import { useMedia } from "@/lib/useMedia";

const TwinMap = dynamic(() => import("@/components/map/TwinMap"), { ssr: false, loading: () => <div className="absolute inset-0 bg-ink-950" /> });

function pickModeLabel(pickMode: PickMode): string {
  if (pickMode === "origin") return "Tap the map to set the start";
  if (pickMode === "destination") return "Tap the map to set the destination";
  if (pickMode === "trees" || pickMode === "cool_pavement" || pickMode === "shade_structure") {
    return `Tap the map to preview ${INTERVENTION_STYLE[pickMode].short.toLowerCase()} here`;
  }
  return "";
}

export default function Home() {
  const router = useRouter();
  const hydrated = useHydrated();
  const onboarded = usePrefs((s) => s.onboarded);
  const wide = useMedia("(min-width: 768px)");
  useFrameLoader();

  const panel = useMap((s) => s.panel);
  const compare = useMap((s) => s.compare);
  const loading = useMap((s) => s.loading);
  const error = useMap((s) => s.error);
  const pickMode = useMap((s) => s.pickMode);
  const set = useMap((s) => s.set);
  const base = useClock((s) => s.base);
  const navActive = useNav((s) => s.active);
  const navRouteId = useNav((s) => s.routeId);
  const navRoute = navActive ? compare?.routes.find((r) => r.id === navRouteId) ?? null : null;
  const close = () => set({ panel: null });

  useEffect(() => {
    if (hydrated && !onboarded) router.replace("/onboarding");
  }, [hydrated, onboarded, router]);

  // Live re-baselining: every 5 minutes the active trip is re-scored against the new "now".
  const lastBase = useRef(base);
  useEffect(() => {
    if (lastBase.current === base) return;
    lastBase.current = base;
    const m = useMap.getState();
    if (m.origin && m.destination && !m.tempDelta && !m.simOffsetMin) void runCompare({ silent: true });
  }, [base]);

  // Guidance takes the screen. Route comparison, the forecast scrubber and the
  // intervention tools are all planning surfaces — they are answering a question the
  // traveller has already answered by starting, and on a phone held at walking pace
  // they are in the way of the one instruction that matters.
  const sheet = navRoute ? null : compare ? (
    <RouteSheet compare={compare} variant={wide ? "side" : "bottom"} />
  ) : loading ? (
    <div className={`glass-strong skeleton rounded-[26px] ${wide ? "w-[340px] h-[240px]" : "w-full h-[118px]"}`} />
  ) : null;

  // Don't flash the map/HUD before the redirect to /onboarding fires (or while prefs are still loading).
  if (!hydrated || !onboarded) return <main className="fixed inset-0 bg-ink-950" />;

  return (
    <main className="fixed inset-0 overflow-clip bg-ink-950">
      <TwinMap />

      {/* ── guidance: the only thing on screen while it runs ── */}
      {navRoute && (
        <div className="absolute top-0 inset-x-0 z-40 p-3 md:p-5 pt-[max(12px,env(safe-area-inset-top))] flex justify-center pointer-events-none">
          <NavHud route={navRoute} />
        </div>
      )}

      {/* ── top: search · (global nav is centred by the layout) · mode · profile ── */}
      <div className={`absolute top-0 inset-x-0 z-30 p-3 md:p-5 pt-[max(12px,env(safe-area-inset-top))] pointer-events-none ${navRoute ? "hidden" : ""}`}>
        <div className="flex items-start gap-2.5">
          <div className="pointer-events-auto flex-1 md:flex-none min-w-0 flex flex-col gap-2.5 items-start">
            <SearchPill />
            {/* Travel mode belongs with the trip inputs, not the view controls: it
                changes the answer, where Map/Heat Twin only changes the picture. */}
            <div className="hidden md:block">
              <ModeSelector />
            </div>
            {/* The route sheet belongs in this column, in flow, rather than pinned
                to its own absolute top. It used to sit at top-[84px] — a constant
                measured before the mode selector was added above it, which then
                landed the sheet straight on top of the mode row and left only its
                right edge showing. Stacking them means the two cannot collide
                whatever either one's height turns out to be. */}
            {wide && sheet}
          </div>
          <div className="pointer-events-auto ml-auto flex items-center gap-2.5">
            {/* The global nav is fixed to the centre of this same bar, so the view
                controls have to fit in what's left of it. Full-width pills need
                1152px before they clear the nav; below that they collapse to one
                grouped pill of icons rather than being drawn straight through. */}
            <div className="hidden md:flex xl:hidden glass rounded-full p-1.5 gap-1">
              <ModeToggle compact />
              <EquityToggle compact />
            </div>
            <div className="hidden xl:block">
              <ModeToggle />
            </div>
            <div className="hidden xl:block">
              <EquityToggle />
            </div>
            <ProfileButton />
          </div>
        </div>
      </div>

      {/* ── phone: one control rail on the right edge ──
           Grouped into a single surface rather than a column of free-floating
           circles: seven identical dark dots down the side of a phone read as
           clutter over the map, and gave no hint which of them do related jobs.
           The dividers do that instead — what you're looking at, what it says,
           what you can change. */}
      {!wide && (
        <div className={`absolute right-3 top-[76px] z-30 glass rounded-[26px] p-1.5 flex flex-col gap-1 ${navRoute ? "hidden" : ""}`}>
          <ModeToggle compact />
          <EquityToggle compact />
          <span className="h-px mx-2.5 bg-white/[0.07]" aria-hidden />
          <InsightChip compact />
          <span className="h-px mx-2.5 bg-white/[0.07]" aria-hidden />
          <MyLocation compact />
          <SimulateButton compact />
          <InterventionPanel compact />
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
      {navRoute ? null : wide ? (
        <div className="absolute bottom-0 inset-x-0 z-30 p-5 pointer-events-none flex items-end gap-3">
          <div className="pointer-events-auto shrink-0 flex flex-col items-start gap-2">
            {/* The sun readout sits with the timeline: scrubbing moves both the sun in
                the 3D sky and this number, which is what ties the two together. */}
            <SunChip />
            <InsightChip />
          </div>
          <div className="pointer-events-auto flex-1 min-w-0 max-w-[600px] mx-auto">
            <Timeline />
          </div>
          <div className="pointer-events-auto shrink-0 flex items-end gap-3">
            <InterventionPanel />
            <SimulateButton />
            <MyLocation />
          </div>
        </div>
      ) : (
        <div className="absolute inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-30 p-2 flex flex-col gap-2 pointer-events-none">
          <div className="pointer-events-auto self-center max-w-full overflow-x-auto no-scrollbar">
            <ModeSelector compact />
          </div>
          {sheet && <div className="pointer-events-auto">{sheet}</div>}
          <div className="pointer-events-auto">
            <Timeline compact />
          </div>
        </div>
      )}

      {/* ── on-demand drawers ── */}
      <BreakSheet />

      <Drawer open={panel === "insight"} onClose={close} eyebrow="Heat insights · live" title="One number isn't enough">
        <InsightPanel />
      </Drawer>
      <Drawer open={panel === "profile"} onClose={close} eyebrow="Profile" title="You & your settings">
        <ProfilePanel />
      </Drawer>

    </main>
  );
}
