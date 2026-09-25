"use client";

import * as THREE from "three";
import type { TwinFields } from "./fields";
import { LIFT_GLSL, type LiftUniforms } from "./lift";
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
/** Narrowest a road may be drawn, in screen pixels, however far the camera is. */
const MIN_ROAD_PX = 2.8;
/** ...but never widened past this in world metres, or the city becomes a grey mat
 *  and the class tones stop showing any hierarchy. */
const MAX_MIN_WIDTH_M = 13.0;

const CLASS_INDEX: Record<string, number> = {
  trunk: 0, trunk_link: 0, primary: 1, secondary: 2, tertiary: 3,
  unclassified: 4, residential: 4, living_street: 4, service: 5,
  footway: 6, path: 6, pedestrian: 6, steps: 6, track: 7, cycleway: 8,
};

// Per class: base asphalt tone, and whether it carries a painted centre line.
// Deliberately high-contrast: the heat plane sits at ~50% opacity above these, so a
// tone that reads fine unlit gets diluted to near-invisibility under the heat tint.
// Brightness falls off with road class (highway brightest -> service darkest), and
// footway/track/cycleway break from grayscale into warm beige / brown / cool blue so
// they're identifiable by hue alone, not just by how wide the ribbon is.
const CLASS_TONE = [
  0.52, 0.51, 0.49, // trunk — highway, worn concrete, brightest and widest
  0.44, 0.43, 0.41, // primary
  0.37, 0.36, 0.35, // secondary
  0.31, 0.30, 0.29, // tertiary
  0.25, 0.245, 0.24, // residential / unclassified
  0.20, 0.195, 0.19, // service
  0.40, 0.37, 0.32, // footway — light paving, warm beige
  0.28, 0.22, 0.16, // track — dirt, brown
  0.17, 0.26, 0.19, // cycleway — moss green
  0.29, 0.285, 0.275, // junction face — mid-grey, between tertiary and residential
];
// A dashed centre line separates opposing traffic, so it belongs on a road that has
// opposing traffic: classified streets, not a 3 m service lane or a footpath.
const HAS_CENTRELINE = [1, 1, 1, 1, 0, 0, 0, 0, 0, 0];
// Edge lines mark the usable carriageway and are what actually makes a road read as
// a road rather than a grey ribbon, so they go on everything a car drives down --
// residential streets included. Not on footways, tracks, cycleways or the junction
// face, none of which carry lane markings in the real world either.
const HAS_EDGELINE = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
/** Tone slot for the disc that fills a junction. */
const JUNCTION_CLASS = 9;
const TONE_SLOTS = 10;

const VERT = `
attribute float aAlong;    // metres travelled along the way
attribute float aAcross;   // -1 at one kerb, +1 at the other
attribute float aClass;
attribute float aWidth;
attribute vec2 aOffset;    // unit perpendicular; the shader sets the actual width

uniform float uMinWidthM;  // narrowest a road may be drawn, in metres

varying float vAlong;
varying float vAcross;
varying float vClass;
varying float vWidth;
varying float vTrueWidth;
varying vec2 vGround;

uniform vec2 uExtent;
${LIFT_GLSL}

void main() {
  vAlong = aAlong;
  vAcross = aAcross;
  vClass = aClass;
  // Width is applied here rather than baked into the geometry so a service lane can
  // be held to a minimum number of screen pixels. A 2 m alley is a third of a pixel
  // at the zoom that fits a cross-city route, which is why the small streets
  // disappeared entirely when the zone grew. The centreline stays put; only the
  // kerb offset grows.
  float wEff = max(aWidth, uMinWidthM);
  vWidth = wEff;
  // The drawn width is inflated at low zoom so minor streets stay visible; the lane
  // count has to come from the real one or a 3 m alley picks up six lanes of markings.
  vTrueWidth = aWidth;

  vec3 p = position;
  p.xy += aOffset * (wEff * 0.5);
  vGround = p.xy;
  p.z += liftAt(clamp(vGround / uExtent, 0.0, 1.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = `
