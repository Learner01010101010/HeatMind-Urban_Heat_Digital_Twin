"""Heat-aware routing over the real OSM street graph of the zone.

Each street edge is cut into ~8 m "pieces". Walkers sample the cooler side of the
street (they naturally hug the shady kerb); cyclists sample the carriageway.
Candidate routes come from Dijkstra with a sweep of heat-aversion weights (α),
so the set spans the time-vs-exposure Pareto front — fastest → coolest.
"""
from __future__ import annotations

import heapq
import math
from collections import defaultdict
from dataclasses import dataclass

import numpy as np

from . import geo
from .heat_twin_service import Frame
from .modes import Mode
from .zone import SURFACES, Zone

PIECE_M = 8.0
ALPHAS = [0.0, 0.6, 1.6, 4.0, 10.0]
#: Added to an edge a mode may not use. Larger than any real route cost in this zone
#: (7,525 roads over ~4 km) and small enough to stay far from float overflow.
FORBIDDEN_EDGE_COST = 1e7


@dataclass
class Path:
    nodes: list[int]
    edges: list[int]  # signed: +e forward, -(e+1) reversed


class StreetGraph:
    def __init__(self, zone: Zone) -> None:
        self.zone = zone
        self.node_ll: dict[int, tuple[float, float]] = {}
        eu, ev, elen, eroad = [], [], [], []
        for ri, r in enumerate(zone.data["roads"]):
            for (n1, la1, lo1), (n2, la2, lo2) in zip(r["nodes"][:-1], r["nodes"][1:]):
                if n1 == n2:
                    continue
                self.node_ll[n1] = (la1, lo1)
                self.node_ll[n2] = (la2, lo2)
                eu.append(n1)
                ev.append(n2)
                elen.append(geo.haversine_m((la1, lo1), (la2, lo2)))
                eroad.append(ri)
        self.eu, self.ev = eu, ev
        self.elen = np.array(elen)
        self.eroad = np.array(eroad)
        self._mode_masks: dict[str, np.ndarray] = {}
        self._snap_cache: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        self.adj: dict[int, list[tuple[int, int, int]]] = defaultdict(list)  # node -> (nbr, edge, dir)
        for e, (u, v) in enumerate(zip(eu, ev)):
            self.adj[u].append((v, e, 1))
            self.adj[v].append((u, e, -1))

        # Largest connected component (snap targets)
        seen, best = set(), set()
        for s in self.adj:
            if s in seen:
                continue
            comp, stack = set(), [s]
            while stack:
                n = stack.pop()
                if n in comp:
                    continue
                comp.add(n)
                stack.extend(nb for nb, _, _ in self.adj[n] if nb not in comp)
            seen |= comp
            if len(comp) > len(best):
                best = comp
        self.main = best
        self._main_ids = np.array(sorted(best))
        self._main_xy = np.array([geo.to_xy(*self.node_ll[n]) for n in self._main_ids])
        self._build_pieces()

    def _build_pieces(self) -> None:
        roads = self.zone.data["roads"]
        pe, plen, pmx, pmy, psx, psy, pex, pey = [], [], [], [], [], [], [], []
        side_cells: list[list[tuple[int, int]]] = []
        centre_cells: list[tuple[int, int]] = []
        for e, (u, v) in enumerate(zip(self.eu, self.ev)):
            ax, ay = geo.to_xy(*self.node_ll[u])
            bx, by = geo.to_xy(*self.node_ll[v])
            L = math.hypot(bx - ax, by - ay)
            n = max(1, int(math.ceil(L / PIECE_M)))
            nx, ny = (-(by - ay) / L, (bx - ax) / L) if L > 0 else (0.0, 0.0)
            half = roads[self.eroad[e]]["width_m"] / 2 + 1.5
            for k in range(n):
                t0, t1 = k / n, (k + 1) / n
                sx, sy = ax + (bx - ax) * t0, ay + (by - ay) * t0
                ex, ey = ax + (bx - ax) * t1, ay + (by - ay) * t1
                mx, my = (sx + ex) / 2, (sy + ey) / 2
                pe.append(e)
                plen.append(L / n)
                pmx.append(mx)
                pmy.append(my)
                psx.append(sx)
                psy.append(sy)
                pex.append(ex)
                pey.append(ey)
                centre_cells.append(geo.xy_to_cell(mx, my))
                side_cells.append([geo.xy_to_cell(mx, my), geo.xy_to_cell(mx + nx * half, my + ny * half),
                                   geo.xy_to_cell(mx - nx * half, my - ny * half)])
        self.p_edge = np.array(pe)
        self.p_len = np.array(plen)
        self.p_mid = np.column_stack([pmx, pmy])
        self.p_start = np.column_stack([psx, psy])
        self.p_end = np.column_stack([pex, pey])
        sc = np.array(side_cells)  # (P, 3, 2)
        self.p_side_r, self.p_side_c = sc[:, :, 0], sc[:, :, 1]
        cc = np.array(centre_cells)
        self.p_r, self.p_c = cc[:, 0], cc[:, 1]
        # pieces of each edge, in forward order
        order = np.argsort(self.p_edge, kind="stable")
        self.edge_pieces: list[np.ndarray] = [np.array([], dtype=int)] * len(self.eu)
        bounds = np.searchsorted(self.p_edge[order], np.arange(len(self.eu) + 1))
        for e in range(len(self.eu)):
            self.edge_pieces[e] = order[bounds[e]:bounds[e + 1]]
        # static piece attributes
        surf = self.zone.surface
        self.p_asphalt_centre = (surf[self.p_r, self.p_c] == SURFACES["asphalt"][0]).astype(float)

    # ------------------------------------------------------------------
    def mode_mask(self, mode: Mode) -> np.ndarray:
        """Per-edge boolean: may this mode use this edge?

        One graph serves every mode. Building a separate graph per mode would mean
        five copies of a 7,525-road network and five warm-ups at startup, to express
        something that is really just a cost of infinity on some edges.

        Cached per mode key: the mask is a pure function of the road table, which
        does not change after ingest.
        """
        cached = self._mode_masks.get(mode.key)
        if cached is not None:
            return cached
        roads = self.zone.data["roads"]
        ok = np.ones(len(roads), dtype=bool)
        for i, r in enumerate(roads):
            if r["highway"] in mode.forbidden_highways:
                ok[i] = False
            elif mode.key == "cycle" and not r.get("bikeable", True):
                # Per-road, from OSM's own bicycle tag — finer than a class list.
                ok[i] = False
            elif mode.key == "walk" and not r.get("walkable", True):
                ok[i] = False
        mask = ok[self.eroad]
        self._mode_masks[mode.key] = mask
        return mask

    def mode_edge_cost(self, mode: Mode, base_cost: np.ndarray) -> np.ndarray:
        """`base_cost` with edges this mode cannot use made unreachable.

        A large finite number rather than `inf`: Dijkstra sums these, and inf + inf
        propagates NaN through the numpy cost arithmetic upstream. This is far beyond
        any real path cost, so a route only crosses a forbidden edge when there is no
        legal route at all — and then it is better to return the illegal one with the
        distance honestly reported than to claim the points are unconnected.
        """
        mask = self.mode_mask(mode)
        out = base_cost.copy()
        out[~mask] += FORBIDDEN_EDGE_COST
        return out

    # ------------------------------------------------------------------
    def piece_values(self, f: Frame, shady_side: bool) -> dict[str, np.ndarray]:
        """Per-piece feels/exposure/surface for one twin frame."""
        if shady_side:
            fs = f.feels[self.p_side_r, self.p_side_c]  # (P, 3)
            pick = np.argmin(fs, axis=1)
            rr = self.p_side_r[np.arange(len(pick)), pick]
            cc = self.p_side_c[np.arange(len(pick)), pick]
        else:
            rr, cc = self.p_r, self.p_c
        surf_code = self.zone.surface[rr, cc]
        # Buildings under a sampled kerb cell: fall back to the centreline
        on_roof = surf_code == SURFACES["roof"][0]
        rr = np.where(on_roof, self.p_r, rr)
        cc = np.where(on_roof, self.p_c, cc)
        from .anthropogenic import industrial_field
        industrial = industrial_field(self.zone, f.when)[rr, cc]
        return {
            "industrial_c": industrial.astype(np.float32),
            "traffic_heat_c": np.maximum(f.anthro[rr, cc] - industrial, 0).astype(np.float32),
            "feels": f.feels[rr, cc],
            "exposure": f.exposure[rr, cc],
            "surface_excess": f.t_surface[rr, cc] - f.weather.air_c,
            "asphalt": (self.zone.surface[rr, cc] == SURFACES["asphalt"][0]).astype(float),
            "canopy": self.zone.canopy[rr, cc],
            "surface_code": self.zone.surface[rr, cc],
        }

    def snap(self, lat: float, lon: float, mode: Mode | None = None) -> int:
        """Nearest graph node, restricted to ones this mode can actually leave from.

        Snapping a car to the footpath node outside a building strands it: every edge
        out of that node carries the forbidden-cost barrier, so the search pays it at
        least once and the "route" starts with an illegal segment. Snapping to the
        nearest *drivable* node instead is what a navigation app does when it puts
        you on the road rather than in the lobby.
        """
        x, y = geo.to_xy(lat, lon)
        ids, xy = self._snap_targets(mode)
        if not len(ids):
            ids, xy = self._main_ids, self._main_xy
        d = np.hypot(xy[:, 0] - x, xy[:, 1] - y)
        return int(ids[int(np.argmin(d))])

    def _snap_targets(self, mode: Mode | None) -> tuple[np.ndarray, np.ndarray]:
        """Main-component nodes with at least one edge this mode may use."""
        if mode is None:
            return self._main_ids, self._main_xy
        cached = self._snap_cache.get(mode.key)
        if cached is not None:
            return cached
        mask = self.mode_mask(mode)
        usable = {int(self.eu[e]) for e in np.where(mask)[0]} | {int(self.ev[e]) for e in np.where(mask)[0]}
        keep = np.array([i for i, n in enumerate(self._main_ids) if int(n) in usable], dtype=int)
        cached = (self._main_ids[keep], self._main_xy[keep]) if len(keep) else (self._main_ids, self._main_xy)
        self._snap_cache[mode.key] = cached
        return cached

    def dijkstra(self, src: int, dst: int, edge_cost: np.ndarray) -> Path | None:
        dist = {src: 0.0}
        prev: dict[int, tuple[int, int]] = {}
        pq = [(0.0, src)]
        done = set()
        while pq:
            d, n = heapq.heappop(pq)
            if n in done:
                continue
            if n == dst:
                break
            done.add(n)
            for nb, e, direction in self.adj[n]:
                nd = d + edge_cost[e]
                if nd < dist.get(nb, math.inf):
                    dist[nb] = nd
                    prev[nb] = (n, e if direction == 1 else -(e + 1))
                    heapq.heappush(pq, (nd, nb))
        if dst not in dist:
            return None
        nodes, edges = [dst], []
        while nodes[-1] != src:
            p, se = prev[nodes[-1]]
            edges.append(se)
            nodes.append(p)
        return Path(nodes[::-1], edges[::-1])

    def path_pieces(self, path: Path) -> np.ndarray:
        """Piece indices along the path in travel order, plus a direction flag."""
        idx, fwd = [], []
        for se in path.edges:
            if se >= 0:
                p = self.edge_pieces[se]
                idx.extend(p.tolist())
                fwd.extend([True] * len(p))
            else:
                p = self.edge_pieces[-se - 1][::-1]
                idx.extend(p.tolist())
                fwd.extend([False] * len(p))
        return np.array(idx, dtype=int), np.array(fwd, dtype=bool)

    def edge_ids(self, path: Path) -> set[int]:
        return {se if se >= 0 else -se - 1 for se in path.edges}

    def reach_seconds(self, src: int, piece_seconds: np.ndarray,
                      limit_s: float = math.inf, mode: Mode | None = None) -> np.ndarray:
        """Walking seconds from `src` to each piece, ignoring heat.

        This is what makes the search time-aware. The sun moves about 15 degrees of
        azimuth an hour, so on a 100-minute walk the shade at the far end of a route
        is cast in a noticeably different direction than at the near end -- and
        costing every street with the sun frozen at departure routes people into
        shade that will have moved by the time they reach it.

        A plain shortest-time Dijkstra, no heat penalty: this asks the earliest the
        walker could be somewhere, which is the right question before the heat-averse
        path is known. It is an estimate -- the chosen route may dawdle -- but it is
        wrong by minutes where freezing the sun is wrong by the whole journey.

        Bounded, and run on plain lists. Unlike the point-to-point searches this one
        has no destination to stop at, so left unbounded it expands all 28,405 nodes
        of the zone and numpy scalar indexing in the inner loop made that 14 seconds
        a request. Pieces past the bound keep the departure frame; they are further
        away than the walk can plausibly wander.
        """
        E = len(self.eu)
        t_arr = np.bincount(self.p_edge, weights=piece_seconds, minlength=E)
        if mode is not None:
            # The earliest a traveller could reach a street has to be asked over the
            # streets they can actually use: estimating a car's arrival along a
            # footpath shortcut reads the sun at the wrong time for every piece
            # downstream of it.
            t_arr = self.mode_edge_cost(mode, t_arr)
        t_edge = t_arr.tolist()
        idx_of, node_ids = self._dense_nodes()
        dist = [math.inf] * len(node_ids)
        si = idx_of.get(int(src))
        if si is None:
            return np.zeros(len(piece_seconds))
        dist[si] = 0.0
        pq: list[tuple[float, int]] = [(0.0, si)]
        adj_dense = self._dense_adj()
        while pq:
            d, i = heapq.heappop(pq)
            if d > dist[i]:
                continue
            if d > limit_s:
                break
            for j, e in adj_dense[i]:
                nd = d + t_edge[e]
                if nd < dist[j]:
                    dist[j] = nd
                    heapq.heappush(pq, (nd, j))

        darr = np.asarray(dist, dtype=float)
        eu_i = np.searchsorted(node_ids, self.eu)
        ev_i = np.searchsorted(node_ids, self.ev)
        edge_reach = np.minimum(darr[eu_i], darr[ev_i])
        edge_reach[~np.isfinite(edge_reach)] = 0.0
        return edge_reach[self.p_edge] + piece_seconds * 0.5

    def _dense_nodes(self) -> tuple[dict[int, int], np.ndarray]:
        """Map the graph's OSM node ids onto 0..N-1, once.

        Node keys are raw OSM ids -- 245,644,945 to 14,211,816,095 over this zone --
        so they cannot be used as array indices. Sorted dense ids let the reach
        search use a flat list for distances instead of a dict, which is most of why
        it is fast enough to run on every request.
        """
        cached = getattr(self, "_dense_node_cache", None)
        if cached is None:
            ids = np.array(sorted(self.adj.keys()), dtype=np.int64)
            cached = ({int(v): i for i, v in enumerate(ids)}, ids)
            self._dense_node_cache = cached
        return cached

    def _dense_adj(self) -> list[list[tuple[int, int]]]:
        """Adjacency over the dense node indices: (neighbour index, edge id)."""
        cached = getattr(self, "_dense_adj_cache", None)
        if cached is None:
            idx_of, node_ids = self._dense_nodes()
            cached = [[] for _ in range(len(node_ids))]
            for n, links in self.adj.items():
                i = idx_of[int(n)]
                row = cached[i]
                for nb, e, _direction in links:
                    row.append((idx_of[int(nb)], int(e)))
            self._dense_adj_cache = cached
        return cached

    def candidate_paths(self, src: int, dst: int, piece_seconds: np.ndarray, piece_penalty: np.ndarray,
                        max_routes: int = 3, mode: Mode | None = None) -> list[Path]:
        """Fastest + Pareto-spread heat-averse alternatives (α sweep + penalty method).

        `mode` restricts the search to streets that mode may use: a car is kept off
        the footpaths through the campus, a bus off the service lanes. Without it the
        search is free to route a car down a flight of steps.
        """
        E = len(self.eu)
        t_edge = np.bincount(self.p_edge, weights=piece_seconds, minlength=E)
        h_edge = np.bincount(self.p_edge, weights=piece_seconds * piece_penalty, minlength=E)
        if mode is not None:
            # Applied to the time term only. The heat term is multiplied by alpha in
            # the sweep below, which would scale the barrier with it and let a large
            # alpha make a forbidden street look cheap again.
            t_edge = self.mode_edge_cost(mode, t_edge)

        def overlap(a: Path, b: Path) -> float:
            ea, eb = self.edge_ids(a), self.edge_ids(b)
            la = self.elen[list(ea)].sum()
            lb = self.elen[list(eb)].sum()
            shared = self.elen[list(ea & eb)].sum()
            return shared / max(min(la, lb), 1)

        def cost(p: Path) -> tuple[float, float]:
            ids = list(self.edge_ids(p))
            return float(t_edge[ids].sum()), float(h_edge[ids].sum())

        pool: list[Path] = []
        for a in ALPHAS:
            p = self.dijkstra(src, dst, t_edge + a * h_edge)
            if p and all(overlap(p, q) < 0.97 for q in pool):
                pool.append(p)
        # Penalty method: discourage already-found edges to surface genuinely different streets
        penalised = t_edge + 1.2 * h_edge
        for k in range(4):
            for q in pool:
                penalised[list(self.edge_ids(q))] *= 1.35
            p = self.dijkstra(src, dst, penalised)
            if p and all(overlap(p, q) < 0.97 for q in pool):
                pool.append(p)
        if not pool:
            return []
        fastest = min(pool, key=lambda p: cost(p)[0])
        t_fast = cost(fastest)[0]
        limit = t_fast * 1.6 + 300  # a detour beyond this isn't a useful walking option
        viable = [p for p in pool if cost(p)[0] <= limit and p is not fastest]
        chosen = [fastest]
        # coolest viable (least heat load), then the best time/heat balance that's distinct
        for key in (lambda p: cost(p)[1], lambda p: cost(p)[0] + 1.5 * cost(p)[1]):
            for p in sorted(viable, key=key):
                if all(overlap(p, q) < 0.8 for q in chosen):
                    chosen.append(p)
                    break
            if len(chosen) >= max_routes:
                break
        if len(chosen) < 2:
            rest = sorted((p for p in pool if p is not fastest), key=lambda p: cost(p)[0])
            for p in rest:
                if all(overlap(p, q) < 0.9 for q in chosen):
                    chosen.append(p)
                    break
        return chosen
