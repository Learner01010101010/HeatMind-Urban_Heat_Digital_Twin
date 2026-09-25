"use client";

import * as THREE from "three";
import type { TwinFields } from "./fields";
import { LIFT_GLSL, type LiftUniforms } from "./lift";
import { REVEAL_GLSL } from "./reveal";

/**
 * The ground itself: grass where there is grass, dry earth where there is not.
 *
 * The twin already carried a surface-class raster — it is what gives each cell its
 * solar gain in the physics — but nothing ever drew it, so every square metre that
 * was not a building, a road or a tree rendered as the same anonymous brown. A park
 * and a quarry looked identical.
 *
 * The classes come from ESA WorldCover at 10 m, overridden by OSM polygons, roads
 * and building footprints in services/zone.py, so this paints exactly the surface
 * the model is running its heat budget over. Nothing is placed for decoration: if
 * a patch reads as grass here, the cell under it is absorbing a grass surface's
 * share of the sun.
 *
 * Drawn below the roads and the heat plane, both of which are opaque or tinted over
 * it, so this only shows where nothing more specific covers it.
 */

const LANDCOVER_Z = 0.01;

/** Per surface class, matching SURFACES in services/zone.py by index. */
const CLASS_COLOR = [
  0.32, 0.27, 0.19, // 0 bare — dry open ground
  0.20, 0.19, 0.19, // 1 asphalt
  0.31, 0.30, 0.29, // 2 concrete
  0.34, 0.32, 0.29, // 3 paving
  0.23, 0.36, 0.17, // 4 grass
  0.10, 0.20, 0.28, // 5 water
  0.30, 0.26, 0.23, // 6 roof
  0.31, 0.26, 0.20, // 7 dirt / gravel
];
const GRASS_CLASS = 4;
const WATER_CLASS = 5;

const VERT = `
varying vec2 vUv;
varying vec2 vGround;
uniform vec2 uExtent;
${LIFT_GLSL}

void main() {
  vUv = uv;
  vec3 p = position;
  vGround = p.xy;
  p.z += liftAt(clamp(vGround / uExtent, 0.0, 1.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = `
precision highp float;

varying vec2 vUv;
varying vec2 vGround;

uniform sampler2D uSurface;   // class code / 255
uniform sampler2D uExposure;
uniform sampler2D uSvf;
uniform vec2 uExtent;
uniform vec3 uColor[8];
uniform float uSunIntensity;
${REVEAL_GLSL}

float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }

void main() {
  vec2 uv = clamp(vUv, 0.0, 1.0);
  float rv = revealAt(uv);
  if (rv < 0.15) discard;

  // The class texture has to be sampled nearest -- interpolating between class 4
  // (grass) and class 6 (roof) would land on class 5, which is water, and put lakes
  // along every lawn's edge. Nearest at 10 m draws a hard pixel grid instead, so the
  // lookup point is jittered by well under a cell: the boundary breaks up into
  // something organic without any sample ever landing on a class that is not there.
  vec2 jitter = (vec2(hash(floor(vGround * 1.7)), hash(floor(vGround * 1.7) + 19.0)) - 0.5)
              * (4.5 / uExtent);
  int ci = int(texture2D(uSurface, clamp(uv + jitter, 0.0, 1.0)).r * 255.0 + 0.5);
  vec3 col = uColor[0];
  for (int i = 0; i < 8; i++) {
    if (i == ci) col = uColor[i];
  }

  // A little texture, so a field does not read as a flat swatch of colour. Driven
  // by ground position rather than uv, so it does not swim when the camera moves,
  // and kept small enough that it never competes with the heat tint above.
  float g = hash(floor(vGround * 0.5));
  col *= 0.90 + 0.20 * g;
  if (ci == ${GRASS_CLASS}) {
    // Grass gets a second, coarser variation: real turf is patchy, and an even
    // green over a whole park is the one thing that reads as fake.
    col *= 0.88 + 0.26 * hash(floor(vGround * 0.11) + 7.0);
  }

  // Held back in chroma on purpose. The heat plane above is 58% opaque, so whatever
  // hue the ground carries shows through at 42% and competes with the temperature
  // ramp -- and the temperature is what this product is for. At full saturation the
  // grass won: a 41 C street read green. Desaturated, the classes are still plainly
  // different from each other while the hue on screen stays the heat's to set.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 0.52) * 0.88;

  float svf = texture2D(uSvf, uv).r;
  float shadow = texture2D(uExposure, uv).g;
  float ambient = mix(0.36, 0.66, pow(clamp(svf, 0.0, 1.0), 1.4));
  float direct = uSunIntensity * (1.0 - 0.8 * shadow);
  col *= ambient + 0.5 * direct * 0.4;

  // Water keeps a touch of specular so a lake does not read as blue paint.
  if (ci == ${WATER_CLASS}) col += vec3(0.05, 0.08, 0.10) * direct;

  gl_FragColor = vec4(col * mix(0.55, 1.0, rv), 1.0);
}`;

export class Landcover {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(
    fields: TwinFields,
    exposure: THREE.Texture,
    reveal: THREE.Texture,
    lift: LiftUniforms,
  ) {
    const w = fields.cols * fields.cellM;
    const h = fields.rows * fields.cellM;
    // Enough segments that the terrain lift bends the ground smoothly; the colour
    // itself comes from a texture, so this does not need to match the grid.
    const geo = new THREE.PlaneGeometry(w, h, Math.ceil(fields.cols / 6), Math.ceil(fields.rows / 6));
    geo.translate(w / 2, h / 2, LANDCOVER_Z);

    const colors: THREE.Color[] = [];
    for (let i = 0; i < 8; i++) {
      colors.push(new THREE.Color(CLASS_COLOR[i * 3], CLASS_COLOR[i * 3 + 1], CLASS_COLOR[i * 3 + 2]));
    }

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uSurface: { value: fields.surface },
        uExposure: { value: exposure },
        uSvf: { value: fields.svf },
        uExtent: { value: new THREE.Vector2(w, h) },
        uColor: { value: colors },
        uSunIntensity: { value: 1 },
        uReveal: { value: reveal },
        uRevealOn: { value: 0 },
        ...lift,
      },
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = -1; // under the roads, which are under the heat plane
  }

  /**
   * Only shown in the twin.
   *
   * On the 2D map the Esri basemap is the ground, and painting over it with class
   * colours replaced real aerial imagery with a swatch chart. In the twin there is
   * no basemap under the scene, so this is the ground.
   */
  setVisible(on: boolean) {
    this.mesh.visible = on;
  }

  setSun(intensity: number) {
    this.material.uniforms.uSunIntensity.value = intensity;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
