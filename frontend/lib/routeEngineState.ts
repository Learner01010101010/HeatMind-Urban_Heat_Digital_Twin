"use client";

import { create } from "zustand";
import type { CompareResult, RouteObjective } from "./api";

export interface LiveRecheckResult {
  arrived: boolean;
  should_switch: boolean;
  message: string;
  changes: string[];
  checked_at: string;
  comparison: CompareResult | null;
}

export interface PendingRouteChange {
  response: LiveRecheckResult;
  compareId: string;
  routeId: string;
  navigating: boolean;
  source: "gps" | "preview" | "planned";
}

interface EngineState {
  objective: RouteObjective;
  enabled: boolean;
  checking: boolean;
  lastChecked: string | null;
  message: string;
  error: string | null;
  source: "gps" | "preview" | "planned";
  changes: string[];
  switches: number;
  pending: PendingRouteChange | null;
  demoHeatDelta: number;
  set: (patch: Partial<Omit<EngineState, "set">>) => void;
}

// Separate session state; does not change persona, heat model or scoring weights.
export const useRouteEngine = create<EngineState>()((set) => ({
  objective: "balanced", enabled: true, checking: false, lastChecked: null,
  message: "Ready to monitor when navigation starts.", error: null, source: "planned",
  changes: [], switches: 0, pending: null, demoHeatDelta: 0, set,
}));
