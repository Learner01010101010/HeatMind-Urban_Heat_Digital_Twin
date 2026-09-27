"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { BreakStop, CompareResult, InterventionKind, InterventionResult, Persona, Scenario, TravelMode } from "./api";

/** Every calculation runs on live conditions at the user's current time. */
export const SCENARIO: Scenario = "live";

// ---------- live clock ----------
const BUCKET_MS = 5 * 60 * 1000; // forecast baseline refreshes every 5 minutes

interface ClockState {
  now: number; // ms, ticks every second
  base: string; // ISO of the current 5-minute baseline all forecasts are anchored to
  tick: () => void;
}

const baseOf = (ms: number) => new Date(Math.floor(ms / BUCKET_MS) * BUCKET_MS).toISOString();

export const useClock = create<ClockState>()((set, get) => ({
  now: Date.now(),
  base: baseOf(Date.now()),
  tick: () => {
    const now = Date.now();
    const base = baseOf(now);
    set(base === get().base ? { now } : { now, base });
  },
}));

let clockTimer: ReturnType<typeof setInterval> | null = null;
/** Start the app-wide live clock (idempotent). */
export function startClock() {
  if (clockTimer || typeof window === "undefined") return;
  useClock.getState().tick();
  clockTimer = setInterval(() => useClock.getState().tick(), 1000);
}
import type { Units } from "./heatColorScale";

// ---------- persisted user preferences ----------
interface Prefs {
  onboarded: boolean;
  sessionToken: string;
  userId: number | null;
  persona: Persona;
  /** How they travel. Persisted like persona: most people commute the same way daily. */
  mode: TravelMode;
  units: Units;
  seniorMode: boolean;
  reduceMotion: boolean;
  set: (p: Partial<Omit<Prefs, "set">>) => void;
}

