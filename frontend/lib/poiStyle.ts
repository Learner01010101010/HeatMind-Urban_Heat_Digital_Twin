import type { Poi } from "./api";

export const POI_STYLE: Record<Poi["type"], { color: string; label: string }> = {
  water: { color: "#5ec98a", label: "Water" },
  rest: { color: "#d8b45e", label: "Rest" },
  shade: { color: "#a9b6a2", label: "Shade" },
  cooling_center: { color: "#f0abfc", label: "Cooling centre" },
};
