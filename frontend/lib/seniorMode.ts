"use client";

import type { TravelMode } from "./api";

/**
 * Senior Mode — the single gate, and every constant it changes.
 *
 * One file so the blast radius is inspectable: if a behaviour is not referenced
 * here, Senior Mode does not touch it. The flag itself is the existing
 * `prefs.seniorMode`, chosen at onboarding and persisted with the rest of the
 * preferences, so nothing new has to be threaded through the app to read it.
 *
 * Everything below is inert while the flag is false.
 */

/**
 * Score at which a route is called out as high exposure.
 *
 * The brief asked for 40 against a default of 70. There is no 70 in this codebase —
 * the product's own RISK_BANDS put "High" at 45 and "Extreme" at 65, and 70 is
 * simply inside Extreme. So 40 is the senior threshold as asked, and the default it
 * overrides is the real one: 45.
 */
export const SENIOR_WARN_SCORE = 40;
export const DEFAULT_WARN_SCORE = 45;

export const warnScore = (senior: boolean) => (senior ? SENIOR_WARN_SCORE : DEFAULT_WARN_SCORE);

/**
 * Travel modes offered in Senior Mode.
 *
 * The two-wheeler and the bicycle come out. Not a judgement about who can ride —
 * it is that both put the traveller in traffic with no shade and no way to stop
 * easily, which is the combination this mode exists to avoid. Walk, car and bus
 * all have somewhere to sit down at the end of them.
 */
export const SENIOR_MODES: TravelMode[] = ["walk", "car", "bus"];

export const modeAllowed = (m: TravelMode, senior: boolean) => !senior || SENIOR_MODES.includes(m);

/**
 * How near a rest amenity a route has to pass for it to count, in metres.
 *
 * Generous rather than precise: a bench 50 m off the line is a bench you can
 * actually get to, and the mapping is sparse enough that tightening this would
 * mostly just return zero.
 */
export const REST_NEAR_M = 50;

/** OSM amenity values that count as somewhere to stop. */
export const REST_DETAILS = ["bench", "toilets"];
