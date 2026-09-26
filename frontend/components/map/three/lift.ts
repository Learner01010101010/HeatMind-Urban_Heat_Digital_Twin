"use client";

import * as THREE from "three";

/**
 * Terrain lift: the vulnerability index, rendered as relief the whole scene rides on.
 *
 * A flat translucent wash makes a risk field something you squint at. Giving it
 * height makes it something you read at a glance — the eye picks up a ridge far
 * faster than a shade of orange, and the places that matter are exactly the ridges.
 *
 * The important part is that it is *shared*. Ground, roads, canopy and buildings all
 * include this snippet and displace by the same field, so raising the terrain lifts
 * the city standing on it rather than leaving buildings buried and roads floating.
 * With `uLiftAmp` at 0 every one of them collapses back to z = 0 and the geometry is
 * bit-identical to the flat scene, so this costs nothing when the overlay is off.
 *
 * The index itself is assembled on the GPU: the static half (cooling deficit and
 * access deficit) arrives once as a texture, and the other 45 points come from the
 * heat keyframes the renderer is already holding. So the relief tracks the timeline
 * scrubber live, at the full 10 m grid, without refetching anything.
 */

/** Metres of relief at index 100. Tuned against building heights: tall enough to
 *  read as terrain from an oblique camera, short enough that a four-storey block
 *  still reads as a building rather than a speck on a mountain. */
export const LIFT_AMPLITUDE_M = 38.0;

/**
 * Include in any shader that must sit on the deformed terrain, then add liftAt(uv)
 * to the z of its world position. Safe in either stage and in both at once: it
 * declares only uniforms and functions, so a shader that needs the height in the
 * vertex stage and its gradient in the fragment stage can include it twice.
 */
export const LIFT_GLSL = `
uniform sampler2D uVulnStatic;   // index points / 55, the time-invariant half
uniform sampler2D uLiftHeatA;    // heat keyframes, same encoding as the ground plane
uniform sampler2D uLiftHeatB;
uniform float uLiftBlend;
uniform float uLiftHasB;
uniform float uLiftAmp;          // metres at index 100; 0 disables the whole mechanic

// Real ground, from the Copernicus DEM. Two planes because one 8-bit channel over
// 274 m of relief is a 1.1 m step, and the normal is a difference of neighbours —
// the quantisation invisible on the ground shows up in the lighting as facets.
uniform sampler2D uTerrainHi;
uniform sampler2D uTerrainLo;
uniform float uTerrainSpan;      // metres from texel 0 to texel 65535
uniform float uTerrainAmp;       // 1 = true scale; 0 = no terrain (raster absent)

/** Ground elevation at this cell, metres above the zone's lowest point.
 *
 *  Relative to the zone floor, not absolute: the scene origin is that floor, and
 *  carrying 539 m of sea-level datum in every vertex would spend depth precision
 *  the rest of the twin is tuned for on a constant.
 *
 *  Both planes are filtered LINEAR and that is safe — u = 256*hi + lo is a linear
 *  combination, so interpolating the bytes separately and combining gives exactly
 *  the interpolated 16-bit value, including across a low-byte wrap.
 */
float terrainAt(vec2 uv) {
  if (uTerrainAmp <= 0.0) return 0.0;
  vec2 p = clamp(uv, 0.0, 1.0);
  float hi = texture2D(uTerrainHi, p).r * 255.0;
  float lo = texture2D(uTerrainLo, p).r * 255.0;
  return (hi * 256.0 + lo) / 65535.0 * uTerrainSpan * uTerrainAmp;
}

/**
 * Pedestrian feels-like temperature at this cell, °C.
 *
 * Blended between the two keyframes in temperature space, exactly as the ground
 * plane does, so nothing reading this can disagree with the colour on the ground
 * about what the temperature is. Shared rather than reimplemented per layer for
 * that reason.
 */
float feelsAt(vec2 uv) {
  vec2 p = clamp(uv, 0.0, 1.0);
  float a = texture2D(uLiftHeatA, p).r;
  float b = texture2D(uLiftHeatB, p).r;
  float v = mix(a, mix(a, b, uLiftBlend), uLiftHasB);
  return 20.0 + v * 255.0 / 4.0;
}

/** SDG-10 heat vulnerability at this cell, 0..100. */
float vulnerabilityAt(vec2 uv) {
  float heatTerm = clamp((feelsAt(uv) - 30.0) / 15.0, 0.0, 1.0);
  float staticTerm = texture2D(uVulnStatic, clamp(uv, 0.0, 1.0)).r * 55.0;
  return clamp(45.0 * heatTerm + staticTerm, 0.0, 100.0);
}

/**
 * Metres to raise this point.
 *
 * Two terms, and they mean different things. The first is the real hill the city is
 * built on and is always there. The second is the vulnerability index rendered as
 * relief, which only exists while that overlay is on — an analytic surface stacked
 * on top of a physical one.
 *
 * They add rather than replace so the overlay deforms the actual ground instead of
 * flattening it: with the index off you get Katraj as it is, and with it on you get
 * Katraj with the risk piled onto the slopes it belongs to.
 */
float liftAt(vec2 uv) {
  float ground = terrainAt(uv);
  if (uLiftAmp <= 0.0) return ground;
  // Slight easing rather than a straight ramp: it flattens the low ground so the
  // comfortable majority of the city stays a plain, readable floor, and spends the
  // relief on the upper half of the index where the decisions actually are.
  float v = vulnerabilityAt(uv) * 0.01;
  return ground + uLiftAmp * v * v * (3.0 - 2.0 * v);
}
`;

/** The uniforms LIFT_GLSL declares. Every lifted material must share these objects. */
export interface LiftUniforms {
  uVulnStatic: { value: THREE.Texture | null };
  uLiftHeatA: { value: THREE.Texture | null };
  uLiftHeatB: { value: THREE.Texture | null };
  uLiftBlend: { value: number };
  uLiftHasB: { value: number };
  uLiftAmp: { value: number };
  uTerrainHi: { value: THREE.Texture | null };
  uTerrainLo: { value: THREE.Texture | null };
  uTerrainSpan: { value: number };
  uTerrainAmp: { value: number };
}

/**
 * One set of lift uniforms, shared by reference across every material that lifts.
 *
 * Shared deliberately: if the ground and the buildings ever held separate copies,
 * a dropped update would tear the city away from the terrain it stands on. One
 * object means that cannot happen.
 */
export function makeLiftUniforms(
  vulnStatic: THREE.Texture | null,
  terrain?: { hi: THREE.Texture; lo: THREE.Texture; spanM: number } | null,
): LiftUniforms {
  return {
    uVulnStatic: { value: vulnStatic },
    uLiftHeatA: { value: null },
    uLiftHeatB: { value: null },
    uLiftBlend: { value: 0 },
    uLiftHasB: { value: 0 },
    uLiftAmp: { value: 0 },
    uTerrainHi: { value: terrain?.hi ?? null },
    uTerrainLo: { value: terrain?.lo ?? null },
    uTerrainSpan: { value: terrain?.spanM ?? 0 },
    uTerrainAmp: { value: terrain ? 1 : 0 },
  };
}
