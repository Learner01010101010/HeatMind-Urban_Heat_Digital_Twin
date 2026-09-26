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

/** Metres to raise this point so it sits on the vulnerability terrain. */
float liftAt(vec2 uv) {
  if (uLiftAmp <= 0.0) return 0.0;
  // Slight easing rather than a straight ramp: it flattens the low ground so the
  // comfortable majority of the city stays a plain, readable floor, and spends the
  // relief on the upper half of the index where the decisions actually are.
  float v = vulnerabilityAt(uv) * 0.01;
  return uLiftAmp * v * v * (3.0 - 2.0 * v);
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
}

/**
 * One set of lift uniforms, shared by reference across every material that lifts.
 *
 * Shared deliberately: if the ground and the buildings ever held separate copies,
 * a dropped update would tear the city away from the terrain it stands on. One
 * object means that cannot happen.
 */
export function makeLiftUniforms(vulnStatic: THREE.Texture | null): LiftUniforms {
  return {
    uVulnStatic: { value: vulnStatic },
    uLiftHeatA: { value: null },
    uLiftHeatB: { value: null },
    uLiftBlend: { value: 0 },
    uLiftHasB: { value: 0 },
    uLiftAmp: { value: 0 },
  };
}
