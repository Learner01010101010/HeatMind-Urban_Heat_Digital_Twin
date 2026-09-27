"""Street candidate searches and automatic recommendation for normal planning."""
from __future__ import annotations

import heapq
import math

import numpy as np

from . import geo
from .routing_service import Path



def astar(graph, src, dst, costs, allowed):
    """A* over existing edges, with an admissible great-circle lower bound.

    No new graph, access rules or speed model. A zero lower bound falls back to
    Dijkstra's ordering. Disallowed/closed edges are skipped, never penalised.
    """
    valid = allowed & np.isfinite(costs) & (graph.elen > 0)
    rate = max(0.0, float(np.min(costs[valid] / graph.elen[valid]))) * .999 if valid.any() else 0.0
    if (costs[valid] < 0).any():
        raise ValueError("A* requires nonnegative edge costs")
    target = graph.node_ll[dst]
    heuristic = lambda n: geo.haversine_m(graph.node_ll[n], target) * rate
    distances, previous = {src: 0.0}, {}
    queue = [(heuristic(src), 0.0, src)]
    while queue:
        _, distance, node = heapq.heappop(queue)
        if distance != distances.get(node):
            continue
        if node == dst:
            nodes, edges = [dst], []
            while nodes[-1] != src:
                parent, edge = previous[nodes[-1]]
                nodes.append(parent)
                edges.append(edge)
            return Path(nodes[::-1], edges[::-1])
        for neighbour, edge, direction in graph.adj[node]:
            if not valid[edge]:
                continue
            candidate = distance + float(costs[edge])
            if candidate < distances.get(neighbour, math.inf):
                distances[neighbour] = candidate
                previous[neighbour] = (node, edge if direction == 1 else -(edge + 1))
                heapq.heappush(queue, (candidate + heuristic(neighbour), candidate, neighbour))
    return None


def legal_edges(graph, mode, traffic=None):
    allowed = graph.mode_mask(mode).copy()
    if traffic is not None and mode.key in ("car", "bike"):
        closed = np.bincount(graph.p_edge, weights=traffic["closed"].astype(float), minlength=len(graph.eu)) > 0
        allowed &= ~closed
    return allowed


def augment_candidates(graph, src, dst, seconds, paths, mode, traffic=None):
    """Keep heat-search alternatives; explicitly add shortest and fastest paths."""
    allowed = legal_edges(graph, mode, traffic)
    time_cost = np.bincount(graph.p_edge, weights=seconds, minlength=len(graph.eu))
    shortest = graph.dijkstra(src, dst, np.where(allowed, graph.elen, np.inf))
    fastest = astar(graph, src, dst, time_cost, allowed)
    result, seen = [], set()
    for path in [*paths, shortest, fastest]:
        if path is None or not all(allowed[e] for e in graph.edge_ids(path)):
            continue
        key = tuple(path.edges)
        if key not in seen:
            seen.add(key)
            result.append(path)
    return result


def recommended_route(routes):
    """Prefer a lower exposure score only when the detour and gain justify it."""
    fastest = min(routes, key=lambda r: (r["duration_min"], r["heat_risk_score"]))
    eligible = [r for r in routes if r["duration_min"] <= fastest["duration_min"] * 1.5 + 4]
    best = min(eligible, key=lambda r: (r["optimization"]["score"], r["duration_min"]))
    return best if best["optimization"]["score"] <= fastest["optimization"]["score"] - 2 else fastest
