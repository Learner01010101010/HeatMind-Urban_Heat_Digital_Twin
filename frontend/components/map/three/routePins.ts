"use client";

import * as THREE from "three";
import type { TwinFields } from "./fields";
import { LIFT_GLSL, type LiftUniforms } from "./lift";
import { REVEAL_GLSL } from "./reveal";

/**
 * The route's thermal profile, stood up on the route itself.
 *
 * A route line coloured by temperature tells you the order of things but not the
 * size of them: the difference between 34 °C and 41 °C is two shades of orange, and
 * nobody can read a number off that. As a row of pins whose *height* is the
 * temperature, the profile becomes a bar chart lying along the street — you can see
 * the exposed stretch rear up and the shaded stretch drop away, and judge how much
 * of the walk is spent in each.
 *
 * Every pin reads its own temperature from the heat keyframes on the GPU, at the
 * cell it stands on. Nothing is precomputed and sent per pin, so the whole profile
 * re-scales and re-colours as the timeline is scrubbed, for free. They ride the
 * vulnerability terrain with the rest of the scene, and they honour the corridor
 * reveal, so they appear with the street rather than floating ahead of it.
 *
 * One InstancedMesh, one draw call, whatever the route length.
 */

/** Metres between pins along the route. Close enough to resolve a single shaded
 *  block, far enough that a 9 km cross-city route is a few hundred instances. */
export const PIN_SPACING_M = 45;

/** Pin height = base + (feels − reference) × metres-per-degree, clamped. Tuned so a
 *  comfortable street is a low stud and a dangerous one is unmistakably tall, on a
 *  scale that reads against four-storey buildings rather than dwarfing them. */
const PIN_BASE_M = 6.0;
const PIN_REF_C = 26.0;
const PIN_M_PER_C = 2.6;
const PIN_MAX_RISE_C = 22.0;
const PIN_RADIUS_M = 2.1;

/** Hard cap on instances, so a pathological route cannot allocate without bound. */
const MAX_PINS = 4000;

const VERT = `
precision highp float;

attribute float aSeed;

uniform vec2 uExtent;
uniform float uGrow;        // 0..1 reveal animation when a new route lands
varying float vFeels;
varying float vUp;          // 0 at the foot of the pin, 1 at its cap
varying vec2 vGround;
varying vec3 vNormal;
${LIFT_GLSL}

void main() {
  // Instance translation is the pin's position on the ground.
  vec2 gxy = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xy;
  vGround = gxy;
  vec2 uv = clamp(gxy / uExtent, 0.0, 1.0);

  float feels = feelsAt(uv);
  vFeels = feels;

  float rise = clamp(feels - ${PIN_REF_C.toFixed(1)}, 0.0, ${PIN_MAX_RISE_C.toFixed(1)});
  float h = (${PIN_BASE_M.toFixed(1)} + rise * ${PIN_M_PER_C.toFixed(1)}) * uGrow;

  // The cylinder is authored unit-height along z with its base at 0, so scaling z
  // grows it upward from the pavement rather than about its middle.
  vec3 local = position;
  vUp = local.z;
  local.xy *= ${PIN_RADIUS_M.toFixed(1)};
  local.z *= h;

  vNormal = normalize(mat3(instanceMatrix) * normal);

  vec4 world = instanceMatrix * vec4(local, 1.0);
  world.z += liftAt(uv);   // stand on the vulnerability terrain with everything else
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world.xyz, 1.0);
}`;

