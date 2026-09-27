import type { CompareResult, Route } from "./api";

export interface JourneyAdvice { summary: string; tips: string[] }
interface AdviceBatch { routes: Record<string, JourneyAdvice> }
const cache = new Map<string, { expires: number; promise: Promise<AdviceBatch> }>();

export function adviceKey(route: Route, compare?: CompareResult | null) {
  const context = compare?.routes.some((r) => r.id === route.id) ? compare : null;
  return JSON.stringify(context ? [context.compare_id, context.depart_at, context.recommended_id,
    context.routes.map((r) => [r.id, r.duration_min, r.metrics, r.optimization])]
    : [route.id, route.duration_min, route.metrics, route.optimization]);
}

export async function generateJourneyAdvice(route: Route, compare?: CompareResult | null): Promise<JourneyAdvice> {
  const key = adviceKey(route, compare);
  let entry = cache.get(key);
  if (!entry || entry.expires <= Date.now()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 95000);
    const promise = (async (): Promise<AdviceBatch> => {
      const response = await fetch("/api/routes/advice", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ route_id: route.id }), signal: controller.signal });
      if (!response.ok) throw new Error("Recommendations unavailable");
      return await response.json();
    })().finally(() => clearTimeout(timer));
    entry = { expires: Date.now() + 300000, promise };
    cache.set(key, entry);
    void promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
  }
  const data = await entry.promise;
  const advice = data.routes[route.id];
  if (!advice || typeof advice.summary !== "string" || !Array.isArray(advice.tips)) throw new Error("Incomplete recommendation");
  return advice;
}

export async function generateRouteAdvice(route: Route): Promise<string[]> {
  return (await generateJourneyAdvice(route)).tips;
}
