"use client";

import * as THREE from "three";
import type { TwinFields } from "./fields";
import { REVEAL_GLSL } from "./reveal";

/**
 * The real OSM street network as ground-level ribbons.
 *
 * Previously the 3D twin had no road geometry at all: streets were whatever showed
 * through from the Esri raster basemap, which the heat plane then covered, so the
 * network read as vague smudges under a blue sheet. These are the actual OSM ways —
 * the same 473 ways, widths and classes the routing graph and the traffic-heat term
 * use — so what you see underfoot is the network the model runs on.
 *
 * Drawn BELOW the heat plane on purpose. The heat surface is translucent, so the
 * carriageway reads through it and gets tinted by the temperature above it, instead
 * of the roads hiding the heat or the heat hiding the roads.
 */

// Ribbon z, just above the basemap and below GroundHeat's 0.05.
const ROAD_Z = 0.02;

const CLASS_INDEX: Record<string, number> = {
  trunk: 0, trunk_link: 0, primary: 1, secondary: 2, tertiary: 3,
  unclassified: 4, residential: 4, living_street: 4, service: 5,
  footway: 6, path: 6, pedestrian: 6, steps: 6, track: 7, cycleway: 8,
};

// Per class: base asphalt tone, and whether it carries a painted centre line.
const CLASS_TONE = [
  0.30, 0.30, 0.32, // trunk — widest, palest wear
  0.27, 0.27, 0.29, // primary
  0.25, 0.25, 0.27, // secondary
  0.23, 0.23, 0.25, // tertiary
  0.21, 0.21, 0.23, // residential / unclassified
  0.19, 0.19, 0.21, // service
  0.34, 0.32, 0.29, // footway — paving, warmer
  0.26, 0.23, 0.19, // track — dirt
  0.17, 0.21, 0.24, // cycleway — bluish
];
const HAS_CENTRELINE = [1, 1, 1, 1, 0, 0, 0, 0, 0];

const VERT = `
attribute float aAlong;    // metres travelled along the way
attribute float aAcross;   // -1 at one kerb, +1 at the other
attribute float aClass;
attribute float aWidth;

varying float vAlong;
varying float vAcross;
varying float vClass;
varying float vWidth;
varying vec2 vGround;

void main() {
  vAlong = aAlong;
  vAcross = aAcross;
  vClass = aClass;
  vWidth = aWidth;
  vGround = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = `
precision highp float;

varying float vAlong;
varying float vAcross;
varying float vClass;
varying float vWidth;
varying vec2 vGround;

uniform sampler2D uExposure;
uniform sampler2D uSvf;
uniform vec2 uExtent;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uTone[9];
uniform float uCentreline[9];
${REVEAL_GLSL}