const FRAG = `
precision highp float;

uniform sampler2D uLut;
uniform vec2 uExtent;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
varying float vFeels;
varying float vUp;
varying vec2 vGround;
varying vec3 vNormal;
${REVEAL_GLSL}

void main() {
  vec2 uv = clamp(vGround / uExtent, 0.0, 1.0);
  float rv = revealAt(uv);
  if (rv < 0.15) discard;

  // Same LUT, same encoding as the ground plane: a pin and the tarmac under it at
  // the same temperature are the same colour, which is the entire point of having
  // one scale in the product.
  vec3 col = texture2D(uLut, vec2(clamp((vFeels - 20.0) * 4.0 / 255.0, 0.0, 1.0), 0.5)).rgb;

  // Lit enough to read as a solid object rather than a flat decal, but kept bright
  // near the cap so the colour — which is the reading — survives the shading.
  float ndl = max(dot(normalize(vNormal), uSunDir), 0.0);
  float shade = 0.62 + 0.38 * ndl * max(uSunIntensity, 0.35);
  col *= mix(shade, 1.0, smoothstep(0.55, 1.0, vUp));

  // Darkened foot, so a dense run of pins still reads as separate objects standing
  // on a surface instead of merging into one coloured mass.
  col *= mix(0.45, 1.0, smoothstep(0.0, 0.22, vUp));

  // The cap carries a touch of self-illumination: it is the end of the bar, and the
  // height of that cap is the number being reported.
  col += col * smoothstep(0.88, 1.0, vUp) * 0.5;

  gl_FragColor = vec4(col * rv, rv);
}`;

export class RoutePins {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly capacity = MAX_PINS;

  constructor(
    private readonly fields: TwinFields,
    reveal: THREE.Texture,
    lut: THREE.Texture,
    lift: LiftUniforms,
  ) {
    // Unit height, base at z = 0, so the vertex shader can scale it by temperature.
    const geo = new THREE.CylinderGeometry(1, 0.72, 1, 7, 1, false);
    geo.rotateX(Math.PI / 2);   // three's cylinder runs along y; the twin is z-up
    geo.translate(0, 0, 0.5);   // base at the origin rather than straddling it

    const w = this.fields.cols * this.fields.cellM;
    const h = this.fields.rows * this.fields.cellM;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        ...lift,
        uLut: { value: lut },
        uExtent: { value: new THREE.Vector2(w, h) },
        uSunDir: { value: new THREE.Vector3(0, 0, 1) },
        uSunColor: { value: new THREE.Color(1, 0.94, 0.86) },
        uSunIntensity: { value: 0 },
        uGrow: { value: 1 },
        uReveal: { value: reveal },
        uRevealOn: { value: 0 },
      },
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthWrite: true,
    });

    geo.setAttribute(
      "aSeed",
      new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1),
    );

    this.mesh = new THREE.InstancedMesh(geo, this.material, this.capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.count = 0;
  }

  /**
   * Lay pins along a route, resampled to a fixed spacing.
   *
   * Resampled rather than placed on the route's own vertices: OSM nodes cluster at
   * junctions and thin out along straight runs, so using them directly would read as
   * a density map of the road network instead of an evenly-paced profile.
   */
  setRoute(coords: [number, number][]) {
    if (coords.length < 2) {
      this.mesh.count = 0;
      return;
    }
    const pts = this.fields.origin ? coords.map(([la, lo]) => this.fields.origin.toXY(la, lo)) : [];
    const m = new THREE.Matrix4();
    let n = 0;
    let carry = 0;

    const place = (x: number, y: number) => {
      if (n >= this.capacity) return;
      m.makeTranslation(x, y, 0);
      this.mesh.setMatrixAt(n, m);
      n++;
    };

    place(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length - 1 && n < this.capacity; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const seg = Math.hypot(bx - ax, by - ay);
      if (seg < 1e-6) continue;
      let t = PIN_SPACING_M - carry;
      while (t <= seg && n < this.capacity) {
        place(ax + ((bx - ax) * t) / seg, ay + ((by - ay) * t) / seg);
        t += PIN_SPACING_M;
      }
      carry = (carry + seg) % PIN_SPACING_M;
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.mesh.count = 0;
  }

  get count() {
    return this.mesh.count;
  }

  setSun(dir: THREE.Vector3, intensity: number, color: THREE.Color) {
    const u = this.material.uniforms;
    u.uSunDir.value.copy(dir);
    u.uSunIntensity.value = intensity;
    u.uSunColor.value.copy(color);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
