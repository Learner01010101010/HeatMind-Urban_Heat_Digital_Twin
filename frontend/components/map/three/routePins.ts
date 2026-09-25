"use client";

import * as THREE from "three";
import type { TwinFields } from "./fields";
import { LIFT_GLSL, type LiftUniforms } from "./lift";
import { REVEAL_GLSL } from "./reveal";

/**
 * Temperature markers along a route — placed where the temperature actually changes.
 *
 * The first version put a pin down every 45 m, which on a cross-city route is a
 * picket fence: hundreds of markers, nearly all of them repeating the number their
 * neighbour already showed. A marker earns its place by telling you something new,
 * so the route is walked at a fine step and a pin is dropped only when the reading
 * has moved by THRESHOLD_C since the last one — plus both endpoints, and a failsafe
 * so a long thermally-flat stretch is not left completely unlabelled.
 *
 * What that gives you is a marker at the mouth of every shaded stretch and every
 * exposed one and nothing in between. Two hundred pins become a couple of dozen,
 * and each marks a transition worth knowing about.
 *
 * Each is a real marker: a tapered stem standing on the street with a screen-facing
 * plaque above it carrying the reading in degrees. The plaque is billboarded in view
 * space so it stays square to the camera at any pitch or bearing, and its background
 * is the heat colour, so a pin reads at a glance and reads exactly up close.
 */

/** How far apart to probe the route when deciding where a pin belongs. */
const PROBE_STEP_M = 12;
/** A new pin goes down once the reading has moved this far from the last one.
 *  Raised from 1.2: at that sensitivity an ordinary street's block-to-block noise
 *  was enough to trigger a marker, so the route filled up with pins recording
 *  differences too small to change anyone's mind about where to walk. */
const THRESHOLD_C = 2.4;
/** ...and one goes down anyway after this much unbroken sameness, so a long flat
 *  stretch still carries a reading rather than a gap. */
const MAX_GAP_M = 1100;
/** Never two pins closer than this, whatever the gradient does — roughly a block,
 *  so two markers cannot describe the same stretch of street. */
const MIN_GAP_M = 260;

/** Hard cap on markers, so a pathological route cannot allocate without bound. */
const MAX_PINS = 600;

// --- marker proportions, in metres at true scale --------------------------------
const STEM_H_M = 16.0;
const STEM_R_M = 0.85;
/**
 * The plaque is sized in SCREEN PIXELS, not metres.
 *
 * Sizing it in world units was exactly backwards for a label: it shrank as you
 * zoomed in to read it, bottoming out around 18 px wide — too small for "34°" at
 * the one moment you actually wanted the number. A label holds its size on screen;
 * the world size is derived from the camera each frame to make that happen.
 */
const HEAD_PX_W = 52;
const HEAD_PX_H = 29;

/** Metres per screen pixel at which markers are drawn at true world scale; past
 *  that they scale up so they stay legible instead of vanishing. */
const REF_M_PER_PX = 1.15;
const MAX_SCALE = 7.0;

// --- the label atlas -------------------------------------------------------------
const LABEL_MIN_C = 15;
const LABEL_MAX_C = 60;
const LABEL_ROWS = LABEL_MAX_C - LABEL_MIN_C + 1;
const LABEL_W = 192;
const LABEL_H = 96;

/**
 * One texture holding every whole-degree label the twin can show.
 *
 * Pre-rendered rather than drawn per marker: the set of possible readings is small
 * and fixed, so a single upload covers every pin on every route and the shader picks
 * its row by temperature. No per-pin canvas work, no DOM overlay to keep in sync with
 * a 3D camera, and the type stays crisp because it is rasterised text rather than
 * geometry.
 */
function makeLabelAtlas(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = LABEL_W;
  c.height = LABEL_H * LABEL_ROWS;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, c.width, c.height);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `700 ${Math.round(LABEL_H * 0.54)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  for (let i = 0; i < LABEL_ROWS; i++) {
    // Dark ink, not white: the plaque carries the heat colour, and at the hot end
    // that is saturated orange-red, on which white type all but disappears.
    g.fillStyle = "rgba(14,13,11,0.94)";
    g.fillText(`${LABEL_MIN_C + i}°`, LABEL_W / 2, i * LABEL_H + LABEL_H / 2);
  }
  const t = new THREE.CanvasTexture(c);
  // Three flips textures vertically by default, which would put v = 0 at the bottom
  // of the canvas. The row lookup below indexes from the top, so the labels came out
  // upside down — and an inverted "42" reads as mirrored rather than as obviously
  // flipped, which is why it looked like a UV bug rather than an orientation one.
  t.flipY = false;
  // No mipmaps. The atlas is one tall strip of rows, so every mip level averages
  // neighbouring temperatures into each other — at small sizes a plaque showing 34
  // rendered a smear of 31 through 37 stacked on top of one another, which looked
  // like the scene bleeding through rather than a filtering artefact. Linear
  // filtering on the base level costs a little sharpness when the label is tiny and
  // is correct at every size.
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

const VERT = `
precision highp float;

