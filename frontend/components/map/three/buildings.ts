"use client";

import * as THREE from "three";
import type { BuildingProps, Typology } from "@/lib/api";
import type { TwinFields } from "./fields";
import { REVEAL_GLSL } from "./reveal";

/**
 * Every footprint in the zone as ONE merged BufferGeometry, with the facade
 * synthesised in the fragment shader rather than built as geometry.
 *
 * Footprints are irregular, so InstancedMesh (one shared geometry reused) does not
 * apply; merging gives the same single draw call. Windows, mullions, spandrels,
 * entrances and parapets are derived from the wall UVs (u = metres along the wall,
 * v = metres up) plus a stable per-building seed, so 998 buildings vary continuously
 * without adding a single triangle and look identical on every reload.
 *
 * Lighting is driven by the same GPU sun-exposure field the ground uses, so a wall
 * standing in another building's shadow darkens in step with the street at its foot.
 */

const TYPOLOGY_INDEX: Record<Typology, number> = {
  academic: 0,
  campus_support: 1,
  commercial: 2,
  industrial: 3,
  apartments: 4,
  residential: 5,
  house: 6,
  shed: 7,
  temple: 8,
};

// Per typology, in typology-index order.
const FLOOR_H = [4.2, 3.4, 4.0, 5.5, 3.1, 3.1, 3.0, 3.6, 4.0];
const WIN_PITCH = [3.4, 2.8, 4.2, 6.0, 2.6, 2.6, 2.4, 3.0, 3.2];
const GLAZING = [0.62, 0.46, 0.74, 0.28, 0.44, 0.4, 0.36, 0.2, 0.3];
const TINT: [number, number, number][] = [
  [0.78, 0.76, 0.72], // academic
  [0.72, 0.7, 0.66], // campus_support
  [0.7, 0.69, 0.66], // commercial
  [0.62, 0.61, 0.58], // industrial
  [0.66, 0.63, 0.6], // apartments
  [0.62, 0.59, 0.55], // residential
  [0.64, 0.6, 0.56], // house
  [0.55, 0.53, 0.5], // shed
  [0.72, 0.62, 0.52], // temple
];

const VERT = `
attribute vec2 aFacade;     // u = metres along the wall, v = metres above ground
attribute float aSeed;
attribute float aType;
attribute float aHeight;
attribute float aRoof;      // 1 on roof caps

varying vec2 vFacade;
varying float vSeed;
varying float vType;
varying float vHeight;
varying float vRoof;
varying vec3 vNormal;
varying vec2 vGround;       // local metres, for sampling the field textures

uniform float uGrow;

void main() {
  vFacade = vec2(aFacade.x, aFacade.y * uGrow);
  vSeed = aSeed;
  vType = aType;
  vHeight = aHeight * uGrow;
  vRoof = aRoof;
  vNormal = normalize(normalMatrix * normal);

  vec3 p = position;
  p.z *= uGrow;
  vGround = p.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = `
precision highp float;

varying vec2 vFacade;
varying float vSeed;
varying float vType;
varying float vHeight;
varying float vRoof;
varying vec3 vNormal;
varying vec2 vGround;

uniform sampler2D uExposure;
uniform sampler2D uSvf;
uniform vec2 uExtent;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uNight;

uniform float uFloorH[9];
uniform float uWinPitch[9];
uniform float uGlazing[9];
uniform vec3 uTint[9];
${REVEAL_GLSL}

float hash(float n) { return fract(sin(n * 43758.5453) * 12345.6789); }

