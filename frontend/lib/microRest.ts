"use client";

import { create } from "zustand";

/**
 * Micro-rest scheduler — mock data, pure frontend.
 *
 * A delivery rider is not refusing to rest; they are refusing to lose a trip. The
 * gaps they already have — waiting on a pickup, a handover, a battery swap — are
 * rest they have already been paid for. This looks at one of those windows and asks
 * a single question: is there somewhere cool close enough to get to and back inside
 * it?
 *
 * The rule is deliberately the conservative one. A rest point qualifies only if the
 * round trip fits the window, `travel_time_min * 2 <= idle_duration_min`, leaving no
 * standing-around margin at all — so a suggestion never costs a trip. That is what
 * makes it a scheduling message rather than a wellness nag.
 *
 * Everything here is hardcoded. There is no order feed to read, so the windows are
 * fired as mock events; the shape below is what a real one would have to provide.
 */

export interface IdleWindow {
  event: string;
  duration_min: number;
  /** Plain-language label for the card. */
  label: string;
}

export interface RestPoint {
  id: string;
  name: string;
  travel_time_min: number;
  /** What is actually there — the reason it is worth the walk. */
  amenities: string[];
}

/** Mock order-status windows. A real feed would replace this array wholesale. */
export const IDLE_SCENARIOS: IdleWindow[] = [
  { event: "pickup_wait", duration_min: 8, label: "Pickup wait" },
  { event: "handover_queue", duration_min: 12, label: "Handover queue" },
  { event: "batch_gap", duration_min: 4, label: "Gap between batches" },
];

/** Mock rest points. Travel times are one-way, on the rider's own vehicle. */
export const REST_POINTS: RestPoint[] = [
  { id: "cool-corner", name: "Cool Corner", travel_time_min: 3, amenities: ["water", "shade"] },
  { id: "market-shelter", name: "Market shelter", travel_time_min: 5, amenities: ["shade", "seating"] },
  { id: "metro-concourse", name: "Metro concourse", travel_time_min: 9, amenities: ["air conditioning", "water"] },
];

/**
 * The best rest point reachable inside this window, or null.
 *
 * Nearest-first among those that fit, because the margin left over is the rider's,
 * not ours to spend on a nicer place further away.
 */
export function recommendRestPoint(idle: IdleWindow, points: RestPoint[] = REST_POINTS): RestPoint | null {
  return (
    points
      .filter((p) => p.travel_time_min * 2 <= idle.duration_min)
      .sort((a, b) => a.travel_time_min - b.travel_time_min)[0] ?? null
  );
}

interface MicroRestState {
  /** The idle window currently on screen, if any. */
  active: IdleWindow | null;
  /** Which mock scenario fires next. */
  next: number;
  fire: () => void;
  dismiss: () => void;
}

/**
 * Mock event source. `fire()` stands in for an order-status webhook; each call
 * raises the next hardcoded window so the card can be demonstrated repeatedly.
 */
export const useMicroRest = create<MicroRestState>()((set, get) => ({
  active: null,
  next: 0,
  fire: () => {
    const i = get().next % IDLE_SCENARIOS.length;
    set({ active: IDLE_SCENARIOS[i], next: i + 1 });
  },
  dismiss: () => set({ active: null }),
}));
