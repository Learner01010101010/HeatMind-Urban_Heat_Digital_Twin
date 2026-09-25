"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { create } from "zustand";
import { api, type Meta, type ZoneData } from "./api";
import { keyframes, SCENARIO, TIMELINE, useClock, useMap, usePrefs } from "./store";
import { getFrame, type DecodedFrame } from "./twin";

function once<T>(fn: () => Promise<T>) {
  let p: Promise<T> | null = null;
  return () => {
    if (!p) {
      p = fn();
      p.catch(() => (p = null));
    }
    return p;
  };
}

export const getMeta = once(api.meta);
const metaOnce = getMeta;
const zoneOnce = once(api.zone);
const poisOnce = once(api.pois);
const busStopsOnce = once(api.busStops);

function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Retry with backoff so the UI recovers by itself when the backend is still booting.
    const attempt = (n: number) =>
      fn()
        .then((data) => alive && setState({ data, error: null, loading: false }))
        .catch((e: Error) => {
          if (!alive) return;
          setState({ data: null, error: e.message, loading: n < 20 });
          if (n < 20) timer = setTimeout(() => attempt(n + 1), Math.min(1000 * 2 ** n, 5000));
        });
    attempt(0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export const useMeta = () => useAsync<Meta>(metaOnce);
export const useZone = () => useAsync<ZoneData>(zoneOnce);
export const usePois = () => useAsync(poisOnce);
/** Real OSM bus stops. Fetched once and shared — the list does not change. */
export const useBusStops = () => useAsync(busStopsOnce);

/** True once zustand's persisted prefs have loaded from localStorage. */
export function useHydrated() {
  return useSyncExternalStore(
    (cb) => usePrefs.persist.onFinishHydration(cb),
    () => usePrefs.persist.hasHydrated(),
    () => false,
  );
}

/** The live forecast baseline (user's current time, 5-minute resolution). */
export function useBaseTime(): string {
  return useClock((s) => s.base);
}

// ---------- forecast keyframes (shared by map, timeline, insights) ----------
interface FrameState {
  key: string;
  frames: (DecodedFrame | null)[];
  put: (key: string, i: number, f: DecodedFrame) => void;
  reset: (key: string) => void;
}

export const useFrames = create<FrameState>()((set) => ({
  key: "",
  frames: TIMELINE.map(() => null),
  put: (key, i, f) =>
    set((s) => {
      if (s.key !== key) return s;
      const frames = s.frames.slice();
      frames[i] = f;
      return { frames };
    }),
  reset: (key) => set({ key, frames: TIMELINE.map(() => null) }),
}));

/** Mount once: loads every keyframe (Now → +3h) for the current scenario / simulation. */
export function useFrameLoader() {
  const scenario = SCENARIO;
  const base = useBaseTime();
  const simOffset = useMap((s) => s.simOffsetMin);
  const tempDelta = useMap((s) => s.tempDelta);
  useEffect(() => {
    if (!base) return;
    const key = `${scenario}|${base}|${simOffset}|${tempDelta}`;
    const st = useFrames.getState();
    // keep showing the previous frames until new ones arrive, but tag the new key
    if (st.key !== key) useFrames.setState({ key });
    TIMELINE.forEach((o, i) => {
      getFrame(scenario, base, simOffset + o, tempDelta)
        .then((f) => useFrames.getState().put(key, i, f))
        .catch(() => {});
    });
  }, [scenario, base, simOffset, tempDelta]);
}

/** The loaded keyframe nearest to the timeline position (for stats and labels). */
export function useNearestFrame(): DecodedFrame | null {
  const timeMin = useMap((s) => s.timeMin);
  const frames = useFrames((s) => s.frames);
  const { i0, i1, t } = keyframes(timeMin);
  const want = t < 0.5 ? i0 : i1;
  if (frames[want]) return frames[want];
  // fall back to the closest loaded frame
  let best: DecodedFrame | null = null;
  let bd = 1e9;
  frames.forEach((f, i) => {
    if (f && Math.abs(i - want) < bd) {
      best = f;
      bd = Math.abs(i - want);
    }
  });
  return best;
}

/** Ensure a backend user exists for this browser; returns user id. */
export async function ensureUser(seedSample = false): Promise<number> {
  const s = usePrefs.getState();
  let token = s.sessionToken;
  if (!token) {
    token = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `hm-${Date.now()}-${Math.random()}`;
    s.set({ sessionToken: token });
  }
  const r = await api.setPersona({ session_token: token, persona: s.persona, seed_sample: seedSample });
  if (r.user_id !== s.userId) s.set({ userId: r.user_id });
  return r.user_id;
}