void main() {
  int ci = int(vClass + 0.5);
  vec3 col = uTone[ci];

  float a = abs(vAcross);

  // kerb: darken the outer eighth so the edge of the carriageway is legible
  col *= 1.0 - 0.35 * smoothstep(0.78, 1.0, a);

  // painted centre line, dashed, on classified roads only
  float dash = step(0.45, fract(vAlong / 9.0));
  float centre = (1.0 - smoothstep(0.0, 1.6 / max(vWidth, 2.0), a)) * dash * uCentreline[ci];
  col = mix(col, vec3(0.62, 0.60, 0.48), centre * 0.7);

  // lighting from the same field the ground and buildings use
  vec2 uv = clamp(vGround / uExtent, 0.0, 1.0);
  float svf = texture2D(uSvf, uv).r;
  float shadow = texture2D(uExposure, uv).g;
  float ambient = mix(0.34, 0.62, pow(clamp(svf, 0.0, 1.0), 1.5));
  float direct = uSunIntensity * (1.0 - 0.8 * shadow);
  col *= ambient + 0.55 * direct * 0.35;
  col = mix(col, col * 0.78 + vec3(0.01, 0.025, 0.06), shadow * 0.6);

  col *= mix(0.05, 1.0, revealAt(uv));

  gl_FragColor = vec4(col, 1.0);
}`;

export interface RoadFeatureProps {
  name: string;
  highway: string;
  surface: string;
  width_m: number;
  walkable: boolean;
  bikeable: boolean;
  traffic_heat_c: number;
}

export class Roads {
  readonly mesh: THREE.Mesh;
  readonly triangles: number;
  private readonly material: THREE.ShaderMaterial;

  constructor(
    features: GeoJSON.Feature<GeoJSON.LineString, RoadFeatureProps>[],
    fields: TwinFields,
    exposure: THREE.Texture,
    reveal: THREE.Texture,
  ) {
    const pos: number[] = [];
    const along: number[] = [];
    const across: number[] = [];
    const cls: number[] = [];
    const wid: number[] = [];

    const push = (x: number, y: number, s: number, t: number, k: number, w: number) => {
      pos.push(x, y, ROAD_Z);
      along.push(s);
      across.push(t);
      cls.push(k);
      wid.push(w);
    };

    for (const f of features) {
      const p = f.properties;
      const k = CLASS_INDEX[p.highway] ?? 4;
      const w = Math.max(2, p.width_m);
      const half = w / 2;

      const pts = f.geometry.coordinates.map((c) => {
        const [x, y] = fields.origin.toXY(c[1], c[0]);
        return new THREE.Vector2(x, y);
      });
      if (pts.length < 2) continue;

      let run = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-4) continue;
        // unit normal, for offsetting to each kerb
        const nx = -dy / len;
        const ny = dx / len;
        const s0 = run;
        const s1 = run + len;
        run = s1;

        const aL = [a.x + nx * half, a.y + ny * half];
        const aR = [a.x - nx * half, a.y - ny * half];
        const bL = [b.x + nx * half, b.y + ny * half];
        const bR = [b.x - nx * half, b.y - ny * half];

        push(aL[0], aL[1], s0, 1, k, w);
        push(aR[0], aR[1], s0, -1, k, w);
        push(bR[0], bR[1], s1, -1, k, w);
        push(aL[0], aL[1], s0, 1, k, w);
        push(bR[0], bR[1], s1, -1, k, w);
        push(bL[0], bL[1], s1, 1, k, w);

        // A round cap at each interior vertex fills the wedge that two straight
        // ribbons leave at a bend; cheaper and more robust than mitring, and a
        // miter blows up at the near-180-degree turns OSM geometry contains.
        if (i > 0) {
          const SEGMENTS = 6;
          for (let j = 0; j < SEGMENTS; j++) {
            const t0 = (j / SEGMENTS) * Math.PI * 2;
            const t1 = ((j + 1) / SEGMENTS) * Math.PI * 2;
            push(a.x, a.y, s0, 0, k, w);
            push(a.x + Math.cos(t0) * half, a.y + Math.sin(t0) * half, s0, 0.9, k, w);
            push(a.x + Math.cos(t1) * half, a.y + Math.sin(t1) * half, s0, 0.9, k, w);
          }
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("aAlong", new THREE.Float32BufferAttribute(along, 1));
    geo.setAttribute("aAcross", new THREE.Float32BufferAttribute(across, 1));
    geo.setAttribute("aClass", new THREE.Float32BufferAttribute(cls, 1));
    geo.setAttribute("aWidth", new THREE.Float32BufferAttribute(wid, 1));
    geo.computeBoundingSphere();

    const tones: THREE.Color[] = [];
    for (let i = 0; i < 9; i++) {
      tones.push(new THREE.Color(CLASS_TONE[i * 3], CLASS_TONE[i * 3 + 1], CLASS_TONE[i * 3 + 2]));
    }

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uExposure: { value: exposure },
        uSvf: { value: fields.svf },
        uExtent: { value: new THREE.Vector2(fields.origin.widthM, fields.origin.heightM) },
        uSunColor: { value: new THREE.Color(1.0, 0.94, 0.86) },
        uSunIntensity: { value: 1 },
        uTone: { value: tones },
        uCentreline: { value: HAS_CENTRELINE },
        uReveal: { value: reveal },
        uRevealOn: { value: 0 },
      },
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = 0; // under GroundHeat, so the heat tints the carriageway
    this.triangles = pos.length / 9;
  }

  setSun(intensity: number, color: THREE.Color) {
    this.material.uniforms.uSunIntensity.value = intensity;
    this.material.uniforms.uSunColor.value.copy(color);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
