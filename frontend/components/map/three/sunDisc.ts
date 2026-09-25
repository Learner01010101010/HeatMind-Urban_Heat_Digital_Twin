"use client";

import * as THREE from "three";
import type { LocalOrigin } from "./origin";

/**
 * The sun itself, drawn where it actually is.
 *
 * Every shadow in the twin is already cast from the NOAA solar position
 * (services/solar.py, mirrored in lib/solar.ts), and the GPU re-marches them
 * whenever that position moves. What was missing was the cause: shadows swung
 * across the streets as the timeline scrubbed with nothing on screen to say why.
 *
 * This puts the sun on a dome around the view centre at its true azimuth and
 * elevation, so the shadow direction on the ground and the sun in the sky are two
 * views of one number. Scrubbing the timeline moves both together.
 *
 * It is an *indicator*, not a photoreal sun: it is drawn in the annotation pass with
 * depth testing off, so a tower never swallows it and the user never loses track of
 * where the light is coming from. The disc is sized in pixels for the same reason —
 * at a zoom that fits Narhe to Swargate a physically-sized sun would be invisible.
 */

/** Dome radius, in local metres. Far enough to read as sky, near enough to stay in frustum. */
const DOME_M = 2600;
/** Disc radius in screen pixels, held constant across zoom. */
const DISC_PX = 13;
/** Glow radius as a multiple of the disc. */
const GLOW_SCALE = 4.2;

const VERT = `
uniform vec3  uSunLocal;     // sun offset from the anchor, in local metres
uniform vec3  uAnchor;       // view-centre anchor in local metres
uniform vec2  uViewport;     // drawing-buffer size in pixels
uniform float uSizePx;       // half-size of this quad, in pixels
varying vec2  vUv;

void main() {
  vUv = uv;
  vec4 clip = projectionMatrix * vec4(uAnchor + uSunLocal, 1.0);

  // Behind the eye: w flips sign and any screen-space offset smears the quad across
  // the viewport. Push it outside the clip volume instead of trying to draw it.
  if (clip.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // Billboard in clip space rather than by reconstructing a camera basis in local
  // metres. The twin's camera carries the whole mercator transform in its projection
  // matrix and no view matrix, so there is no orthonormal local basis to expand
  // along -- but a pixel offset is exact in NDC, whatever the projection does.
  // NDC spans 2 units across uViewport pixels, and scaling by w survives the
  // perspective divide that follows.
  clip.xy += position.xy * (uSizePx * 2.0 / uViewport) * clip.w;
  gl_Position = clip;
}`;

const FRAG = `
precision highp float;
uniform vec3  uColor;
uniform float uOpacity;
uniform float uCore;   // 1 = hard disc, 0 = soft glow
varying vec2  vUv;

void main() {
  float r = length(vUv * 2.0 - 1.0);
  if (r > 1.0) discard;
  // Core: a crisp disc with a hint of limb darkening. Glow: an inverse-square falloff,
  // which is what makes a bright point read as bright rather than merely large.
  float a = uCore > 0.5
    ? (1.0 - smoothstep(0.82, 1.0, r)) * (1.0 - 0.18 * r * r)
    : pow(1.0 - r, 2.6);
  gl_FragColor = vec4(uColor, a * uOpacity);
  if (gl_FragColor.a < 0.004) discard;
}`;

function quad(sizePx: number, core: boolean, origin: LocalOrigin) {
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uSunLocal: { value: new THREE.Vector3(0, 0, DOME_M) },
      uAnchor: { value: new THREE.Vector3(origin.widthM / 2, origin.heightM / 2, 0) },
      uViewport: { value: new THREE.Vector2(1, 1) },
      uSizePx: { value: sizePx },
      uColor: { value: new THREE.Color(1, 0.96, 0.88) },
      uOpacity: { value: 1 },
      uCore: { value: core ? 1 : 0 },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    // Additive: the sun adds light to whatever is behind it instead of masking it,
    // so the glow lies over the skyline the way a bright source actually does.
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  return { mesh, material };
}

/** Matches HeatTwinLayer's day/dusk ramp so the sun agrees with the light it casts. */
const HIGH = new THREE.Color(1.0, 0.97, 0.9);
const LOW = new THREE.Color(1.0, 0.63, 0.34);

export class SunDisc {
  readonly group = new THREE.Group();
  private readonly core: ReturnType<typeof quad>;
  private readonly glow: ReturnType<typeof quad>;
  private readonly dir = new THREE.Vector3(0, 0, 1);

  constructor(private readonly origin: LocalOrigin) {
    this.glow = quad(DISC_PX * GLOW_SCALE, false, origin);
    this.core = quad(DISC_PX, true, origin);
    // Glow first: additive blending is order-independent for colour, but keeping the
    // core last means it stays crisp if blending is ever changed.
    this.group.add(this.glow.mesh);
    this.group.add(this.core.mesh);
    this.group.renderOrder = 7; // above the route plaques
  }

  /**
   * Place the sun for a solar position.
   *
   * `azimuthDeg` is clockwise from north and `elevationDeg` is above the horizon —
   * the same convention as the backend, so east is +x and north is +y, matching
   * HeatTwinLayer.applySun and the shadow march in sunExposure.ts.
   */
  setSun(elevationDeg: number, azimuthDeg: number) {
    const visible = elevationDeg > 0;
    this.group.visible = visible;
    if (!visible) return;

    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    this.dir.set(Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el));
    const at = this.dir.clone().multiplyScalar(DOME_M);

    // Fade and warm the sun as it nears the horizon, on the same ramp the scene's
    // light uses — a white disc over amber streets would read as two different suns.
    const t = THREE.MathUtils.clamp(elevationDeg / 12, 0, 1);
    const colour = LOW.clone().lerp(HIGH, t);
    const rise = THREE.MathUtils.clamp(elevationDeg / 2.5, 0, 1); // fade in over the horizon

    for (const q of [this.core, this.glow]) {
      (q.material.uniforms.uSunLocal.value as THREE.Vector3).copy(at);
      (q.material.uniforms.uColor.value as THREE.Color).copy(colour);
    }
    this.core.material.uniforms.uOpacity.value = rise;
    // The glow swells as the sun drops: low sun means a long atmospheric path, which
    // is the same physics that reddens it.
    this.glow.material.uniforms.uOpacity.value = rise * (0.34 + 0.3 * (1 - t));
  }

  /** Keep the sun pinned near the view centre so it stays on screen as the map pans. */
  setAnchor(lat: number, lon: number) {
    const [x, y] = this.origin.toXY(lat, lon);
    for (const q of [this.core, this.glow]) {
      (q.material.uniforms.uAnchor.value as THREE.Vector3).set(x, y, 0);
    }
  }

  /** Drawing-buffer size, so the disc holds its pixel size across zoom and resize. */
  setViewport(widthPx: number, heightPx: number) {
    for (const q of [this.core, this.glow]) {
      (q.material.uniforms.uViewport.value as THREE.Vector2).set(widthPx, heightPx);
    }
  }

  dispose() {
    for (const q of [this.core, this.glow]) {
      q.mesh.geometry.dispose();
      q.material.dispose();
    }
  }
}
