"use client";

import * as THREE from "three";
import type { TwinFields } from "./fields";
import { LIFT_GLSL, type LiftUniforms } from "./lift";

/**
 * Hydration and rest stops, standing up in the twin.
 *
 * They were already on the map as HTML markers, and in the flat view that is fine.
 * In the twin it is not: a 22 px sticker pinned to the ground is lost among extruded
 * buildings and canopy, sits at whatever screen position the ground happens to
 * project to, and reads as something floating over the scene rather than standing in
 * it. On a nine-kilometre route with two stops you can look straight at the city and
 * never find them.
 *
 * So in the twin each stop becomes a beacon: a post rising clear of the roofs with a
 * lit head on top and a ring on the ground marking where it actually is. Tall enough
 * to be found from across the neighbourhood, and occluded by buildings like anything
 * else in the scene, so its height reads as height rather than as an overlay.
 *
 * Colour carries the one distinction that matters. A filled head is a stop with a
 * real mapped source behind it. A hollow, amber-ringed head is a stop the physiology
 * called for where OpenStreetMap maps nothing within reach — the place to have
 * brought your own water.
 */

/** Post height. Clears the 6.4 m median building comfortably. */
const POST_M = 15.0;
const POST_R = 0.30;
const HEAD_R = 1.6;
const RING_R = 3.2;

export interface BreakBeaconRecord {
  lat: number;
  lon: number;
  /** "water" | "rest" | "water+rest" */
  type: string;
  hasSource: boolean;
}

// aPart: 0 post, 1 head, 2 ground ring.
const VERT = `
attribute float aPart;
attribute float aKind;     // 0 water, 1 rest, 2 both
attribute float aDry;      // 1 when nothing is mapped within reach

varying float vPart;
varying float vKind;
varying float vDry;
varying vec3 vLocal;
varying vec2 vGround;

uniform vec2 uExtent;
uniform float uGrow;    // 0 flat with the 2D map, 1 standing in the twin
uniform float uScale;   // screen-space compensation
${LIFT_GLSL}

void main() {
  vPart = aPart;
  vKind = aKind;
  vDry = aDry;

  vec3 p = position;
  if (aPart < 0.5) {
    // The base mesh is a unit sphere, so z runs -1..1; map it to 0..POST_M rather
    // than offsetting by 0.5, which sank a quarter of the post below the ground.
    p.xy *= ${POST_R.toFixed(2)} * uScale;
    p.z = (p.z * 0.5 + 0.5) * ${POST_M.toFixed(1)} * uGrow;
  } else if (aPart < 1.5) {
    p *= ${HEAD_R.toFixed(2)} * uScale;
    p.z += ${POST_M.toFixed(1)} * uGrow;
  } else {
    // The ground ring stays flat and stays put in both modes: it is the honest
    // answer to "where is it", while the post is only there to be findable.
    p.xy *= ${RING_R.toFixed(2)} * uScale;
    p.z = 0.0;
  }
  vLocal = p;

  vec4 world = instanceMatrix * vec4(p, 1.0);
  vGround = world.xy;
  world.z += liftAt(clamp(vGround / uExtent, 0.0, 1.0)) + 0.12;
  gl_Position = projectionMatrix * modelViewMatrix * world;
}`;

