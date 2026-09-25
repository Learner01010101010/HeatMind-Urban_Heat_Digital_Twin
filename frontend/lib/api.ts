// Typed fetch wrappers for the HeatMind FastAPI backend (proxied at /api via next.config rewrites).

export type Persona = "student" | "worker" | "senior" | "cyclist" | "gig_worker";
export type Scenario = "demo" | "live";

export interface Weather {
  air_c: number;
  rh: number;
  cloud_pct: number;
  wind_ms: number;
  source: "demo_scenario" | "open_meteo" | "climatology_fallback";
}

export interface Spot {
  lat: number;
  lon: number;
  feels_c: number;
  sun_exposure: number;
  label: string;
}

export interface TwinStats {
  city_level_c: number;
  city_level_feels_c: number;
  street_min_c: number;
  street_max_c: number;
  street_mean_c: number;
  street_spread_c: number;
  pct_above_high: number;
  pct_shaded: number;
  hottest: Spot;
  coolest: Spot;
}

export interface Conditions {
  time: string;
  scenario: Scenario;
  temp_delta_c: number;
  weather: Weather;
  sun: {
    elevation_deg: number;
    azimuth_deg: number;
    intensity: number;
    is_day: boolean;
    /** Fraction of clear-sky irradiance reaching the ground. */
    clearness?: number;
    /** "measured" (observed shortwave) or "modelled_from_cloud". */
    clearness_source?: string;
  };
  stats: TwinStats;
}

export interface TwinGrid {
  rows: number;
  cols: number;
  cell_m: number;
  bbox: [number, number, number, number];
  heat_b64: string;
  shade_b64: string;
}

export interface TwinResponse extends Conditions {
  grid: TwinGrid;
}

export interface Place {
  id: string;
  name: string;
  kind: string;
  lat: number;
  lon: number;
  featured?: boolean;
}

export interface Poi {
  id: string;
  type: "water" | "rest" | "shade" | "cooling_center";
  name: string;
  lat: number;
  lon: number;
  source: "osm" | "seeded";
  detail?: string;
  at_m?: number;
  off_route_m?: number;
}

export interface Factor {
  key: "duration" | "peak" | "shade" | "exertion" | "rest" | "surface";
  label: string;
  raw: number;
  weight: number;
  weight_level: string;
  contribution: number;
}

export interface RouteMetrics {
  duration_min: number;
  distance_m: number;
  heat_dose: number;
  minutes_danger: number;
  pct_shaded: number;
  peak_feels_c: number;
  mean_feels_c: number;
  pct_asphalt: number;
  max_gap_min: number;
  surface_excess_c: number;
}

export interface Segment {
  coords: [number, number][];
  length_m: number;
  start_m: number;
  name: string;
  surface: string;
  canopy: number;
  feels: number[];
  exposure: number[];
}

export interface ForecastPoint {
  offset_min: number;
  time: string;
  score: number;
  band: string;
  heat_dose: number;
  pct_shaded: number;
  peak_feels_c: number;
}

export interface Explanation {
  summary: string;
  bullets: { icon: string; text: string }[];
  top_factors: string[];
  source: "rule_based" | "llm";
}

export interface Route {
  id: string;
  label: string;
  title: string;
  color: string;
  tags: ("fastest" | "coolest" | "recommended" | "current")[];
  geometry: [number, number][];
  duration_min: number;
  distance_m: number;
  heat_risk_score: number;
  band: string;
  factors: Factor[];
  metrics: RouteMetrics;
  pois_along_route: Poi[];
  segments: Segment[];
  forecast: ForecastPoint[];
  tradeoff: { extra_min: number; dose_change_pct: number; score_change: number; shade_change_pts: number };
  explanation: Explanation;
}

export interface CompareResult {
  compare_id: string;
  persona: Persona;
  persona_label: string;
  scenario: Scenario;
  depart_at: string;
  temp_delta_c: number;
  offsets_min: number[];
  origin: { lat: number; lon: number; snapped: [number, number] };
  destination: { lat: number; lon: number; snapped: [number, number] };
  conditions: Conditions;
  recommended_id: string;
  best_departure: { offset_min: number; time: string; score: number; score_now: number; improvement: number; advice: string };
  routes: Route[];
  simulation?: {
    time_offset_min: number;
    temp_delta_c: number;
    base_compare_id: string;
    reroute: null | {
      current_route_id: string;
      previous_score: number | null;
      current_score_now: number;
      recommended_route_id: string;
      suggest_switch: boolean;
      score_gain: number;
      message: string;
    };
  };
}

