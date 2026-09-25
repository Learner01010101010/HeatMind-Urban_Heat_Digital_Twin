"use client";

import * as THREE from "three";
import { deviceProfile, supersampleFor } from "@/lib/deviceProfile";
import type { TwinFields } from "./fields";

/**
 * Sun exposure, recomputed on the GPU every time the sun moves.
 *
 * This is the same horizon march as the backend's shadow_engine.sun_exposure(), run
 * per-fragment at SUPERSAMPLE x the physics grid instead of once per 10 m cell. The
 * output is what lights the 3D scene AND what the ground-heat shader darkens by, so
 * the shading the user sees is derived from the same height field the reported
 * temperatures came from — the two cannot drift apart.
 *
 * The backend stays authoritative for any number the product reports; this pass is
 * the high-resolution visual counterpart, and HeatTwinLayer samples both to display
 * a live agreement figure.
 *
 * Extra over the backend model (visual only, does not change the agreement metric):
 * a penumbra term. The sun subtends ~0.53 deg, so a shadow edge softens in proportion
 * to the occluder's distance — the single biggest cue that separates a real shadow
 * from a stencil.
 */
/**
 * Upper bound on the supersample factor. The *effective* factor is whatever the
 * device's pixel budget allows (see lib/deviceProfile), because this factor's cost
 * is quadratic in the zone size: 6x was ~1.4 MP on the original zone and is 13.4 MP
 * on the grown one, and would be worse again on a bigger one. A factor alone cannot
 * express "as fine as this device can afford".
 */
const SUPERSAMPLE = 6;
const SUN_ANGULAR_RADIUS = 0.00465; // tan of ~0.266 deg
/** Minimum penumbra width, in metres — about one cell of the 10 m height raster. */
const PENUMBRA_FLOOR_M = 6.0;
/** Ray step growth per metre travelled; bounds the cost of long low-sun rays. */
const STEP_GROWTH = 0.02;

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uHeight;
uniform sampler2D uCanopy;
uniform float uHeightScale;   // metres per unit texel
uniform vec2  uSunXY;         // horizontal unit vector toward the sun, in local metres
uniform float uTanElev;       // tan(solar elevation)
uniform float uMaxD;          // metres to march
uniform float uStep;          // metres per step
uniform vec2  uExtent;        // zone size in metres (width, height)
uniform float uHead;          // pedestrian head height
uniform float uSunUp;         // 1 when the sun is above the horizon

// Backend parity: a cell counts as tree-shaded when canopy > 0.12, canopy top at 8 m.
const float TREE_TOP_M = 8.0;
const float TREE_MIN = 0.12;

// The height field is a 10 m raster, so an occluder's HEIGHT must be read without
// interpolation: bilinear sampling averages a building's height with the zeros around
// it and quietly shrinks small footprints out of existence (it more than halved the
// shadowed area against the backend's own figure). uHeight is therefore NEAREST
// sampled, exactly like the backend's nearest-cell march.
//
// What the extra resolution buys is not finer occluder geometry -- you cannot recover
// sub-10 m geometry from a 10 m raster -- but a shadow EDGE resolved per output pixel
// and a real penumbra, instead of a per-cell binary mask.
float heightAt(vec2 p) {
  return texture2D(uHeight, p / uExtent).r * uHeightScale;
}