void main() {
  int ti = int(vType + 0.5);
  float floorH = uFloorH[ti];
  float pitch = uWinPitch[ti];
  float glaze = uGlazing[ti];
  vec3 tint = uTint[ti];

  // Per-building variation, stable because the seed is derived from the OSM id.
  float r1 = hash(vSeed);
  float r2 = hash(vSeed + 17.0);
  float r3 = hash(vSeed + 91.0);
  floorH *= 0.92 + 0.16 * r1;
  pitch *= 0.90 + 0.20 * r2;
  tint *= 0.86 + 0.26 * r3;

  vec3 albedo = tint;
  float glassMask = 0.0;

  if (vRoof < 0.5) {
    float groundTop = floorH * 1.25;
    float parapetBase = max(vHeight - 0.9, 0.0);

    float fy = fract(vFacade.y / floorH);
    float fx = fract(vFacade.x / pitch);
    float halfWin = glaze * 0.5;

    float inWinX = step(0.5 - halfWin, fx) * step(fx, 0.5 + halfWin);
    float inWinY = step(0.30, fy) * step(fy, 0.82);
    float win = inWinX * inWinY;

    // Ground storey: wider openings for entrances and shopfronts.
    float gy = vFacade.y / groundTop;
    float gInX = step(0.5 - halfWin * 1.35, fx) * step(fx, 0.5 + halfWin * 1.35);
    float gWin = gInX * step(0.18, gy) * step(gy, 0.86);
    float isGround = step(vFacade.y, groundTop);
    win = mix(win, gWin, isGround);

    // No glazing in the parapet band.
    win *= step(vFacade.y, parapetBase);

    float frameX = smoothstep(0.0, 0.035, abs(fx - 0.5) - halfWin + 0.035);
    float frame = win * (1.0 - frameX);

    vec3 glass = vec3(0.088, 0.082, 0.072);
    albedo = mix(albedo, glass, win * 0.92);
    albedo = mix(albedo, vec3(0.02), frame * 0.5);
    glassMask = win;

    float slab = 1.0 - smoothstep(0.0, 0.045, min(fy, 1.0 - fy));
    albedo *= 1.0 - 0.22 * slab * (1.0 - isGround);
    albedo = mix(albedo, tint * 1.18, step(parapetBase, vFacade.y));
  } else {
    albedo = tint * 0.82;
    float eq = step(0.76, hash(vSeed + floor(vGround.x * 0.12) + floor(vGround.y * 0.12)));
    albedo = mix(albedo, vec3(0.30, 0.31, 0.33), eq * 0.5);
  }

  // ---- lighting -------------------------------------------------------------
  vec2 uv = clamp(vGround / uExtent, 0.0, 1.0);
  float svf = texture2D(uSvf, uv).r;
  float groundShadow = texture2D(uExposure, uv).g;

  float ndl = max(dot(normalize(vNormal), uSunDir), 0.0);
  float wallOccl = groundShadow * (1.0 - smoothstep(0.0, 18.0, vFacade.y));
  float occl = mix(wallOccl, groundShadow, vRoof);
  float direct = ndl * uSunIntensity * (1.0 - 0.85 * occl);

  float ambient = mix(0.22, 0.52, pow(clamp(svf, 0.0, 1.0), 1.6));
  vec3 skyTint = mix(vec3(0.25, 0.24, 0.22), vec3(0.57, 0.55, 0.51), ambient);

  vec3 col = albedo * (skyTint * ambient + uSunColor * direct);

  float spec = pow(ndl, 24.0) * glassMask * uSunIntensity;
  col += uSunColor * spec * 0.55;

  float litSeed = hash(vSeed + floor(vFacade.y / 3.0) * 7.0 + floor(vFacade.x / 3.0));
  float lit = step(0.5, uNight) * glassMask * step(0.42, litSeed);
  col += vec3(1.0, 0.82, 0.52) * lit * 0.5;

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

/** GeoJSON ring (lon/lat, closed) -> local metres, wound counter-clockwise. */
function ringToXY(
  coords: GeoJSON.Position[],
  toXY: (lat: number, lon: number) => [number, number],
): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (const c of coords) {
    const [x, y] = toXY(c[1], c[0]);
    pts.push(new THREE.Vector2(x, y));
  }
  if (pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-6) pts.pop();
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  if (area < 0) pts.reverse();
  return pts;
}

export class Buildings {
  readonly mesh: THREE.Mesh;
  readonly triangles: number;
  private readonly material: THREE.ShaderMaterial;