const FRAG = `
precision highp float;

varying float vPart;
varying float vKind;
varying float vDry;
varying vec3 vLocal;
varying vec2 vGround;

void main() {
  vec3 water = vec3(0.36, 0.78, 0.98);
  vec3 rest = vec3(0.98, 0.70, 0.30);
  vec3 both = vec3(0.48, 0.88, 0.58);
  vec3 tint = vKind < 0.5 ? water : (vKind < 1.5 ? rest : both);

  if (vPart < 0.5) {
    // Post: dark at the foot, picking up the head's colour as it rises, so the eye
    // follows it up to the marker instead of stopping at a grey stick.
    float t = clamp(vLocal.z / ${POST_M.toFixed(1)}, 0.0, 1.0);
    vec3 col = mix(vec3(0.10, 0.11, 0.12), tint * 0.75, t * t);
    gl_FragColor = vec4(col, 1.0);
  } else if (vPart < 1.5) {
    // Head: bright and flat-shaded so it holds its colour in shadow. A dry stop is
    // hollow -- dark inside an amber rim -- because it is a warning, not a place.
    float edge = length(vLocal.xy) / max(${HEAD_R.toFixed(2)}, 0.001);
    if (vDry > 0.5) {
      float rim = smoothstep(0.55, 0.85, edge);
      gl_FragColor = vec4(mix(vec3(0.09, 0.09, 0.10), rest, rim), 1.0);
    } else {
      gl_FragColor = vec4(tint * (0.82 + 0.35 * (1.0 - edge)), 1.0);
    }
  } else {
    float r = length(vLocal.xy) / max(${RING_R.toFixed(2)}, 0.001);
    float ring = smoothstep(0.62, 0.78, r) * (1.0 - smoothstep(0.92, 1.0, r));
    if (ring < 0.04) discard;
    gl_FragColor = vec4(tint * 0.9 * ring, ring);
  }
}`;

export class BreakBeacons {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly capacity: number;
  private readonly part: Float32Array;
  private readonly kind: Float32Array;
  private readonly dry: Float32Array;

  constructor(fields: TwinFields, lift: LiftUniforms, capacity = 96) {
    // Three instances per stop: post, head, ground ring.
    this.capacity = capacity * 3;
    const geo = new THREE.SphereGeometry(1, 10, 7);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uExtent: { value: new THREE.Vector2(fields.origin.widthM, fields.origin.heightM) },
        uGrow: { value: 0 },
        uScale: { value: 1 },
        ...lift,
      },
      transparent: true,
      depthWrite: true,
    });

    this.mesh = new THREE.InstancedMesh(geo, this.material, this.capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6; // above buildings and canopy
    this.mesh.count = 0;
    this.mesh.visible = false;

    this.part = new Float32Array(this.capacity);
    this.kind = new Float32Array(this.capacity);
    this.dry = new Float32Array(this.capacity);
    geo.setAttribute("aPart", new THREE.InstancedBufferAttribute(this.part, 1));
    geo.setAttribute("aKind", new THREE.InstancedBufferAttribute(this.kind, 1));
    geo.setAttribute("aDry", new THREE.InstancedBufferAttribute(this.dry, 1));
  }

  set(records: BreakBeaconRecord[], fields: TwinFields) {
    const m = new THREE.Matrix4();
    let i = 0;
    for (const r of records) {
      if (i + 3 > this.capacity) break;
      const [x, y] = fields.origin.toXY(r.lat, r.lon);
      const k = r.type === "rest" ? 1 : r.type === "water+rest" ? 2 : 0;
      for (let part = 0; part < 3; part++) {
        m.makeTranslation(x, y, 0);
        this.mesh.setMatrixAt(i, m);
        this.part[i] = part;
        this.kind[i] = k;
        this.dry[i] = r.hasSource ? 0 : 1;
        i++;
      }
    }
    this.mesh.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
    const g = this.mesh.geometry;
    (g.getAttribute("aPart") as THREE.InstancedBufferAttribute).needsUpdate = true;
    (g.getAttribute("aKind") as THREE.InstancedBufferAttribute).needsUpdate = true;
    (g.getAttribute("aDry") as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  setGrow(g: number) {
    this.material.uniforms.uGrow.value = g;
    this.mesh.visible = g > 0.002 && this.mesh.count > 0;
  }

  /** Keep a 1.6 m head findable when the camera is far enough back to see the corridor. */
  setPixelScale(metresPerPixel: number) {
    this.material.uniforms.uScale.value = Math.max(1, Math.min(7, metresPerPixel * 1.3));
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