void main() {
  if (uSunUp < 0.5) {
    gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0); // night: no sun, fully "shadowed"
    return;
  }
  vec2 xy = vUv * uExtent;
  float base = heightAt(xy) + uHead;

  float blocked = 0.0;          // hard building occlusion
  float clearance = 1.0;        // softest clearance seen -> penumbra
  float treeOcc = texture2D(uCanopy, vUv).r; // canopy directly overhead

  // Progressive stepping. A fixed step is wasteful at low sun: the ray length is
  // maxHeight / tan(elev), so at 4 deg elevation it runs the full 350 m clamp and a
  // uniform 3.3 m step costs >100 samples per pixel (measured: 0.3 ms at noon, 40 ms
  // at sunset). What matters is ANGULAR resolution, and a distant occluder needs far
  // less linear precision than a near one, so the step grows with distance: ~32 steps
  // to 350 m instead of 105, while the near field keeps its original resolution.
  float d = 0.0;
  float stepLen = uStep;
  for (int i = 0; i < 140; i++) {
    d += stepLen;
    stepLen = uStep * (1.0 + d * STEP_GROWTH);
    if (d > uMaxD) break;
    vec2 p = xy + uSunXY * d;
    if (p.x < 0.0 || p.y < 0.0 || p.x > uExtent.x || p.y > uExtent.y) break;

    float rayH = base + d * uTanElev;
    float h = heightAt(p);

    // Penumbra width grows with the occluder's distance: the sun subtends ~0.53 deg,
    // so an edge 300 m from its occluder is ~2.8 m wide while one at 10 m is ~5 cm.
    // The floor is held at PENUMBRA_FLOOR_M rather than the true sub-centimetre value
    // because the occluder heights come from a 10 m raster -- softening the edge over
    // roughly one cell is honest about that source resolution, where a razor-sharp
    // edge would imply precision the height field does not have.
    float soft = max(d * SUN_ANGULAR_RADIUS_UNIFORM, PENUMBRA_FLOOR_M);
    clearance = min(clearance, (rayH - h) / soft);
    blocked = max(blocked, step(rayH, h));

    float canopy = texture2D(uCanopy, p / uExtent).r;
    float treeTop = canopy > TREE_MIN ? TREE_TOP_M : 0.0;
    treeOcc = max(treeOcc, treeTop > rayH ? canopy : 0.0);
  }

  float shadow = 1.0 - smoothstep(-1.0, 1.0, clearance);
  shadow = max(shadow, blocked * 0.92);
  float exposure = (1.0 - shadow) * (1.0 - treeOcc);
  gl_FragColor = vec4(exposure, shadow, treeOcc, 1.0);
}`;

export class SunExposurePass {
  readonly target: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private lastKey = "";

  /** The factor actually used, after the device budget. Exposed for the debug hook. */
  readonly supersample: number;

  constructor(private readonly fields: TwinFields) {
    this.supersample = Math.min(SUPERSAMPLE, supersampleFor(fields.cols, fields.rows));
    const w = fields.cols * this.supersample;
    const h = fields.rows * this.supersample;
    this.target = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG.replace(/SUN_ANGULAR_RADIUS_UNIFORM/g, SUN_ANGULAR_RADIUS.toFixed(6)).replace(/PENUMBRA_FLOOR_M/g, PENUMBRA_FLOOR_M.toFixed(2))
        .replace(/STEP_GROWTH/g, STEP_GROWTH.toFixed(4)),
      uniforms: {
        uHeight: { value: fields.height },
        uCanopy: { value: fields.canopy },
        uHeightScale: { value: fields.heightScaleM },
        uSunXY: { value: new THREE.Vector2(0, 1) },
        uTanElev: { value: 1 },
        uMaxD: { value: 200 },
        uStep: { value: fields.cellM / 3 },
        uExtent: { value: new THREE.Vector2(fields.origin.widthM, fields.origin.heightM) },
        uHead: { value: 1.6 },
        uSunUp: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /**
   * Re-march only when the sun has actually moved.
   *
   * `moving` coarsens the threshold while the timeline is being dragged. Scrubbing
   * three hours swings the sun about 45 degrees, which at the resting granularity is
   * ~180 full marches of a multi-megapixel target during one gesture — the single
   * worst moment in the app on a phone. Coarsening it during the drag does not
   * freeze the shadows: the scene relights every frame from this buffer regardless,
   * so they keep moving, in slightly larger steps.
   *
   * The moment the drag stops, `moving` goes false, the fine threshold no longer
   * matches the last key, and one final march lands the exact position. Nothing is
   * left approximate once the user stops moving, which is when they look closely.
   */
  update(renderer: THREE.WebGLRenderer, elevDeg: number, azDeg: number, moving = false): boolean {
    const p = deviceProfile();
    const stepDeg = moving ? p.sunStepDegScrub : p.sunStepDegRest;
    const q = 1 / stepDeg;
    const key = `${Math.round(elevDeg * q)}|${Math.round(azDeg * q)}|${moving ? "m" : "r"}`;
    if (key === this.lastKey) return false;
    this.lastKey = key;

    const u = this.material.uniforms;
    const up = elevDeg > 0.5;
    u.uSunUp.value = up ? 1 : 0;
    if (up) {
      const az = THREE.MathUtils.degToRad(azDeg);
      // azimuth is clockwise from north: east = sin, north = cos (matches backend)
      u.uSunXY.value.set(Math.sin(az), Math.cos(az));
      const tanElev = Math.tan(THREE.MathUtils.degToRad(elevDeg));
      u.uTanElev.value = tanElev;
      const maxH = this.fields.heightScaleM;
      u.uMaxD.value = Math.min(350, Math.max(maxH, 8) / Math.max(tanElev, 0.02));
      // base step stays at a third of a physics cell; STEP_GROWTH bounds the total
      u.uStep.value = this.fields.cellM / 3;
    }

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    return true;
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
  }
}