function newToken() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `hm-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

// Module-scope, not component-scope: resets only on a real page load (fresh JS
// evaluation), unlike PrefsEffect's mount effect, which the Next.js router can
// re-run mid-session (e.g. its passive-effect "reconnect" during a transition).
// Guards onRehydrateStorage below so it only forces `onboarded` false once per
// real visit, instead of clobbering it back after onboarding just set it true.
let forcedOnboardedThisLoad = false;

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      onboarded: false,
      sessionToken: "",
      userId: null,
      persona: "student",
      mode: "walk",
      units: "C",
      seniorMode: false,
      reduceMotion: false,
      set: (p) => set(p),
    }),
    {
      name: "heatmind-prefs",
      storage: createJSONStorage(() => localStorage),
      // Rehydrated after mount (see PrefsEffect) so server and first client render match.
      skipHydration: true,
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const patch: Partial<Prefs> = state.sessionToken ? {} : { sessionToken: newToken() };
        // Only force false once per real page load — see forcedOnboardedThisLoad above.
        // Also self-heals browsers with an old persisted `onboarded: true` from before
        // this became a non-persisted field.
        if (!forcedOnboardedThisLoad) {
          forcedOnboardedThisLoad = true;
          patch.onboarded = false;
        }
        if (Object.keys(patch).length) state.set(patch);
      },
      // `onboarded` is intentionally NOT persisted: every fresh visit starts at the
      // onboarding screen again, even for returning sessions. Everything else (session
      // token, persona, units, accessibility prefs) still carries over.
      partialize: (state) => ({
        sessionToken: state.sessionToken,
        userId: state.userId,
        persona: state.persona,
        mode: state.mode,
        units: state.units,
        seniorMode: state.seniorMode,
        reduceMotion: state.reduceMotion,
      }),
    },
  ),
);

// ---------- timeline ----------
/** Forecast keyframes served by the backend (minutes from now). */
export const TIMELINE = [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180];
export const TIMELINE_MAX = 180;
export const TIMELINE_MARKS: [number, string][] = [
  [0, "Now"],
  [30, "+30m"],
  [60, "+1h"],
  [120, "+2h"],
  [180, "+3h"],
];

/** Position on the continuous timeline → neighbouring keyframes + blend factor. */
export function keyframes(min: number): { i0: number; i1: number; t: number } {
  const step = TIMELINE[1] - TIMELINE[0];
  const x = Math.max(0, Math.min(TIMELINE_MAX, min)) / step;
  const i0 = Math.min(Math.floor(x), TIMELINE.length - 1);
  const i1 = Math.min(i0 + 1, TIMELINE.length - 1);
  return { i0, i1, t: i1 === i0 ? 0 : x - i0 };
}

/** Linear interpolation of a per-keyframe series at a continuous timeline position. */
export function atTime(series: number[], min: number): number {
  const { i0, i1, t } = keyframes(min);
  const a = series[i0] ?? series[series.length - 1];
  const b = series[i1] ?? a;
  return a + (b - a) * t;
}

// ---------- session / map state ----------
export interface Endpoint {
  lat: number;
  lon: number;
  label: string;
}

export type MapMode = "map" | "twin";
export type Panel = null | "insight" | "profile";
export type RouteView = "list" | "detail";
export type PickMode = null | "origin" | "destination" | InterventionKind;

interface MapState {
  mode: MapMode;
  origin: Endpoint | null;
  destination: Endpoint | null;
  pickMode: PickMode;
  compare: CompareResult | null;
  anchorCompareId: string | null;
  selectedRouteId: string | null;
  panel: Panel;
  routeView: RouteView; // left route sheet: comparison list or one route's detail
  sheetOpen: boolean; // route sheet expanded (vs. collapsed to its header)
  timeMin: number; // continuous 0…180
  /**
   * True while the timeline is being dragged or played.
   *
   * The 3D twin re-marches its shadow buffer whenever the sun moves, and a scrub
   * delivers a burst of positions that would each force one. Knowing a gesture is in
   * progress lets it coarsen the step during the drag and land the exact position
   * once the finger lifts. Only the timeline can tell the difference between that
   * and the sun moving because time passed.
   */
  timeScrubbing: boolean;
  simOffsetMin: number;
  tempDelta: number;
  loading: boolean;
  error: string | null;
  flyTo: { lat: number; lon: number; zoom?: number; nonce: number } | null;
  /**
   * Where the twin should build itself when the map first opens.
   *
   * Onboarding resolves this before letting anyone through -- from a real position
   * fix where possible, otherwise from a start the user picks explicitly. The map
   * has no other opinion about where to render: without this it draws nothing,
   * which is the point. The zone spans Narhe to Swargate and only the streets
   * around the user are worth building.
   */
  startAt: { lat: number; lon: number; label: string } | null;
  interventionResults: InterventionResult[];
  interventionBusy: boolean;
  equityOn: boolean;
  /** Progressive reveal: only draw the twin where the user has been. */
  revealOn: boolean;
  /** The hydration or rest stop whose detail sheet is open, if any. */
  selectedBreak: BreakStop | null;
  /** Emergency sheet: nearest water, shade and rest from where the user is now. */
  emergencyOpen: boolean;
  /**
   * Whether the "start from where I am" panel is open.
   *
   * In the store rather than in the component because the component does not
   * survive its own state changes: starting a simulated trip swaps the bottom bar
   * for the guidance one, which unmounts that MyLocation and mounts another. With
   * the flag local, cancelling a trip made the panel vanish instead of returning to
   * its opening state, which is precisely when someone needs it back.
   */
  locationPanelOpen: boolean;
  set: (p: Partial<Omit<MapState, "set">>) => void;
}

export const useMap = create<MapState>()((set) => ({
  mode: "map",
  origin: null,
  destination: null,
  pickMode: null,
  compare: null,
  anchorCompareId: null,
  selectedRouteId: null,
  panel: null,
  routeView: "list",
  sheetOpen: true,
  timeMin: 0,
  timeScrubbing: false,
  simOffsetMin: 0,
  tempDelta: 0,
  loading: false,
  error: null,
  flyTo: null,
  startAt: null,
  interventionResults: [],
  interventionBusy: false,
  equityOn: false,
  // Corridor-first: the twin draws where you are and where you are going, not the
  // whole zone. MyLocation still offers "Show whole zone" to override it.
  revealOn: true,
  selectedBreak: null,
  emergencyOpen: false,
  locationPanelOpen: false,
  set: (p) => set(p),
}));
