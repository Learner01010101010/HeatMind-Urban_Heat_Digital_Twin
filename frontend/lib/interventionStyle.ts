import type { InterventionKind } from "./api";

export const INTERVENTION_STYLE: Record<InterventionKind, { color: string; icon: string; short: string }> = {
  trees: { color: "#6fbf5e", icon: "🌳", short: "Trees" },
  cool_pavement: { color: "#cfc8b4", icon: "🛣️", short: "Cool pavement" },
  shade_structure: { color: "#f0abfc", icon: "⛱️", short: "Shade structure" },
};
