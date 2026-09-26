"use client";

import * as THREE from "three";
import { makeFrameTexture, makeLutTexture, uploadFrame, type TwinFields } from "./fields";
import { LIFT_GLSL, type LiftUniforms } from "./lift";
import { REVEAL_GLSL } from "./reveal";

/**
 * The pedestrian heat surface, drawn as one shader-textured ground plane.
 *
 * Replaces the previous pipeline of 13 canvas -> PNG data-URL -> MapLibre image
 * sources, which encoded ~635k pixels per keyframe on the main thread and then
 * cross-faded the *rendered colours* of two keyframes.
 *
 * Cross-fading colours is wrong: the scale runs blue -> teal -> green -> yellow ->
 * orange -> red, so alpha-blending the teal of "now" with the orange of "+1h" lands
 * on a muddy olive that corresponds to no temperature on the scale at all. Here the
 * two keyframes are mixed in ENCODED TEMPERATURE space (the uint8 encoding is linear
 * in degrees: feels_c = 20 + v/4) and the colour ramp is applied afterwards, so an
 * intermediate time reads as the temperature it actually is.
 *
 * Also layered in, all from fields the physics already produced:
 *   - isotherm contours, so the field reads as an instrument rather than a smear
 *   - ambient occlusion from the sky view factor
 *   - shadow tint from the live GPU sun-exposure pass
 */
const VERT = `
varying vec2 vUv;
${LIFT_GLSL}
void main() {
  vUv = uv;
  // The heat plane has to ride the terrain like everything standing on it.
  //
  // It did not, and it was the one layer that did not: roads, landcover, canopy and
  // buildings all rose with the ground while the coloured surface stayed on the
  // basemap. On a hillside that puts the heat field tens of metres BELOW the street
  // it is describing, so zooming in showed the dark basemap through the gap and the
  // ground read as half transparent.
  vec3 p = position;
  p.z += liftAt(clamp(uv, 0.0, 1.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uHeatA;
uniform sampler2D uHeatB;
uniform sampler2D uLut;
uniform sampler2D uExposure;
uniform sampler2D uSvf;
uniform sampler2D uRoad;
uniform float uBlend;        // 0..1 between keyframe A and B
uniform float uOpacity;
uniform float uHasB;
uniform vec2  uGrid;         // (cols, rows)
uniform float uFeatherCells;
uniform float uIsoStep;      // degrees C between contour lines
uniform float uIsoStrength;
uniform float uAoStrength;
uniform float uShadeStrength;
${REVEAL_GLSL}

void main() {
  // --- temperature first, colour second -------------------------------------
  float a = texture2D(uHeatA, vUv).r;
  float b = texture2D(uHeatB, vUv).r;
  float v = mix(a, mix(a, b, uBlend), uHasB);

  vec3 col = texture2D(uLut, vec2(v, 0.5)).rgb;
  float celsius = 20.0 + v * 255.0 / 4.0;

  // --- isotherms ------------------------------------------------------------
  float s = celsius / uIsoStep;
  float w = max(fwidth(s), 1e-5);
  float d = 0.5 - abs(fract(s) - 0.5);   // 0 exactly on a contour, 0.5 midway between
  float iso = 1.0 - smoothstep(0.0, w * 1.5, d);
  iso *= smoothstep(1.2, 0.35, w);       // drop the lines out when they would alias
  col = mix(col, col * 0.55 + vec3(0.04), iso * uIsoStrength);

  // --- shading: sky view factor (ambient) + live sun exposure (direct) -------
  // Softer curve than the original 2.5: that power darkened partially-enclosed
  // ground hard enough to muddy the heat colour itself, which is the one thing on
  // this plane that must always read cleanly.
  float svf = texture2D(uSvf, vUv).r;
  float ao = mix(1.0, pow(clamp(svf, 0.0, 1.0), 1.6), uAoStrength);
  col *= ao;

  float shadow = texture2D(uExposure, vUv).g;
  col = mix(col, col * 0.82 + vec3(0.050, 0.044, 0.036), shadow * uShadeStrength);

  // --- soft boundary so the twin does not end in a hard rectangle -----------
  vec2 cell = vUv * uGrid;
  float edge = min(min(cell.x, uGrid.x - cell.x), min(cell.y, uGrid.y - cell.y));
  float alpha = uOpacity * pow(clamp(edge / uFeatherCells, 0.0, 1.0), 1.5);
  alpha *= revealAt(vUv);   // undiscovered ground carries no heat surface

  // Let more of the road ribbon's own colour and lane markings read through on
  // carriageways, so the street network stays legible under the heat tint instead
  // of being flattened to the same colour as the open ground around it. The heat
  // value at that cell is still shown — just proportionally less totalising there.
  float roadMask = texture2D(uRoad, vUv).r;
  alpha *= mix(1.0, 0.6, roadMask);

  gl_FragColor = vec4(col * alpha, alpha); // premultiplied, matches MapLibre's blend
}`;

