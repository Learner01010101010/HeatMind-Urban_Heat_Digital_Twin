import type { Poi } from "./api";

export const POI_STYLE: Record<Poi["type"], { color: string; label: string }> = {
  water: { color: "#38bdf8", label: "Water" },
  rest: { color: "#a78bfa", label: "Rest" },
  shade: { color: "#2dd4bf", label: "Shade" },
  cooling_center: { color: "#f0abfc", label: "Cooling centre" },
};