export interface WeightsTable {
  levels: Record<string, number>;
  factors: { key: string; label: string }[];
  personas: Record<
    Persona,
    {
      label: string;
      weights: Record<string, { level: string; value: number }>;
      speed_ms: number;
      vulnerability_shift_c: number;
      daily_budget_min: number;
    }
  >;
  bands: { max: number; label: string }[];
  thresholds_c: { caution: number; danger: number; extreme: number };
}

export interface Meta {
  zone: { name: string; city: string; bbox: [number, number, number, number]; center: [number, number]; counts: Record<string, number>; osm_timestamp?: string };
  clock: { now: string; server_tz: string };
  color_scale: { min_c: number; max_c: number };
  llm_enabled: boolean;
  weather_error: string | null;
  risk_model: WeightsTable;
  provenance: { layer: string; source: string; status: "real" | "mixed" | "estimated" | "modelled" }[];
}

/** Static raster fields of the twin, uploaded to the GPU once (see /api/zone/fields). */
export interface ZoneFields {
  rows: number;
  cols: number;
  cell_m: number;
  bbox: [number, number, number, number];
  /** Mirrors the backend's local equirectangular projection so the client can render in metres. */
  origin: {
    lat0: number;
    lon0: number;
    m_per_deg_lat: number;
    m_per_deg_lon: number;
    width_m: number;
    height_m: number;
  };
  height_scale_m: number;
  encoding: Record<string, string>;
  surface_classes: Record<string, string>;
  height_b64: string;
  canopy_b64: string;
  svf_b64: string;
  surface_b64: string;
  road_b64: string;
  vuln_static_b64: string;
}

/** Render typology for a footprint — from OSM where tagged, inferred otherwise. */
export type Typology =
  | "academic"
  | "campus_support"
  | "commercial"
  | "industrial"
  | "apartments"
  | "residential"
  | "house"
  | "shed"
  | "temple";

/**
 * What the packed payload actually carries per building.
 *
 * Name, kind, area and typology_source used to ride along and were never read by
 * anything; height_source is kept because it is how the twin discloses a measured
 * height from an inferred one.
 */
export interface BuildingProps {
  height_m: number;
  /** satellite: measured from the 0.5 m height raster. satellite_low: measured, but
   *  below the 2.5 m floor, so the footprint is a shed or a wall rather than a
   *  storey. tagged: surveyed height or levels from OSM. typology: no measurement
   *  reached this footprint, so it falls back to a class median. */
  height_source: "satellite" | "satellite_low" | "tagged" | "typology";
  typology: Typology;
  seed: number;
}

export interface RoadProps {
  name: string;
  highway: string;
  surface: string;
  width_m: number;
  walkable: boolean;
  bikeable: boolean;
  /** jam-hour traffic heat weight for this road class, °C */
  traffic_heat_c: number;
}

/** Traffic + industrial waste heat at a moment (see /api/anthropogenic). */
export interface AnthropogenicReport {
  time: string;
  traffic: { congestion_factor: number; source: string; mean_c: number; max_c: number; peak_hours: string };
  industrial: {
    duty_cycle: number;
    source_count: number;
    source: string;
    mean_c: number;
    max_c: number;
    sources: { id: string; name: string; lat: number; lon: number; area_m2: number; peak_c: number; reach_m: number }[];
  };
  note: string;
}

/**
 * Buildings as parallel arrays rather than GeoJSON features.
 *
 * `off` holds N+1 ring-start indices into `xy`, which is a flat lon,lat run --
 * building i owns xy[off[i]*2 .. off[i+1]*2). See Zone.buildings_packed(): the
 * Feature wrapper and the properties nothing renders were 13 MB of a 21 MB payload.
 */
export interface PackedBuildings {
  n: number;
  typologies: string[];
  height_sources: string[];
  h: number[];
  t: number[];
  hs: number[];
  seed: number[];
  off: number[];
  xy: number[];
}

