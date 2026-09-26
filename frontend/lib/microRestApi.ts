import type { Persona } from "./api";

export interface RestCandidate {
  id: string; name: string; lat: number; lon: number;
  outbound_min: number; return_min: number; rest_min: number; buffer_min: number; required_min: number;
  amenities: string[]; shade_pct: number; water: boolean; seating: boolean; feels_c: number;
  cooler_by_c: number; score: number; leave_by: string; hours_status: string;
}
export interface RestSchedule {
  calculated_at: string; ready_at: string; status: "recommended" | "no_fit" | "expired";
  candidates: RestCandidate[]; weather_source: string | null; note: string;
}

// Recheck feasibility on each clock tick without requesting the graph every second.
export function availableRest(schedule: RestSchedule, nowMs: number): RestCandidate | null {
  const remaining = (Date.parse(schedule.ready_at) - nowMs) / 60000;
  return schedule.candidates.find((p) => p.required_min <= remaining) ?? null;
}

export function restMinutes(point: RestCandidate, remainingMin: number): number {
  return Math.max(0, Math.min(5, Math.floor((remainingMin - point.outbound_min - point.return_min - point.buffer_min + 1e-9) * 10) / 10));
}

export async function requestRestSchedule(body: {
  origin: { lat: number; lon: number }; pickup: { lat: number; lon: number };
  ready_at: string; persona: Persona;
}, signal: AbortSignal): Promise<RestSchedule> {
  const response = await fetch("/api/micro-rest/recommend", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Rest suggestions are temporarily unavailable.");
  return data;
}
