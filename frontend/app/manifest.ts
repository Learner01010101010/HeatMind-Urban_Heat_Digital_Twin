import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "HeatMind AI — Urban Heat Digital Twin",
    short_name: "HeatMind",
    description: "Street-by-street heat, 2-hour forecasts and heat-safe routes for the TSSM BSCOER campus, Pune.",
    start_url: "/",
    display: "standalone",
    background_color: "#05080e",
    theme_color: "#05080e",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