attribute float aPart;      // 0 = stem, 1 = plaque
attribute float aFeels;     // this marker's reading, °C

uniform vec2 uExtent;
uniform float uScale;
// 0 in the flat map, 1 in the 3D twin, eased between the two. It collapses the
// stem to nothing and drops the plaque onto the ground, so the same marker is a
// flat label on a 2D map and a standing sign in the twin, with no second code path.
uniform float uGrow;
uniform vec2 uHeadNDC; // plaque half-size in clip units: pixels / viewport

varying float vFeels;
varying float vPart;
varying vec2 vQuad;         // -1..1 across the plaque
varying vec2 vGround;
varying vec3 vNormal;
varying float vUp;
${LIFT_GLSL}

void main() {
  vFeels = aFeels;
  vPart = aPart;

  vec2 gxy = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xy;
  vGround = gxy;
  vec2 uv = clamp(gxy / uExtent, 0.0, 1.0);
  float groundZ = liftAt(uv);
  float s = uScale * uGrow;

  if (aPart < 0.5) {
    // --- stem: an ordinary world-space object standing on the street -------------
    vec3 local = position;
    vUp = local.z;
    local.xy *= ${STEM_R_M.toFixed(2)} * s;
    local.z *= ${STEM_H_M.toFixed(1)} * s;
    vNormal = normalize(mat3(instanceMatrix) * normal);
    vQuad = vec2(0.0);
    vec4 world = instanceMatrix * vec4(local, 1.0);
    world.z += groundZ;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world.xyz, 1.0);
  } else {
    // --- plaque: billboarded in view space ---------------------------------------
    // Offsetting after the model-view transform makes the quad square to the camera
    // whatever the map's pitch and bearing, which a world-space quad cannot be. It
    // also keeps the label the same shape from every angle, which matters more for
    // something being read as text than for anything else in the scene.
    vQuad = position.xy;
    vUp = 1.0;
    vNormal = vec3(0.0, 0.0, 1.0);
    vec3 anchor = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    anchor.z += groundZ + ${STEM_H_M.toFixed(1)} * s;

    // Offset in CLIP space, not view space. MapLibre's matrix is a mercator
    // projection, so its "view space" axes are not the screen's and offsetting there
    // sheared every plaque into a parallelogram — subtly at pitch 0, badly under
    // bearing. Clip space is the screen by definition, so the quad comes out square
    // at any pitch and bearing, and multiplying by w cancels the perspective divide
    // so the label is an exact pixel size at any distance.
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(anchor, 1.0);
    clip.xy += position.xy * uHeadNDC * clip.w;
    gl_Position = clip;
  }
}`;

const FRAG = `
precision highp float;

uniform sampler2D uLut;
uniform sampler2D uLabels;
uniform vec2 uExtent;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;

varying float vFeels;
varying float vPart;
varying vec2 vQuad;
varying vec2 vGround;
varying vec3 vNormal;
varying float vUp;
${REVEAL_GLSL}

