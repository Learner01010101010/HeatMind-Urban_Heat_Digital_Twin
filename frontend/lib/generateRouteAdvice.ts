import type { Route } from "./api";
import { recommendRoute } from "./routeRecommendation";

/** Local expert rules: unlimited requests, no API key, fetch or remote model. */
export async function generateRouteAdvice(route: Route): Promise<string[]> {
  return recommendRoute(route).tips;
}