export class GroundHeat {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly texA: THREE.DataTexture;
  private readonly texB: THREE.DataTexture;
  private keyA = "";
  private keyB = "";

  /** The live heat keyframes, so the terrain lift can read the same two textures
   *  this plane is colouring from. Shared by reference on purpose: a second copy
   *  could fall a frame behind and tear the relief away from the colour on it. */
  get heatTextures(): { a: THREE.DataTexture; b: THREE.DataTexture } {
    return { a: this.texA, b: this.texB };
  }

  /** Current keyframe blend state, mirrored onto the lift uniforms. */
  get blendState(): { blend: number; hasB: number } {
    const u = this.material.uniforms;
    return { blend: u.uBlend.value as number, hasB: u.uHasB.value as number };
  }

  setVisible(on: boolean) {
    this.mesh.visible = on;
  }

  constructor(private readonly fields: TwinFields, exposure: THREE.Texture, reveal: THREE.Texture,
              lift: LiftUniforms) {
    this.texA = makeFrameTexture(fields.cols, fields.rows);
    this.texB = makeFrameTexture(fields.cols, fields.rows);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uHeatA: { value: this.texA },
        uHeatB: { value: this.texB },
        uLut: { value: makeLutTexture() },
        uExposure: { value: exposure },
        uSvf: { value: fields.svf },
        uRoad: { value: fields.road },
        uBlend: { value: 0 },
        uOpacity: { value: 0.58 },
        uHasB: { value: 0 },
        uGrid: { value: new THREE.Vector2(fields.cols, fields.rows) },
        uFeatherCells: { value: 8 },
        uIsoStep: { value: 2 },
        uIsoStrength: { value: 0.35 },
        uAoStrength: { value: 0.75 },
        uShadeStrength: { value: 0.8 },
        uReveal: { value: reveal },
        uRevealOn: { value: 0 },
        ...lift,
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });

    const { widthM, heightM } = fields.origin;
    // Subdivided, because a displaced surface can only follow ground it has vertices
    // on: as two triangles this plane could tilt but never take the shape of a hill.
    // One quad per 4 physics cells matches the vulnerability relief and costs ~23k
    // vertices over the whole zone, which is nothing beside the building mesh.
    const segX = Math.max(1, Math.round(fields.cols / 4));
    const segY = Math.max(1, Math.round(fields.rows / 4));
    const geo = new THREE.PlaneGeometry(widthM, heightM, segX, segY);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.set(widthM / 2, heightM / 2, 0.05); // just clear of the basemap
    this.mesh.renderOrder = 1;
  }

  /** Point the two samplers at the keyframes bracketing the timeline position. */
  setKeyframes(
    a: { key: string; heat: Uint8Array } | null,
    b: { key: string; heat: Uint8Array } | null,
    blend: number,
  ) {
    const { rows, cols } = this.fields;
    if (a && a.key !== this.keyA) {
      uploadFrame(this.texA, a.heat, rows, cols);
      this.keyA = a.key;
    }
    if (b && b.key !== this.keyB) {
      uploadFrame(this.texB, b.heat, rows, cols);
      this.keyB = b.key;
    }
    this.material.uniforms.uHasB.value = b && a && b.key !== a.key ? 1 : 0;
    this.material.uniforms.uBlend.value = blend;
  }

  setStyle(opts: { opacity?: number; isotherms?: boolean; ao?: number; shade?: number }) {
    const u = this.material.uniforms;
    if (opts.opacity !== undefined) u.uOpacity.value = opts.opacity;
    if (opts.isotherms !== undefined) u.uIsoStrength.value = opts.isotherms ? 0.35 : 0;
    if (opts.ao !== undefined) u.uAoStrength.value = opts.ao;
    if (opts.shade !== undefined) u.uShadeStrength.value = opts.shade;
  }

  get ready() {
    return this.keyA !== "";
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.uniforms.uLut.value.dispose();
    this.material.dispose();
    this.texA.dispose();
    this.texB.dispose();
  }
}