precision highp float;

varying float vAlong;
varying float vAcross;
varying float vClass;
varying float vWidth;
varying float vTrueWidth;
varying vec2 vGround;

uniform sampler2D uExposure;
uniform sampler2D uSvf;
uniform vec2 uExtent;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uTone[10];
uniform float uCentreline[10];
uniform float uEdgeline[10];
uniform float uMetresPerPx;
${REVEAL_GLSL}

float hash(vec2 p) { return fract(sin(dot(p, vec2(37.1, 61.7))) * 24634.6345); }

void main() {
  int ci = int(vClass + 0.5);
  vec3 col = uTone[ci];

  float a = abs(vAcross);
  float halfW = max(vWidth, 0.5) * 0.5;
  float d = a * halfW;                     // metres from the centreline

  // Asphalt, with a little aggregate in it. A perfectly flat tone reads as a drawn
  // line; the grain is what makes it read as a surface the line is painted on.
  col *= 0.93 + 0.14 * hash(floor(vGround * 1.9));

  // kerb: darken the outer edge so the carriageway has a boundary
  col *= 1.0 - 0.38 * smoothstep(0.80, 1.0, a);

  // --- road markings ---------------------------------------------------------
  // Half-width of a painted stripe. Real lane markings are 100-150 mm; the old
  // centre line was 1.6 m wide, so on a 6 m street a quarter of the carriageway was
  // paint and the road read as a white line rather than as a road with a line on it.
  // Floored at half a pixel so a correct 0.12 m stripe does not simply alias away
  // when the camera pulls back -- but never more than a sliver of the carriageway
  // either, because that floor alone would paint a 5.5 m stripe at the zoom that
  // fits Narhe to Swargate and turn every road solid white. That is the same
  // failure this is here to fix, just at the other end of the zoom range.
  float paint = min(max(0.07, 0.55 * uMetresPerPx), halfW * 0.15);
  float stripe0 = paint * 0.6;
  float stripe1 = paint * 1.5;

  // 3 m painted, 6 m gap -- the standard broken-line cycle.
  float dashOn = step(fract(vAlong / 9.0), 0.34);

  // Edge lines: continuous, set in from each kerb by a fraction of the width so a
  // narrow street does not end up with both lines meeting in the middle.
  float inset = min(0.55, halfW * 0.16);
  float edge = 1.0 - smoothstep(stripe0, stripe1, abs(halfW - inset - d));

  // Centre line: dashed, between opposing flows.
  float centre = (1.0 - smoothstep(stripe0, stripe1, d)) * dashOn;

  // Lane dividers, only where the real carriageway is wide enough to have lanes.
  float lanes = floor(vTrueWidth / 3.25 + 0.5);
  float lane = 0.0;
  if (lanes >= 4.0) {
    float laneW = halfW * 2.0 / lanes;
    float m = mod(d, laneW);
    float off = min(m, laneW - m);
    lane = (1.0 - smoothstep(stripe0, stripe1, off)) * dashOn
         * step(laneW * 0.5, d)                      // not over the centre line
         * step(d, halfW - inset - stripe1 * 2.0);   // not over the edge line
  }

  float mark = clamp(centre * uCentreline[ci]
                   + (edge + lane) * uEdgeline[ci], 0.0, 1.0);
  // Worn white, not pure white: fresh paint at full value blows out against asphalt
  // this dark and the markings stop reading as part of the surface.
  col = mix(col, vec3(0.86, 0.85, 0.80), mark * 0.82);

  // lighting from the same field the ground and buildings use
  vec2 uv = clamp(vGround / uExtent, 0.0, 1.0);
  float svf = texture2D(uSvf, uv).r;
  float shadow = texture2D(uExposure, uv).g;
  float ambient = mix(0.34, 0.62, pow(clamp(svf, 0.0, 1.0), 1.5));
  float direct = uSunIntensity * (1.0 - 0.8 * shadow);
  col *= ambient + 0.55 * direct * 0.35;
  col = mix(col, col * 0.78 + vec3(0.036, 0.031, 0.025), shadow * 0.6);

  // Outside the revealed corridor this geometry is not drawn at all. Dimming it
  // instead (which is what the old 0.05 multiplier did) still rasterises opaque
  // black over the basemap, so undiscovered ground came out as a dark silhouette
  // of the city rather than as undiscovered ground. revealAt() returns 1.0 when
  // reveal is switched off, so the whole-zone view is untouched by this.
  float rv = revealAt(uv);
  if (rv < 0.15) discard;
  col *= mix(0.55, 1.0, rv);

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
    lift: LiftUniforms,
    junctions: [number, number, number][] = [],
  ) {
    // Two passes into preallocated typed arrays, same reason as buildings.ts: over
    // 42 km2 there are ~8,500 ways, and plain number[] pushes do not scale.
    //
    // Round caps are only emitted at bends that actually need one. Most OSM polyline
    // vertices are all but straight, and a cap costs 18 vertices, so capping every
    // vertex was by far the dominant vertex cost for no visible difference.
    const CAP_SEGMENTS = 6;
    const CAP_MIN_TURN = Math.cos((18 * Math.PI) / 180); // cap only past ~18 deg

    interface Prepared {
      pts: THREE.Vector2[];
      k: number;
      w: number;
      caps: boolean[];
    }
    const prepared: Prepared[] = [];
    let vertexCount = 0;

    for (const f of features) {
      const p = f.properties;
      const pts = f.geometry.coordinates.map((c) => {
        const [x, y] = fields.origin.toXY(c[1], c[0]);
        return new THREE.Vector2(x, y);
      });
      if (pts.length < 2) continue;
      const k = CLASS_INDEX[p.highway] ?? 4;
      const w = Math.max(2, p.width_m);

      const caps: boolean[] = new Array(pts.length).fill(false);
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const c = pts[i + 1];
        const v1x = b.x - a.x, v1y = b.y - a.y;
        const v2x = c.x - b.x, v2y = c.y - b.y;
        const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
        if (l1 < 1e-4 || l2 < 1e-4) continue;
        const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
        if (dot < CAP_MIN_TURN) caps[i] = true;
      }

      prepared.push({ pts, k, w, caps });
      vertexCount += (pts.length - 1) * 6 + caps.filter(Boolean).length * CAP_SEGMENTS * 3;
    }

    // A disc at every node where ways actually meet. OSM splits ways at
    // intersections, so two streets crossing are four separate ribbons whose ends
    // stop at the node -- leaving an unfilled wedge on the outside of every turn and
    // a square notch wherever a narrow street T-joins a wide one. The network read
    // as loose ribbons rather than as a connected street grid. Filling the node with
    // a disc the width of its widest incident road merges all of them, which is the
    // same trick the bend caps above already use, applied where ways meet instead of
    // where one way bends.
    const JUNCTION_SEGMENTS = 8;
    vertexCount += junctions.length * JUNCTION_SEGMENTS * 3;

    const pos = new Float32Array(vertexCount * 3);
    const off = new Float32Array(vertexCount * 2);
    const along = new Float32Array(vertexCount);
    const across = new Float32Array(vertexCount);
    const cls = new Float32Array(vertexCount);
    const wid = new Float32Array(vertexCount);
    let v = 0;

    // (cx, cy) is the centreline; (ox, oy) is the unit direction out to the kerb.
    const push = (cx: number, cy: number, ox: number, oy: number,
                  s: number, t: number, k: number, w: number) => {
      pos[v * 3] = cx; pos[v * 3 + 1] = cy; pos[v * 3 + 2] = ROAD_Z;
      off[v * 2] = ox; off[v * 2 + 1] = oy;
      along[v] = s; across[v] = t; cls[v] = k; wid[v] = w;
      v++;
    };

    for (const road of prepared) {
      const { pts, k, w, caps } = road;
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

        push(a.x, a.y, nx, ny, s0, 1, k, w);
        push(a.x, a.y, -nx, -ny, s0, -1, k, w);
        push(b.x, b.y, -nx, -ny, s1, -1, k, w);
        push(a.x, a.y, nx, ny, s0, 1, k, w);
        push(b.x, b.y, -nx, -ny, s1, -1, k, w);
        push(b.x, b.y, nx, ny, s1, 1, k, w);

        // A round cap fills the wedge two straight ribbons leave at a real bend.
        // Cheaper and far more robust than mitring, which blows up at the
        // near-180-degree turns OSM geometry contains.
        if (caps[i]) {
          for (let j = 0; j < CAP_SEGMENTS; j++) {
            const t0 = (j / CAP_SEGMENTS) * Math.PI * 2;
            const t1 = ((j + 1) / CAP_SEGMENTS) * Math.PI * 2;
            push(a.x, a.y, 0, 0, s0, 0, k, w);
            push(a.x, a.y, Math.cos(t0), Math.sin(t0), s0, 0.9, k, w);
            push(a.x, a.y, Math.cos(t1), Math.sin(t1), s0, 0.9, k, w);
          }
        }
      }
    }

    for (const [lon, lat, rM] of junctions) {
      const [jx, jy] = fields.origin.toXY(lat, lon);
      // aWidth carries the diameter so the shader's minimum-width rule widens the
      // junction in step with the streets feeding it; otherwise zooming out left a
      // pinhole where four widened ribbons met.
      const w = rM * 2;
      for (let j = 0; j < JUNCTION_SEGMENTS; j++) {
        const t0 = (j / JUNCTION_SEGMENTS) * Math.PI * 2;
        const t1 = ((j + 1) / JUNCTION_SEGMENTS) * Math.PI * 2;
        // aAcross 0 at the centre keeps the kerb shading off the junction face, and
        // aAlong 0 keeps the dashed centre line from painting across it.
        push(jx, jy, 0, 0, 0, 0, JUNCTION_CLASS, w);
        push(jx, jy, Math.cos(t0), Math.sin(t0), 0, 0.72, JUNCTION_CLASS, w);
        push(jx, jy, Math.cos(t1), Math.sin(t1), 0, 0.72, JUNCTION_CLASS, w);
      }
    }

    const used = v;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, used * 3), 3));
    geo.setAttribute("aAlong", new THREE.BufferAttribute(along.subarray(0, used), 1));
    geo.setAttribute("aAcross", new THREE.BufferAttribute(across.subarray(0, used), 1));
    geo.setAttribute("aClass", new THREE.BufferAttribute(cls.subarray(0, used), 1));
    geo.setAttribute("aWidth", new THREE.BufferAttribute(wid.subarray(0, used), 1));
    geo.setAttribute("aOffset", new THREE.BufferAttribute(off.subarray(0, used * 2), 2));
    geo.computeBoundingSphere();

    const tones: THREE.Color[] = [];
    for (let i = 0; i < TONE_SLOTS; i++) {
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
        uEdgeline: { value: HAS_EDGELINE },
        uMetresPerPx: { value: 0.3 },
        uReveal: { value: reveal },
        uRevealOn: { value: 0 },
        uMinWidthM: { value: 0 },
        ...lift,
      },
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = 0; // under GroundHeat, so the heat tints the carriageway
    this.triangles = used / 3;
  }

  /**
   * Hold minor streets at a readable width as the camera pulls back.
   *
   * Capped, because past a point every service lane widening further turns the city
   * into a solid grey mat and hides the hierarchy the tones are there to show.
   */
  setPixelScale(metresPerPixel: number) {
    this.material.uniforms.uMinWidthM.value = Math.min(
      MAX_MIN_WIDTH_M, MIN_ROAD_PX * metresPerPixel,
    );
    // The markings need this too: a 120 mm stripe is a hundredth of a pixel from
    // across the city, so the shader widens it to stay visible rather than letting
    // it flicker in and out between frames.
    this.material.uniforms.uMetresPerPx.value = metresPerPixel;
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
