"use client";

import * as THREE from "three";
import type { TwinFields } from "./fields";
import { LIFT_GLSL, type LiftUniforms } from "./lift";
import { REVEAL_GLSL } from "./reveal";

/**
 * Traffic signals and pedestrian crossings, drawn where OSM maps them.
 *
 * Nothing here is placed by rule. The twin used to have no highway nodes at all —
 * the Overpass query asked for `way["highway"]` and never `node["highway"]`, so the
 * extract contained zero signals and the junctions were bare. These are the real
 * `highway=traffic_signals`, `crossing`, `stop`, `give_way` and `mini_roundabout`
 * nodes; a junction with no signal in OSM gets no signal here.
 *
 * One InstancedMesh, one draw call. The mast and the head are a single box geometry
 * scaled per instance in the vertex shader rather than two meshes, because a signal
 * is small enough on screen that the join never reads.
 */

/** Mast height. Indian signal heads sit around this off the carriageway. */
const MAST_H = 4.2;
const MAST_R = 0.09;
const HEAD_W = 0.34;
const HEAD_H = 1.05;

/** Kinds that get a mast. The rest are ground markings. */
const MASTED = new Set(["traffic_signals", "stop", "give_way"]);

export interface SignalRecord {
  lat: number;
  lon: number;
  kind: string;
  crossing: string;
}

// aPart: 0 = mast, 1 = signal head, 2 = ground marking.
const VERT = `
attribute float aPart;
attribute float aKind;
attribute float aSeed;

varying float vPart;
varying float vKind;
varying float vLocalY;
varying vec2 vGround;

uniform vec2 uExtent;
uniform float uGrow;      // 0 flat on the map, 1 standing up in the twin
uniform float uScale;     // screen-space compensation, so a mast stays visible
${LIFT_GLSL}

void main() {
  vPart = aPart;
  vKind = aKind;

  vec3 local = position;
  if (aPart < 0.5) {
    // mast: a thin column
    local.xy *= ${MAST_R.toFixed(3)} * uScale;
    local.z = (local.z + 0.5) * ${MAST_H.toFixed(3)} * uGrow;
  } else if (aPart < 1.5) {
    // head: a small box near the top, turned a little so the lamps face the road
    float a = aSeed * 6.2831853;
    float c = cos(a), s = sin(a);
    local.xy *= ${HEAD_W.toFixed(3)} * uScale;
    local.xy = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
    local.z = (local.z + 0.5) * ${HEAD_H.toFixed(3)} * uGrow
            + (${MAST_H.toFixed(3)} - ${HEAD_H.toFixed(3)}) * uGrow;
  } else {
    // ground marking: a flat patch that stays flat in both modes
    local.xy *= 2.6 * uScale;
    local.z = 0.0;
  }
  vLocalY = local.z;

  vec4 world = instanceMatrix * vec4(local, 1.0);
  vGround = world.xy;
  world.z += liftAt(clamp(vGround / uExtent, 0.0, 1.0)) + 0.06;
  gl_Position = projectionMatrix * modelViewMatrix * world;
}`;

