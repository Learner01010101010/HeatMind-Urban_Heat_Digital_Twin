"use client";

import * as THREE from "three";
import type { TwinFields } from "./fields";
import { LIFT_GLSL, type LiftUniforms } from "./lift";

/**
 * The planned route, drawn on the street in the twin.
 *
 * MapLibre draws the route perfectly well as a line layer — on the flat map. It
 * cannot draw it on a hill. Those layers live on the basemap plane at z = 0, and
 * once the twin started standing the ground on real elevation the street under
 * Narhe rose 70 m while the route stayed on the floor: from a pitched camera the
 * line no longer sat on the road, and anywhere the ground rose in front of it the
 * hillside simply covered it up.
 *
 * So in the twin the route is geometry like everything else — a ribbon through the
 * same shared lift the roads use, riding the same terrain by construction rather
 * than by a constant that has to be kept in sync. The flat map keeps its line
 * layers; they are exactly right there, and they are hidden while the twin is up.
 *
 * Deliberately not subject to the corridor reveal. Every other layer fades in as you
 * approach it, because the twin only claims to know the ground it has drawn. The
 * route is the one thing you always need to see all of — it is the answer to the
 * question, not part of the scenery.
 */

/** Metres the ribbon floats above the carriageway. Enough to clear the road's own
 *  markings without reading as a line hovering over the street. */
const RIDE_M = 0.45;

/** Half-widths in metres: the chosen route, and the alternatives beside it. */
const W_SELECTED = 6.0;
const W_ALT = 3.4;

export interface RouteLineRecord {
  geometry: [number, number][];
  /** "#rrggbb" */
  color: string;
  selected: boolean;
}

const VERT = `
attribute vec2 aOffset;    // unit normal, scaled by half-width in the shader
attribute float aAcross;   // -1..1 across the ribbon
attribute float aWidth;    // half-width in metres
attribute vec3 aColor;
attribute float aSel;

varying float vAcross;
varying vec3 vColor;
varying float vSel;
varying vec2 vGround;

uniform vec2 uExtent;
uniform float uMinHalfWidthM;   // screen-space floor, same idea as the roads
${LIFT_GLSL}

void main() {
  vAcross = aAcross;
  vColor = aColor;
  vSel = aSel;

  // Widen at low zoom so a cross-city route stays a line rather than a thread, and
  // never let the alternates grow past the selected one.
  float w = max(aWidth, uMinHalfWidthM * (aSel > 0.5 ? 1.0 : 0.62));

  vec3 p = position;
  p.xy += aOffset * w;
  vGround = p.xy;
  p.z += liftAt(clamp(vGround / uExtent, 0.0, 1.0)) + ${RIDE_M.toFixed(2)};
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = `
precision highp float;

varying float vAcross;
varying vec3 vColor;
varying float vSel;
varying vec2 vGround;