export interface ZoneData {
  meta: { name: string; counts: Record<string, number> };
  buildings: PackedBuildings;
  surfaces: GeoJSON.FeatureCollection;
  roads: GeoJSON.FeatureCollection<GeoJSON.LineString, RoadProps>;
  /** [lon, lat, radius_m] per connected road node — see Zone.junctions(). */
  junctions: [number, number, number][];
  signals: GeoJSON.FeatureCollection<GeoJSON.Point, SignalProps>;
  /** [lon, lat, radius_m, density] per tree, flat — see Zone.trees_packed(). */
  trees: number[];
  places: Place[];
}

export interface SignalProps {
  kind: "traffic_signals" | "crossing" | "stop" | "give_way" | "mini_roundabout";
  crossing: string;
  name: string;
}

export interface PointSample {
  lat: number;
  lon: number;
  feels_c: number;
  surface_c: number;
  air_c: number;
  sun_exposure: number;
  building_shadow: boolean;
  canopy: number;
  surface: string;
  traffic_heat_c: number;
  near: string;
}

export interface PassportDay {
  date: string;
  weekday: string;
  trips: number;
  minutes_exposed: number;
  minutes_total: number;
  heat_dose: number;
  distance_m: number;
  pct_shaded: number | null;
  rest_stops: number;
  within_budget: boolean;
}

export interface Passport {
  user_id: number;
  persona: Persona;
  persona_label: string;
  daily_budget_min: number;
  today: PassportDay & { budget_used_pct: number };
  days: PassportDay[];
  week: { trips: number; minutes_exposed: number; heat_dose: number; distance_km: number; shaded_km: number; pct_shaded: number; rest_stops: number; avg_risk: number };
  streak_days: number;
  badges: { id: string; name: string; desc: string; earned: boolean; progress: number }[];
  has_sample: boolean;
  recent: { id: number; logged_at: string; trip_label: string; minutes_total: number; minutes_exposed: number; pct_shaded: number; distance_m: number; heat_risk_score: number; rest_stops_taken: number; is_sample: number }[];
  clinical_alert: ClinicalAlert;
  rest_compliance: RestCompliance | null;
}

export interface RestCompliance {
  applies: true;
  interval_min: number;
  minutes_exposed: number;
  breaks_required: number;
  breaks_taken: number;
  compliant: boolean;
  message: string;
}

export type AlertLevel = "none" | "caution" | "warning" | "danger" | "emergency";

export interface ClinicalAlert {
  level: AlertLevel;
  label: string;
  color: string;
  advice: string;
  feels_c: number;
  persona_adjusted_feels_c: number;
  budget_used_pct: number;
  thresholds_c: { caution: number; danger: number; extreme: number };
  source: string;
}

export interface OpenDataset {
  id: string;
  title: string;
  format: string;
  endpoint: string;
  provenance: string;
  status: "real" | "mixed" | "estimated" | "modelled";
  description: string;
}

export interface OpenDataCatalog {
  license: string;
  docs: string;
  datasets: OpenDataset[];
}

export type CommunityPoiKind = "water" | "rest" | "shade";

export type InterventionKind = "trees" | "cool_pavement" | "shade_structure";

export interface InterventionInfo {
  kind: InterventionKind;
  label: string;
  note: string;
}

export interface InterventionResult {
  kind: InterventionKind;
  label: string;
  note: string;
  center: { lat: number; lon: number };
  radius_m: number;
  before: { feels_c: number; shaded_pct: number };
  after: { feels_c: number; shaded_pct: number };
  delta_c: number;
  delta_shaded_pct: number;
  cells_affected: number;
}

export interface PlannerStreet {
  name: string;
  highway: string;
  length_m: number;
  mean_feels_c: number;
  shaded_pct: number;
  priority_score: number;
  sample: { lat: number; lon: number };
}

export interface PlannerReport {
  generated_at: string;
  scenario: Scenario;
  weather: Weather;
  city_stats: TwinStats;
  methodology: string;
  streets: PlannerStreet[];
}

export interface EquitySummary {
  mean: number;
  p90: number;
  pct_high: number;
  weights: { heat: number; cooling_deficit: number; access_deficit: number };
  n_pois: number;
  note: string;
}

export interface EquityIndex {
  summary: EquitySummary;
  surface: GeoJSON.FeatureCollection<GeoJSON.Polygon, { vulnerability: number }>;
  methodology: string;
}