const FRAG = `
precision highp float;

varying float vPart;
varying float vKind;
varying float vLocalY;
varying vec2 vGround;

uniform sampler2D uExposure;
uniform vec2 uExtent;
uniform float uSunIntensity;
${REVEAL_GLSL}

void main() {
  vec2 uv = clamp(vGround / uExtent, 0.0, 1.0);
  float rv = revealAt(uv);
  if (rv < 0.15) discard;

  vec3 col;
  if (vPart < 0.5) {
    col = vec3(0.17, 0.17, 0.175);                       // galvanised mast
  } else if (vPart < 1.5) {
    // Three lamps down the head. Which one is lit is fixed per signal rather than
    // animated: the twin is a heat model, and a blinking city would imply it is
    // simulating signal phase, which it is not.
    float t = clamp((vLocalY - (${MAST_H.toFixed(3)} - ${HEAD_H.toFixed(3)}))
                    / ${HEAD_H.toFixed(3)}, 0.0, 1.0);
    vec3 red = vec3(0.86, 0.16, 0.13);
    vec3 amber = vec3(0.95, 0.66, 0.12);
    vec3 green = vec3(0.24, 0.76, 0.34);
    vec3 lamp = t > 0.66 ? red : (t > 0.33 ? amber : green);
    float lit = smoothstep(0.10, 0.22, abs(fract(t * 3.0 + 0.5) - 0.5));
    col = mix(vec3(0.09, 0.09, 0.10), lamp, 1.0 - lit);
  } else {
    // crossing: painted bars, lighter than the asphalt under them
    float bar = step(0.5, fract(vGround.x * 0.62 + vGround.y * 0.32));
    col = mix(vec3(0.20, 0.20, 0.20), vec3(0.78, 0.77, 0.72), bar);
  }

  float shadow = texture2D(uExposure, uv).g;
  col *= 0.62 + 0.38 * uSunIntensity * (1.0 - 0.6 * shadow);
  gl_FragColor = vec4(col * mix(0.55, 1.0, rv), 1.0);
}`;

export class TrafficSignals {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  readonly count: number;

  constructor(
    records: SignalRecord[],
    fields: TwinFields,
    exposure: THREE.Texture,
    reveal: THREE.Texture,
    lift: LiftUniforms,
  ) {
    // Three instances per masted signal (mast, head) or one per ground marking, so
    // the instance count is known before the buffers are sized.
    const parts: { rec: SignalRecord; part: number }[] = [];
    for (const r of records) {
      if (MASTED.has(r.kind)) {
        parts.push({ rec: r, part: 0 }, { rec: r, part: 1 });
      } else {
        parts.push({ rec: r, part: 2 });
      }
    }
    this.count = parts.length;

    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uExposure: { value: exposure },
        uExtent: { value: new THREE.Vector2(fields.origin.widthM, fields.origin.heightM) },
        uSunIntensity: { value: 1 },
        uGrow: { value: 0 },
        uScale: { value: 1 },
        uReveal: { value: reveal },
        uRevealOn: { value: 0 },
        ...lift,
      },
    });

    this.mesh = new THREE.InstancedMesh(geo, this.material, Math.max(1, this.count));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;

    const part = new Float32Array(Math.max(1, this.count));
    const kind = new Float32Array(Math.max(1, this.count));
    const seed = new Float32Array(Math.max(1, this.count));
    const m = new THREE.Matrix4();
    parts.forEach((p, i) => {
      const [x, y] = fields.origin.toXY(p.rec.lat, p.rec.lon);
      m.makeTranslation(x, y, 0);
      this.mesh.setMatrixAt(i, m);
      part[i] = p.part;
      kind[i] = p.rec.kind === "traffic_signals" ? 0 : p.rec.kind === "crossing" ? 1 : 2;
      // Stable per-node, so a signal faces the same way every time the twin loads.
      seed[i] = ((Math.abs(p.rec.lat * 7919 + p.rec.lon * 6271) * 1000) % 1000) / 1000;
    });
    geo.setAttribute("aPart", new THREE.InstancedBufferAttribute(part, 1));
    geo.setAttribute("aKind", new THREE.InstancedBufferAttribute(kind, 1));
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 1));
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
  }

  /** 0 lays the signals flat with the 2D map, 1 stands them up in the twin. */
  setGrow(g: number) {
    this.material.uniforms.uGrow.value = g;
  }

  /**
   * Keep a 9 cm mast from vanishing when the camera is far enough back to see the
   * whole corridor. Widening only — the height stays truthful.
   */
  setPixelScale(metresPerPixel: number) {
    this.material.uniforms.uScale.value = Math.max(1, Math.min(9, metresPerPixel * 1.6));
  }

  setSun(intensity: number) {
    this.material.uniforms.uSunIntensity.value = intensity;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