void main() {
  vec2 uv = clamp(vGround / uExtent, 0.0, 1.0);
  float rv = revealAt(uv);
  if (rv < 0.15) discard;

  // Same LUT and encoding as the ground plane, so a marker and the street under it
  // at the same temperature are the same colour.
  vec3 heat = texture2D(uLut, vec2(clamp((vFeels - 20.0) * 4.0 / 255.0, 0.0, 1.0), 0.5)).rgb;

  if (vPart < 0.5) {
    float ndl = max(dot(normalize(vNormal), uSunDir), 0.0);
    // Lit by the same sun as the rest of the scene, so a marker at dusk warms with
    // everything around it instead of staying lit by a light that is not there.
    vec3 col = heat * (0.55 + 0.45 * ndl * max(uSunIntensity, 0.4) * uSunColor);
    // darker at the foot, so the stem reads as standing on the street rather than
    // smearing into it
    col *= mix(0.40, 1.0, smoothstep(0.0, 0.5, vUp));
    gl_FragColor = vec4(col * rv, rv);
    return;
  }

  // --- plaque --------------------------------------------------------------------
  // Rounded-rectangle signed distance, so the plaque has a real edge rather than the
  // hard corners of the quad it is drawn on.
  float r = 0.42;
  vec2 d = abs(vQuad) - (vec2(1.0) - vec2(r));
  float sd = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;

  float aa = max(fwidth(sd) * 1.2, 0.002);
  float body = 1.0 - smoothstep(-aa, aa, sd);
  if (body < 0.01) discard;

  // A rim slightly brighter than the fill lifts the plaque off whatever is behind it.
  float rim = smoothstep(-0.10 - aa, -0.10 + aa, sd) * body;

  float idx = clamp(floor(vFeels + 0.5) - ${LABEL_MIN_C.toFixed(1)}, 0.0, ${(LABEL_ROWS - 1).toFixed(1)});
  vec2 luv = vec2(vQuad.x * 0.5 + 0.5, (idx + (0.5 - vQuad.y * 0.5)) / ${LABEL_ROWS.toFixed(1)});
  float ink = texture2D(uLabels, luv).a;

  // Lift the fill so the dark end of the scale still reads as a label rather than a
  // hole, then lay the type over it.
  vec3 col = mix(heat * 1.14 + vec3(0.06), heat * 1.5 + vec3(0.10), rim);
  col = mix(col, vec3(0.055, 0.05, 0.045), ink);

  float a = body * rv;
  gl_FragColor = vec4(col * a, a);
}`;

export class RoutePins {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly feels: Float32Array;
  private readonly capacity = MAX_PINS;

  constructor(
    private readonly fields: TwinFields,
    reveal: THREE.Texture,
    lut: THREE.Texture,
    lift: LiftUniforms,
  ) {
    const geo = buildMarkerGeometry();
    this.feels = new Float32Array(this.capacity);
    geo.setAttribute("aFeels", new THREE.InstancedBufferAttribute(this.feels, 1));

    const w = fields.cols * fields.cellM;
    const h = fields.rows * fields.cellM;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        ...lift,
        uLut: { value: lut },
        uLabels: { value: makeLabelAtlas() },
        uExtent: { value: new THREE.Vector2(w, h) },
        uSunDir: { value: new THREE.Vector3(0, 0, 1) },
        uSunColor: { value: new THREE.Color(1, 0.94, 0.86) },
        uSunIntensity: { value: 0 },
        uScale: { value: 1 },
        uHeadNDC: { value: new THREE.Vector2(0.06, 0.06) },
        uGrow: { value: 1 },
        uReveal: { value: reveal },
        uRevealOn: { value: 0 },
      },
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      // Plaques overlap each other on a winding route; writing depth would let
      // whichever drew first punch a hole in the rest.
      depthWrite: false,
      // Annotation, so it is not occluded by the city it annotates. It also removes
      // any question of the flat 2D plaque z-fighting the ground plane it lies on.
      depthTest: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.InstancedMesh(geo, this.material, this.capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;   // annotation: on top of the scene it describes
    this.mesh.count = 0;
  }

  /**
   * Place markers along a route, using the frame's own heat grid to decide where.
   *
   * `heat` is the raw uint8 grid as the API sends it — row-major from the north
   * edge, feels_c = 20 + v/4. Read here rather than on the GPU because the placement
   * rule compares each reading against the last pin's, which is a sequential walk
   * and not something a shader can do.
   */
  setRoute(coords: [number, number][], heat: Uint8Array | null) {
    if (coords.length < 2 || !heat) {
      this.mesh.count = 0;
      return;
    }
    const { rows, cols, cellM, origin } = this.fields;
    const readAt = (x: number, y: number): number => {
      const c = Math.max(0, Math.min(cols - 1, Math.floor(x / cellM)));
      const fromSouth = Math.max(0, Math.min(rows - 1, Math.floor(y / cellM)));
      // the payload runs from the north edge; the local frame runs from the south
      return 20 + heat[(rows - 1 - fromSouth) * cols + c] / 4;
    };

    const pts = coords.map(([la, lo]) => origin.toXY(la, lo));
    const picked: Array<{ x: number; y: number; feels: number }> = [];

    let lastFeels = readAt(pts[0][0], pts[0][1]);
    picked.push({ x: pts[0][0], y: pts[0][1], feels: lastFeels });
    let lastX = pts[0][0];
    let lastY = pts[0][1];
    let sinceLast = 0;
    let carry = 0;

    for (let i = 0; i < pts.length - 1 && picked.length < this.capacity; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const seg = Math.hypot(bx - ax, by - ay);
      if (seg < 1e-6) continue;
      let d = PROBE_STEP_M - carry;
      while (d <= seg && picked.length < this.capacity) {
        const x = ax + ((bx - ax) * d) / seg;
        const y = ay + ((by - ay) * d) / seg;
        sinceLast += Math.hypot(x - lastX, y - lastY);
        lastX = x;
        lastY = y;

        const f = readAt(x, y);
        if (sinceLast >= MIN_GAP_M
            && (Math.abs(f - lastFeels) >= THRESHOLD_C || sinceLast >= MAX_GAP_M)) {
          picked.push({ x, y, feels: f });
          lastFeels = f;
          sinceLast = 0;
        }
        d += PROBE_STEP_M;
      }
      carry = (carry + seg) % PROBE_STEP_M;
    }

    // The destination always carries a reading, however flat the approach was.
    const end = pts[pts.length - 1];
    if (picked.length < this.capacity && Math.hypot(end[0] - lastX, end[1] - lastY) > 1) {
      picked.push({ x: end[0], y: end[1], feels: readAt(end[0], end[1]) });
    }

    const m = new THREE.Matrix4();
    picked.forEach((p, i) => {
      m.makeTranslation(p.x, p.y, 0);
      this.mesh.setMatrixAt(i, m);
      this.feels[i] = p.feels;
    });
    this.mesh.count = picked.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    (this.mesh.geometry.getAttribute("aFeels") as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  clear() {
    this.mesh.count = 0;
  }

  get count() {
    return this.mesh.count;
  }

  /** 0 lays the marker flat on the map; 1 stands it up at the z plane. */
  setGrow(g: number) {
    this.material.uniforms.uGrow.value = g;
  }

  setPixelScale(metresPerPixel: number) {
    // The stem scales like the rest of the scene, so it stays a believable object
    // standing on the street. The plaque does not: see setViewport.
    this.material.uniforms.uScale.value = Math.min(
      MAX_SCALE, Math.max(1, metresPerPixel / REF_M_PER_PX),
    );
  }

  /**
   * Size the plaque from the drawing buffer, in exact pixels.
   *
   * NDC spans -1..1 across the viewport, so one pixel is 2/width; a half-extent of
   * HEAD_PX_W/2 pixels is therefore HEAD_PX_W/width in clip units. No
   * metres-per-pixel involved, which is why this survives pitch, bearing and
   * perspective that a world-space size does not.
   */
  setViewport(widthPx: number, heightPx: number) {
    (this.material.uniforms.uHeadNDC.value as THREE.Vector2).set(
      HEAD_PX_W / Math.max(widthPx, 1),
      HEAD_PX_H / Math.max(heightPx, 1),
    );
  }

  setSun(dir: THREE.Vector3, intensity: number, color: THREE.Color) {
    const u = this.material.uniforms;
    u.uSunDir.value.copy(dir);
    u.uSunIntensity.value = intensity;
    u.uSunColor.value.copy(color);
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.material.uniforms.uLabels.value as THREE.Texture).dispose();
    this.material.dispose();
  }
}

/** Stem + plaque as one non-indexed geometry, tagged per vertex by `aPart`. */
function buildMarkerGeometry(): THREE.InstancedBufferGeometry {
  const stem = new THREE.CylinderGeometry(0.55, 1, 1, 7, 1, false);
  stem.rotateX(Math.PI / 2);   // three's cylinder is Y-up; the twin is Z-up
  stem.translate(0, 0, 0.5);   // base at the origin rather than straddling it
  const s = stem.toNonIndexed();

  const sp = s.getAttribute("position") as THREE.BufferAttribute;
  const sn = s.getAttribute("normal") as THREE.BufferAttribute;
  const stemCount = sp.count;

  // plaque: two triangles spanning -1..1, positioned entirely in view space
  const quad = [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1];
  const quadCount = 6;

  const total = stemCount + quadCount;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const part = new Float32Array(total);

  for (let i = 0; i < stemCount; i++) {
    pos[i * 3] = sp.getX(i);
    pos[i * 3 + 1] = sp.getY(i);
    pos[i * 3 + 2] = sp.getZ(i);
    nrm[i * 3] = sn.getX(i);
    nrm[i * 3 + 1] = sn.getY(i);
    nrm[i * 3 + 2] = sn.getZ(i);
    part[i] = 0;
  }
  for (let i = 0; i < quadCount; i++) {
    const k = stemCount + i;
    pos[k * 3] = quad[i * 2];
    pos[k * 3 + 1] = quad[i * 2 + 1];
    pos[k * 3 + 2] = 0;
    nrm[k * 3 + 2] = 1;
    part[k] = 1;
  }
  stem.dispose();
  s.dispose();

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute("aPart", new THREE.BufferAttribute(part, 1));
  return geo;
}