export interface TwinLayers {
  corridors: GeoJSON.FeatureCollection<GeoJSON.LineString, { feels: number; shade: number; cls: "cool" | "hot" }>;
  hotspots: GeoJSON.FeatureCollection<GeoJSON.Point, { w: number }>;
  thresholds: { cool_c: number; hot_c: number };
  sun: { elevation_deg: number; azimuth_deg: number };
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, msg || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

const qs = (o: Record<string, string | number | boolean | undefined | null>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();

export const api = {
  meta: () => req<Meta>("/api/meta"),
  zone: () => req<ZoneData>("/api/zone"),
  zoneFields: () => req<ZoneFields>("/api/zone/fields"),
  anthropogenic: (p: { time?: string } = {}) => req<AnthropogenicReport>(`/api/anthropogenic?${qs(p)}`),
  twin: (p: { scenario: Scenario; time?: string; offset_min?: number; temp_delta?: number }, signal?: AbortSignal) =>
    req<TwinResponse>(`/api/heat/twin?${qs(p)}`, { signal }),
  point: (p: { lat: number; lon: number; scenario: Scenario; time?: string; offset_min?: number; temp_delta?: number }) =>
    req<PointSample>(`/api/heat/point?${qs(p)}`),
  shadow: (p: { scenario: Scenario; time?: string; offset_min?: number }, signal?: AbortSignal) =>
    req<{ time: string; sun: { elevation_deg: number; azimuth_deg: number }; shadows: GeoJSON.FeatureCollection; pct_walkable_shaded: number }>(
      `/api/shadow?${qs(p)}`,
      { signal },
    ),
  layers: (p: { scenario: Scenario; time?: string; offset_min?: number; temp_delta?: number }, signal?: AbortSignal) =>
    req<TwinLayers>(`/api/heat/layers?${qs(p)}`, { signal }),
  interventions: () => req<{ kinds: InterventionInfo[] }>("/api/heat/interventions"),
  equity: (p: { scenario: Scenario; time?: string; offset_min?: number; temp_delta?: number }, signal?: AbortSignal) =>
    req<EquityIndex>(`/api/equity/index?${qs(p)}`, { signal }),
  plannerReport: (p: { scenario: Scenario; time?: string; offset_min?: number; temp_delta?: number; top_n?: number }) =>
    req<PlannerReport>(`/api/planner/report?${qs(p)}`),
  communityPois: () => req<GeoJSON.FeatureCollection<GeoJSON.Point, { kind: CommunityPoiKind; name: string; status: string; source: "community" }>>("/api/community/pois?status=approved"),
  openDataCatalog: () => req<OpenDataCatalog>("/api/open-data"),
  intervene: (p: {
    lat: number;
    lon: number;
    kind: InterventionKind;
    radius_m?: number;
    scenario: Scenario;
    time?: string;
    offset_min?: number;
    temp_delta?: number;
  }) => req<InterventionResult>(`/api/heat/intervene?${qs(p)}`),
  pois: () => req<GeoJSON.FeatureCollection<GeoJSON.Point, Poi>>("/api/pois"),
  compare: (body: {
    origin: { lat: number; lon: number };
    destination: { lat: number; lon: number };
    persona: Persona;
    scenario: Scenario;
    depart_at?: string;
    temp_delta_c?: number;
  }) => req<CompareResult>("/api/routes/compare", { method: "POST", json: body }),
  simulate: (body: { compare_id: string; route_id?: string; simulate: { time_offset_min: number; temp_delta_c: number } }) =>
    req<CompareResult>("/api/routes/simulate", { method: "POST", json: body }),
  route: (id: string) => req<Route>(`/api/routes/${encodeURIComponent(id)}`),
  explain: (route_id: string, polish_llm = false) =>
    req<{ explanation: Explanation; polished?: { summary: string; source: string; model: string } | null }>(
      `/api/risk/explain?${qs({ route_id, polish_llm })}`,
    ),
  weights: () => req<WeightsTable>("/api/risk/weights"),
  setPersona: (body: { session_token: string; persona: Persona; seed_sample?: boolean }) =>
    req<{ user_id: number; persona: Persona; created: boolean }>("/api/users/persona", { method: "POST", json: body }),
  passport: (userId: number) => req<Passport>(`/api/passport/${userId}`),
  logTrip: (body: { user_id: number; route_id?: string; trip_label?: string; rest_stops_taken?: number; persona?: Persona }) =>
    req<{ ok: boolean; log_id: number }>("/api/passport/log", { method: "POST", json: body }),
  clearSample: (userId: number) => req<{ removed: number }>(`/api/passport/${userId}/sample`, { method: "DELETE" }),
};
