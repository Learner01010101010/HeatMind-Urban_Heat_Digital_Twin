import type { InterventionResult } from "./api";

export type LabArea = "narhe" | "katraj" | "swargate";
export type LabMode = "demo" | "live";
export type LabKind = "trees" | "cool_pavement" | "shade_structure" | "water_refill";
export const AREAS: Record<LabArea, string> = { narhe: "Narhe", katraj: "Katraj", swargate: "Swargate" };
/** Published reference costs; the catalogue ships the arithmetic behind each one. */
export const DEFAULT_COSTS: Record<LabKind, number> = { trees: 8000, cool_pavement: 48000, shade_structure: 134000, water_refill: 500000 };
export const MAX_BUDGET = 20_000_000;
export const MAX_UNIT_COST = 2_000_000;
export const KIND_LABELS: Record<LabKind, string> = { trees: "Mature tree canopy", cool_pavement: "Cool pavement", shade_structure: "Shade structure", water_refill: "Water refill proposal" };
export const KIND_COLORS: Record<LabKind, string> = { trees: "#8ad8b0", cool_pavement: "#a9d7fa", shade_structure: "#d0bdfa", water_refill: "#77d9f5" };
export const money = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

export interface LabFeasibility { ok: boolean; open_ground_m2: number; reason: string }
export interface LabSite {
  id: string; name: string; lat: number; lon: number;
  before: { feels_c: number; shaded_pct: number };
  sample: { surface_c: number; air_c: number; feels_c: number };
  choices: Record<Exclude<LabKind, "water_refill">, InterventionResult>;
  /** Per-kind buildability from the building/road/water/canopy rasters. */
  feasible: Partial<Record<LabKind, LabFeasibility>>;
}
export interface LabKindInfo { label: string; cost: number; color: string; basis: string; source: string }
export interface LabCatalog {
  area: LabArea; area_name: string; mode: LabMode; time: string; weather_source: string;
  center: [number, number]; bbox: [number, number, number, number]; note: string;
  roads: { name: string; points: [number, number][] }[]; sites: LabSite[];
  kinds: Record<LabKind, LabKindInfo>;
}
export interface LabProject { site_id: string; kind: LabKind }
export interface CoolingPlan {
  projects: (LabProject & { name: string; cost: number; lat: number; lon: number; result: InterventionResult | null })[];
  spent: number; remaining: number; before_c: number | null; after_c: number | null;
  reduction_c: number; evaluated_ground_m2: number; proposed_water_points: number; method: string;
  /** Why the budget was or was not fully allocated. */
  allocation_note: string;
}
async function request<T>(path: string, json?: unknown, signal?: AbortSignal): Promise<T> {
  const timer = AbortSignal.timeout(25000);
  const response = await fetch(`/api/city-lab/${path}`, {
    method: json === undefined ? "GET" : "POST", headers: json === undefined ? undefined : { "Content-Type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json), signal: signal ? AbortSignal.any([signal, timer]) : timer,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Check the input values and try again.");
  return data;
}
export const cityLabApi = {
  catalog: (area: LabArea, mode: LabMode, signal?: AbortSignal) => request<LabCatalog>(`catalog?area=${area}&mode=${mode}`, undefined, signal),
  plan: (area: LabArea, mode: LabMode, budget: number, costs: Record<LabKind, number>, projects?: LabProject[], catalogTime?: string) => request<CoolingPlan>("plan", { area, mode, budget, costs, projects, catalog_time: catalogTime }),
};

export function downloadText(name: string, content: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