  constructor(
    features: GeoJSON.Feature<GeoJSON.Polygon, BuildingProps>[],
    fields: TwinFields,
    exposure: THREE.Texture,
    reveal: THREE.Texture,
  ) {
    // Two passes, into preallocated typed arrays.
    //
    // The first version pushed into plain number[] and was fine for 998 footprints.
    // Over 42 km2 of south Pune there are ~31,000, which is several million pushes
    // across seven attributes — slow, and it briefly holds the whole thing as boxed
    // JS numbers before the Float32Array copy. Rings are projected once, reused, and
    // the exact vertex count is known before a single float is written.
    const rings: { ring: THREE.Vector2[]; h: number; t: number; s: number; tris: number[][] }[] = [];
    let vertexCount = 0;

    for (const f of features) {
      const p = f.properties;
      const ring = ringToXY(f.geometry.coordinates[0], (la, lo) => fields.origin.toXY(la, lo));
      if (ring.length < 3) continue;
      let tris: number[][] = [];
      try {
        tris = THREE.ShapeUtils.triangulateShape(ring, []);
      } catch {
        // Self-intersecting OSM ring: the walls alone still read correctly.
      }
      rings.push({
        ring,
        h: Math.max(2, p.height_m),
        t: TYPOLOGY_INDEX[p.typology] ?? 5,
        s: p.seed ?? 0,
        tris,
      });
      vertexCount += ring.length * 6 + tris.length * 3;
    }

    const pos = new Float32Array(vertexCount * 3);
    const nrm = new Float32Array(vertexCount * 3);
    const facade = new Float32Array(vertexCount * 2);
    const seed = new Float32Array(vertexCount);
    const type = new Float32Array(vertexCount);
    const hgt = new Float32Array(vertexCount);
    const roof = new Float32Array(vertexCount);
    let v = 0;

    const push = (
      x: number, y: number, z: number,
      nx: number, ny: number, nz: number,
      fu: number, fv: number,
      sd: number, ty: number, hh: number, isRoof: number,
    ) => {
      pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
      nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz;
      facade[v * 2] = fu; facade[v * 2 + 1] = fv;
      seed[v] = sd; type[v] = ty; hgt[v] = hh; roof[v] = isRoof;
      v++;
    };

    for (const b of rings) {
      const { ring, h, t, s: sd } = b;

      // ---- walls: one quad per footprint edge, UVs in metres ----
      let run = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const c = ring[(i + 1) % ring.length];
        const dx = c.x - a.x;
        const dy = c.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-4) continue;
        const nx = dy / len;
        const ny = -dx / len;
        const u0 = run;
        const u1 = run + len;
        run = u1;
        push(a.x, a.y, 0, nx, ny, 0, u0, 0, sd, t, h, 0);
        push(c.x, c.y, 0, nx, ny, 0, u1, 0, sd, t, h, 0);
        push(c.x, c.y, h, nx, ny, 0, u1, h, sd, t, h, 0);
        push(a.x, a.y, 0, nx, ny, 0, u0, 0, sd, t, h, 0);
        push(c.x, c.y, h, nx, ny, 0, u1, h, sd, t, h, 0);
        push(a.x, a.y, h, nx, ny, 0, u0, h, sd, t, h, 0);
      }

      // ---- roof cap ----
      for (const tri of b.tris) {
        for (const idx of tri) {
          const pt = ring[idx];
          push(pt.x, pt.y, h, 0, 0, 1, pt.x, h, sd, t, h, 1);
        }
      }
    }

    // Degenerate edges are skipped, so the filled count can be below the estimate.
    const used = v;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, used * 3), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm.subarray(0, used * 3), 3));
    geo.setAttribute("aFacade", new THREE.BufferAttribute(facade.subarray(0, used * 2), 2));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed.subarray(0, used), 1));
    geo.setAttribute("aType", new THREE.BufferAttribute(type.subarray(0, used), 1));
    geo.setAttribute("aHeight", new THREE.BufferAttribute(hgt.subarray(0, used), 1));
    geo.setAttribute("aRoof", new THREE.BufferAttribute(roof.subarray(0, used), 1));
    geo.computeBoundingSphere();

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uExposure: { value: exposure },
        uSvf: { value: fields.svf },
        uExtent: { value: new THREE.Vector2(fields.origin.widthM, fields.origin.heightM) },
        uSunDir: { value: new THREE.Vector3(0, 0, 1) },
        uSunColor: { value: new THREE.Color(1.0, 0.94, 0.86) },
        uSunIntensity: { value: 1 },
        uNight: { value: 0 },
        uGrow: { value: 1 },
        uFloorH: { value: FLOOR_H },
        uWinPitch: { value: WIN_PITCH },
        uGlazing: { value: GLAZING },
        uTint: { value: TINT.map((c) => new THREE.Color(c[0], c[1], c[2])) },
        uReveal: { value: reveal },
        uRevealOn: { value: 0 },
      },
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = 2;
    this.triangles = used / 3;
  }

  setSun(dir: THREE.Vector3, intensity: number, night: boolean, color: THREE.Color) {
    const u = this.material.uniforms;
    u.uSunDir.value.copy(dir);
    u.uSunIntensity.value = intensity;
    u.uNight.value = night ? 1 : 0;
    u.uSunColor.value.copy(color);
  }

  setGrow(g: number) {
    this.material.uniforms.uGrow.value = g;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
