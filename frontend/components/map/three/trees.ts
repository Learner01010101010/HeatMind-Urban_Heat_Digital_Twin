"use client";

import * as THREE from "three";
import type { TwinFields } from "./fields";
import { LIFT_GLSL, type LiftUniforms } from "./lift";
import { REVEAL_GLSL } from "./reveal";

/**
 * Canopy and trunks as two InstancedMeshes (two draw calls for the whole zone).
 *
 * Every instance comes from the zone's own tree records — the same `radius_m` and
 * `density` the heat model uses for shade and evapotranspiration — so a big dense
 * tree on screen is a big dense tree in the physics. Nothing here is scattered for
 * decoration.
 *
 * Capacity is over-allocated so the intervention simulator can plant new canopy at
 * run time without rebuilding the buffers: `setPlanted()` appends instances past the
 * base tree count and the sun-exposure pass picks them up on its next march.
 */

const SLACK = 256; // room for interventions planted during the session

const CANOPY_VERT = `
attribute float aRadius;
attribute float aDensity;
attribute float aSeed;
attribute float aPlanted;

varying vec3 vNormal;
varying vec2 vGround;
varying float vDensity;
varying float vSeed;
varying float vPlanted;

uniform float uPlantGrow;
uniform vec2 uExtent;
${LIFT_GLSL}

float hash(float n) { return fract(sin(n * 43758.5453) * 12345.6789); }

void main() {
  vDensity = aDensity;
  vSeed = aSeed;
  vPlanted = aPlanted;

  float grow = mix(1.0, uPlantGrow, aPlanted);

  // --- crown shaping -----------------------------------------------------------
  // The base mesh is a subdivided icosahedron: a ball. Squashing it was never going
  // to read as foliage, because what makes a crown recognisable is not its
  // proportions but its irregularity — no tree is a surface of revolution.
  //
  // Shaped in the vertex shader rather than with denser geometry: the zone carries
  // ~34k canopies and every subdivision multiplies that. This costs nothing and,
  // because the displacement is driven by the tree's own seed, each one keeps a
  // distinct silhouette that is identical on every reload.
  vec3 d = normalize(position);
  float up = d.z * 0.5 + 0.5;            // 0 at the underside, 1 at the top

  // Profile: pinched underneath where the trunk enters, widest just above the
  // middle, rounded off at the top.
  float profile = mix(0.58, 1.06, smoothstep(0.0, 0.46, up))
                * mix(1.0, 0.74, smoothstep(0.60, 1.0, up));

  // Lobes: a few low-frequency bumps at seeded phases, which is what separates a
  // crown from a sphere at silhouette distance.
  float az = atan(d.y, d.x);
  float lobe = 1.0
    + 0.17 * sin(az * 3.0 + hash(aSeed) * 6.2832)
    + 0.11 * sin(az * 5.0 + hash(aSeed + 3.0) * 6.2832)
    + 0.09 * sin(d.z * 4.5 + hash(aSeed + 7.0) * 6.2832);

  vec3 local = d * aRadius * grow * profile * lobe;
  local.z *= 0.86;
  // Crowns lean; a stable per-tree offset that grows with height keeps a stand of
  // trees from looking stamped from one mould.
  local.xy += (vec2(hash(aSeed + 11.0), hash(aSeed + 13.0)) - 0.5) * aRadius * grow * 0.22 * up;

  vec4 world = instanceMatrix * vec4(local, 1.0);
  vGround = world.xy;
  // Stand on the vulnerability terrain with everything else.
  world.z += liftAt(clamp(vGround / uExtent, 0.0, 1.0));
  // The sphere direction, not the polyhedron's facet normal: shading then reads
  // smooth across a low-poly crown while the silhouette stays irregular, which is
  // the whole trick that lets 34k of these stay cheap.
  vNormal = normalize(mat3(instanceMatrix) * d);
  gl_Position = projectionMatrix * modelViewMatrix * world;
}`;

