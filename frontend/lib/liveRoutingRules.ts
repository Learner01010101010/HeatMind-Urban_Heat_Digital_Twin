import type { Route } from "./api";
import { alongRoute, cumulative, projectOnto } from "./navigation";

export interface PositionFix { lat: number; lon: number; accuracy: number; at: number }

/** Only a recent, reasonably accurate real fix can cause an off-route switch. */
export function remainingOrigin(route: Route, progressM: number, fix: PositionFix | null, now: number) {
  const cum = cumulative(route.geometry);
  if (fix && now - fix.at <= 30_000 && fix.accuracy <= 50) {
    const projection = projectOnto(route.geometry, cum, [fix.lat, fix.lon]);
    return { lat: fix.lat, lon: fix.lon, off_route: projection.offM > 45, source: "gps" as const };
  }
  const position = alongRoute(route.geometry, cum, progressM).position;
  return { lat: position[0], lon: position[1], off_route: false, source: "preview" as const };
}

export function sameTrip(compareId: string, routeId: string, currentCompareId: string | undefined, currentRouteId: string | null) {
  return compareId === currentCompareId && routeId === currentRouteId;
}
