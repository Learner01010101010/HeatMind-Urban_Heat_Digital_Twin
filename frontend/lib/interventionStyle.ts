import type { InterventionKind } from "./api";

export const INTERVENTION_STYLE: Record<InterventionKind, { color: string; icon: string; short: string }> = {
  trees: { color: "#34e2c6", icon: "🌳", short: "Trees" },
  cool_pavement: { color: "#4cc3ff", icon: "🛣️", short: "Cool pavement" },
  shade_structure: { color: "#f0abfc", icon: "⛱️", short: "Shade structure" },
};