const CANOPY_FRAG = `
precision highp float;

varying vec3 vNormal;
varying vec2 vGround;
varying float vDensity;
varying float vSeed;
varying float vPlanted;

uniform sampler2D uExposure;
uniform sampler2D uSvf;
uniform vec2 uExtent;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
${REVEAL_GLSL}

float hash(float n) { return fract(sin(n * 43758.5453) * 12345.6789); }

void main() {
  vec2 uv = clamp(vGround / uExtent, 0.0, 1.0);
  float svf = texture2D(uSvf, uv).r;
  float shadow = texture2D(uExposure, uv).g;

  // denser canopy reads darker and cooler; seed shifts the hue a little per tree.
  // Brighter and more saturated than a literal photo-reference tree green: at the
  // scale and shading this renders at, a muted/realistic green reads as gray once
  // ambient tint and shadow multiply it down, and canopy stops reading as canopy.
  float h = hash(vSeed);
  vec3 base = mix(vec3(0.30, 0.52, 0.22), vec3(0.16, 0.38, 0.19), vDensity);
  base *= 0.85 + 0.3 * h;

  float ndl = max(dot(normalize(vNormal), uSunDir), 0.0);
  float direct = ndl * uSunIntensity * (1.0 - 0.7 * shadow);
  float ambient = mix(0.32, 0.52, pow(clamp(svf, 0.0, 1.0), 1.4));

  // Ambient tint kept green-forward rather than sky-blue-dominant, or the canopy's
  // own green gets multiplied toward teal-gray in anything but full direct sun.
  vec3 col = base * (vec3(0.30, 0.36, 0.34) * ambient + uSunColor * direct);
  // freshly planted canopy carries the intervention accent while it grows in
  col = mix(col, col * 0.7 + vec3(0.30, 0.74, 0.32) * 0.55, vPlanted * 0.55);

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

export interface TreeRecord {
  lat: number;
  lon: number;
  radiusM: number;
  density: number;
}

export class Trees {
  readonly canopy: THREE.InstancedMesh;
  readonly trunks: THREE.InstancedMesh;
  private readonly canopyMat: THREE.ShaderMaterial;
  private readonly trunkMat: THREE.MeshBasicMaterial;
  private readonly baseCount: number;
  private readonly radius: Float32Array;
  private readonly density: Float32Array;
  private readonly seed: Float32Array;
  private readonly planted: Float32Array;
  private plantedCount = 0;
  private plantedRecords: TreeRecord[] = [];
  private budget: number;
  private readonly fields: TwinFields;

  constructor(records: TreeRecord[], fields: TwinFields, exposure: THREE.Texture,
              reveal: THREE.Texture, lift: LiftUniforms) {
    const cap = records.length + SLACK;
    this.baseCount = records.length;
    this.budget = records.length;
    this.fields = fields;

    this.radius = new Float32Array(cap);
    this.density = new Float32Array(cap);
    this.seed = new Float32Array(cap);
    this.planted = new Float32Array(cap);

    const canopyGeo = new THREE.IcosahedronGeometry(1, 1);
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.22, 1, 6);
    // CylinderGeometry is Y-up; our world is Z-up
    trunkGeo.rotateX(Math.PI / 2);
    trunkGeo.translate(0, 0, 0.5);

    this.canopyMat = new THREE.ShaderMaterial({
      vertexShader: CANOPY_VERT,
      fragmentShader: CANOPY_FRAG,
      uniforms: {
        uExposure: { value: exposure },
        uSvf: { value: fields.svf },
        uExtent: { value: new THREE.Vector2(fields.origin.widthM, fields.origin.heightM) },
        uSunDir: { value: new THREE.Vector3(0, 0, 1) },
        uSunColor: { value: new THREE.Color(1.0, 0.94, 0.86) },
        uSunIntensity: { value: 1 },
        uPlantGrow: { value: 1 },
        uReveal: { value: reveal },
        uRevealOn: { value: 0 },
        ...lift,
      },
    });
    this.trunkMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.16, 0.13, 0.1) });

    this.canopy = new THREE.InstancedMesh(canopyGeo, this.canopyMat, cap);
    this.trunks = new THREE.InstancedMesh(trunkGeo, this.trunkMat, cap);
    this.canopy.frustumCulled = false;
    this.trunks.frustumCulled = false;
    this.canopy.renderOrder = 3;
    this.trunks.renderOrder = 3;

    canopyGeo.setAttribute("aRadius", new THREE.InstancedBufferAttribute(this.radius, 1));
    canopyGeo.setAttribute("aDensity", new THREE.InstancedBufferAttribute(this.density, 1));
    canopyGeo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(this.seed, 1));
    canopyGeo.setAttribute("aPlanted", new THREE.InstancedBufferAttribute(this.planted, 1));

    records.forEach((t, i) => this.write(i, t, fields, 0));
    this.setCount(records.length);
  }

  /**
   * Hide the trunks while the vulnerability terrain is raised.
   *
   * Canopies are instanced through a custom shader and ride the relief with
   * everything else; trunks are a plain material with no vertex stage to patch, so
   * they would stay pinned at z = 0 and leave the crowns floating. They are 2-6 m
   * stubs that read as nothing against 26 m of relief, and the canopy is what
   * carries the meaning here, so dropping them costs the picture nothing.
   */
  /**
   * Draw only the widest `n` measured trees, plus everything planted this session.
   *
   * The canopy is 102,877 measured crowns over the zone, which at 80 triangles each
   * is 8.2M triangles of foliage before a single building is drawn. They arrive
   * sorted widest first, so a budget drops scraps of hedge and keeps the tree lines
   * and the woodland -- and at a zoom that fits the whole corridor a 2 m crown is a
   * third of a pixel anyway.
   *
   * Planted canopy is re-written to sit immediately after the budget rather than at
   * its original index, so an intervention the user placed never disappears because
   * the camera pulled back.
   */
  setBudget(n: number) {
    const base = Math.max(0, Math.min(this.baseCount, Math.round(n)));
    if (base === this.budget) return;
    this.budget = base;
    for (let i = 0; i < this.plantedCount; i++) {
      this.write(base + i, this.plantedRecords[i], this.fields, 1);
    }
    this.setCount(base + this.plantedCount);
  }

  setLifted(on: boolean) {
    this.trunks.visible = !on;
  }

  private write(i: number, t: TreeRecord, fields: TwinFields, planted: number) {
    const [x, y] = fields.origin.toXY(t.lat, t.lon);
    // canopy centre sits near the top of the trunk; backend treats canopy top as 8 m
    const trunkH = Math.max(2.2, Math.min(6.4, t.radiusM * 1.15));
    const m = new THREE.Matrix4().makeTranslation(x, y, trunkH);
    this.canopy.setMatrixAt(i, m);
    this.trunks.setMatrixAt(
      i,
      new THREE.Matrix4()
        .makeTranslation(x, y, 0)
        .multiply(new THREE.Matrix4().makeScale(1, 1, trunkH)),
    );
    this.radius[i] = t.radiusM;
    this.density[i] = t.density;
    this.seed[i] = (x * 7.13 + y * 3.71) % 1000;
    this.planted[i] = planted;
  }

  private setCount(n: number) {
    this.canopy.count = n;
    this.trunks.count = n;
    this.canopy.instanceMatrix.needsUpdate = true;
    this.trunks.instanceMatrix.needsUpdate = true;
    const g = this.canopy.geometry;
    (g.getAttribute("aRadius") as THREE.InstancedBufferAttribute).needsUpdate = true;
    (g.getAttribute("aDensity") as THREE.InstancedBufferAttribute).needsUpdate = true;
    (g.getAttribute("aSeed") as THREE.InstancedBufferAttribute).needsUpdate = true;
    (g.getAttribute("aPlanted") as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  /** Replace the set of interventionderived trees planted this session. */
  setPlanted(records: TreeRecord[], fields: TwinFields) {
    const n = Math.min(records.length, SLACK);
    this.plantedRecords = records.slice(0, n);
    for (let i = 0; i < n; i++) this.write(this.budget + i, records[i], fields, 1);
    this.plantedCount = n;
    this.setCount(this.budget + n);
  }

  get planted_count() {
    return this.plantedCount;
  }

  setSun(dir: THREE.Vector3, intensity: number, color: THREE.Color) {
    const u = this.canopyMat.uniforms;
    u.uSunDir.value.copy(dir);
    u.uSunIntensity.value = intensity;
    u.uSunColor.value.copy(color);
  }

  /** 0..1 pop-in used when new canopy is planted. */
  setPlantGrow(g: number) {
    this.canopyMat.uniforms.uPlantGrow.value = g;
  }

  dispose() {
    this.canopy.geometry.dispose();
    this.trunks.geometry.dispose();
    this.canopyMat.dispose();
    this.trunkMat.dispose();
  }
}