void main() {
  float d = abs(vAcross);

  // A dark casing at the kerb edge, the route colour inside it, and a pale core down
  // the middle of the selected one. The casing is what makes a coloured line legible
  // over both a sunlit road and a shaded one without changing its colour.
  vec3 casing = vColor * 0.18;
  float edge = smoothstep(0.72, 0.96, d);
  vec3 col = mix(vColor, casing, edge);

  if (vSel > 0.5) {
    float core = 1.0 - smoothstep(0.10, 0.26, d);
    col = mix(col, mix(vColor, vec3(1.0), 0.78), core * 0.85);
  }

  // Feather the outer millimetre so the ribbon does not alias into a staircase on a
  // diagonal street.
  float a = (1.0 - smoothstep(0.94, 1.0, d)) * (vSel > 0.5 ? 1.0 : 0.72);
  if (a < 0.02) discard;
  gl_FragColor = vec4(col * a, a);
}`;

export class RouteLine {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private geo: THREE.BufferGeometry;

  constructor(private readonly fields: TwinFields, lift: LiftUniforms) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uExtent: { value: new THREE.Vector2(fields.origin.widthM, fields.origin.heightM) },
        uMinHalfWidthM: { value: W_SELECTED },
        ...lift,
      },
      transparent: true,
      // Premultiplied, matching every other transparent layer and MapLibre's blend.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthWrite: false,
      depthTest: true,
    });

    this.geo = new THREE.BufferGeometry();
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    // Above the roads and ground, below the pins and beacons that stand on it.
    this.mesh.renderOrder = 5;
  }

  /** Rebuild for the current comparison. Selected route last, so it draws on top. */
  set(records: RouteLineRecord[]) {
    const ordered = [...records].sort((a, b) => Number(a.selected) - Number(b.selected));
    let tris = 0;
    for (const r of ordered) tris += Math.max(0, r.geometry.length - 1) * 2 + Math.max(0, r.geometry.length - 2) * 6;
    if (!tris) {
      this.mesh.visible = false;
      return;
    }

    const cap = tris * 3;
    const pos = new Float32Array(cap * 3);
    const off = new Float32Array(cap * 2);
    const across = new Float32Array(cap);
    const wid = new Float32Array(cap);
    const col = new Float32Array(cap * 3);
    const sel = new Float32Array(cap);
    let v = 0;

    const push = (x: number, y: number, ox: number, oy: number, t: number, w: number,
                  c: THREE.Color, s: number) => {
      pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = 0;
      off[v * 2] = ox; off[v * 2 + 1] = oy;
      across[v] = t; wid[v] = w; sel[v] = s;
      col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
      v++;
    };

    const c = new THREE.Color();
    for (const rec of ordered) {
      c.set(rec.color);
      const w = rec.selected ? W_SELECTED : W_ALT;
      const s = rec.selected ? 1 : 0;
      const pts = rec.geometry.map(([lat, lon]) => {
        const [x, y] = this.fields.origin.toXY(lat, lon);
        return { x, y };
      });

      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-4) continue;
        const nx = -dy / len;
        const ny = dx / len;
        push(a.x, a.y, nx, ny, 1, w, c, s);
        push(a.x, a.y, -nx, -ny, -1, w, c, s);
        push(b.x, b.y, -nx, -ny, -1, w, c, s);
        push(a.x, a.y, nx, ny, 1, w, c, s);
        push(b.x, b.y, -nx, -ny, -1, w, c, s);
        push(b.x, b.y, nx, ny, 1, w, c, s);

        // Round join at the vertex ahead. A route turns through real street corners,
        // and two straight ribbons leave a wedge of bare road at every one of them.
        if (i < pts.length - 2) {
          const SEG = 6;
          for (let j = 0; j < SEG; j++) {
            const t0 = (j / SEG) * Math.PI * 2;
            const t1 = ((j + 1) / SEG) * Math.PI * 2;
            push(b.x, b.y, 0, 0, 0, w, c, s);
            push(b.x, b.y, Math.cos(t0), Math.sin(t0), 0.9, w, c, s);
            push(b.x, b.y, Math.cos(t1), Math.sin(t1), 0.9, w, c, s);
          }
        }
      }
    }

    this.geo.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
    g.setAttribute("aOffset", new THREE.BufferAttribute(off.subarray(0, v * 2), 2));
    g.setAttribute("aAcross", new THREE.BufferAttribute(across.subarray(0, v), 1));
    g.setAttribute("aWidth", new THREE.BufferAttribute(wid.subarray(0, v), 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(col.subarray(0, v * 3), 3));
    g.setAttribute("aSel", new THREE.BufferAttribute(sel.subarray(0, v), 1));
    this.geo = g;
    this.mesh.geometry = g;
    this.mesh.visible = true;
  }

  clear() {
    this.mesh.visible = false;
  }

  /** Hold the ribbon to a usable number of screen pixels as the camera pulls back. */
  setPixelScale(metresPerPixel: number) {
    this.material.uniforms.uMinHalfWidthM.value = Math.max(W_SELECTED, metresPerPixel * 2.6);
  }

  setVisible(on: boolean) {
    this.mesh.visible = on && this.geo.getAttribute("position") != null;
  }

  dispose() {
    this.geo.dispose();
    this.material.dispose();
  }
}
