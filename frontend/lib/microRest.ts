"use client";

import { create } from "zustand";

export interface IdleWindow {
  id: number;
  label: string;
  readyAtMs: number;
  pickup: { lat: number; lon: number; label: string };
  source: "manual";
}

interface MicroRestState {
  active: IdleWindow | null;
  hidden: boolean;
  start: (durationMin: number, pickup: IdleWindow["pickup"]) => void;
  dismiss: () => void;
  show: () => void;
  finish: () => void;
}

// Independent session state. A responsive remount cannot restart the deadline.
export const useMicroRest = create<MicroRestState>()((set) => ({
  active: null,
  hidden: false,
  start: (durationMin, pickup) => {
    if (!Number.isFinite(durationMin) || durationMin < 1 || durationMin > 60) return;
    const now = Date.now();
    set({ active: { id: now, label: "Pickup wait", readyAtMs: now + durationMin * 60000, pickup, source: "manual" }, hidden: false });
  },
  dismiss: () => set({ hidden: true }),
  show: () => set({ hidden: false }),
  finish: () => set({ active: null, hidden: false }),
}));
