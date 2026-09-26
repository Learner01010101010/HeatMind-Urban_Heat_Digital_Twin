import type { InterventionResult } from "./api";

export type LabArea = "narhe" | "katraj" | "swargate";
export type LabMode = "demo" | "live";
export type LabKind = "trees" | "cool_pavement" | "shade_structure" | "water_refill";
export type TemperatureMetric = "surface_c" | "air_c" | "feels_c";
export const AREAS: Record<LabArea, string> = { narhe: "Narhe", katraj: "Katraj", swargate: "Swargate" };
export const DEFAULT_COSTS: Record<LabKind, number> = { trees: 25000, cool_pavement: 45000, shade_structure: 60000, water_refill: 30000 };
export const KIND_LABELS: Record<LabKind, string> = { trees: "Mature tree canopy", cool_pavement: "Cool pavement", shade_structure: "Shade structure", water_refill: "Water refill proposal" };
export const KIND_COLORS: Record<LabKind, string> = { trees: "#8ad8b0", cool_pavement: "#a9d7fa", shade_structure: "#d0bdfa", water_refill: "#77d9f5" };
export const money = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

export interface LabSite {
  id: string; name: string; lat: number; lon: number;
  before: { feels_c: number; shaded_pct: number };
  sample: { surface_c: number; air_c: number; feels_c: number };
  choices: Record<Exclude<LabKind, "water_refill">, InterventionResult>;
}
export interface LabCatalog {
  area: LabArea; area_name: string; mode: LabMode; time: string; weather_source: string;
  center: [number, number]; bbox: [number, number, number, number]; note: string;
  roads: { name: string; points: [number, number][] }[]; sites: LabSite[];
  validation_sites: Pick<LabSite, "id" | "name" | "lat" | "lon" | "sample">[];
}
export interface LabProject { site_id: string; kind: LabKind }
export interface CoolingPlan {
  projects: (LabProject & { name: string; cost: number; lat: number; lon: number; result: InterventionResult | null })[];
  spent: number; remaining: number; before_c: number | null; after_c: number | null;
  reduction_c: number; evaluated_ground_m2: number; proposed_water_points: number; method: string;
}
export interface ValidationRow {
  label: string; lat: number; lon: number; time: string; metric: TemperatureMetric;
  predicted_c: number; observed_c: number; error_c: number; reference_source: string; weather_source: string;
}
export interface ValidationResult {
  source: "synthetic_demo" | "uploaded_observations"; metric: TemperatureMetric; metric_label: string;
  rows: ValidationRow[]; tolerance_c: number; note: string;
  stats: { count: number; mae_c: number; rmse_c: number; bias_c: number; within_tolerance_pct: number };
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
  demo: (area: LabArea, metric: TemperatureMetric, tolerance: number) => request<ValidationResult>(`validation/demo?area=${area}&metric=${metric}&tolerance_c=${tolerance}`),
  validate: (csv: string, tolerance: number) => request<ValidationResult>("validation", { csv_text: csv, tolerance_c: tolerance }),
};

const csvCell = (s: string | number) => {
  const value = typeof s === "string" && /^[=+\-@\t\r]/.test(s) ? `'${s}` : String(s);
  return `"${value.replaceAll('"', '""')}"`;
};
export function predictionTemplate(data: LabCatalog, metric: TemperatureMetric) {
  return "lat,lon,time,metric,observed_c,predicted_c,label\n" + data.validation_sites.map((s) =>
    [s.lat, s.lon, data.time, metric, "", s.sample[metric], s.name].map(csvCell).join(",")
  ).join("\n");
}
export function validationCsv(result: ValidationResult) {
  return "lat,lon,time,metric,observed_c,predicted_c,error_c,reference_source,label\n" + result.rows.map((r) =>
    [r.lat, r.lon, r.time, r.metric, r.observed_c, r.predicted_c, r.error_c, r.reference_source, r.label].map(csvCell).join(",")
  ).join("\n");
}
export function downloadText(name: string, content: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
