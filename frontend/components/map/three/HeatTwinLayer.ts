"use client";

import type * as maplibregl from "maplibre-gl";
import * as THREE from "three";
import type { BuildingProps } from "@/lib/api";
import { Buildings } from "./buildings";
import type { TwinFields } from "./fields";
import { GroundHeat } from "./groundHeat";
import { LIFT_AMPLITUDE_M, makeLiftUniforms, type LiftUniforms } from "./lift";
import { makeLutTexture } from "./fields";
import { RevealField } from "./reveal";
import { RoutePins } from "./routePins";
import { VulnerabilitySurface } from "./vulnerability";
import { BreakBeacons, type BreakBeaconRecord } from "./breakBeacons";
import { Landcover } from "./landcover";
import { Roads, type RoadFeatureProps } from "./roads";
import { TrafficSignals, type SignalRecord } from "./signals";
import { SunDisc } from "./sunDisc";
import { SunExposurePass } from "./sunExposure";
import { Trees, type TreeRecord } from "./trees";

/**
 * A MapLibre custom layer that renders the 3D twin inside MapLibre's own GL context.
 *
 * It shares the context, the depth buffer and the camera, so this is not an overlay
 * floating above a map: buildings occlude and are occluded by everything MapLibre
 * draws, and the two can never drift apart while panning.
 *
 * Geometry is submitted in the backend's local metric frame (see LocalOrigin) and the
 * map's own matrix is composed on top, which keeps vertex data in a range where
 * float32 is precise instead of pushing Mercator's 1e-9 units through the GPU.
 */

export interface SunState {
  elevationDeg: number;
  azimuthDeg: number;
  intensity: number;
  /** Ambient air temperature, °C — the baseline every surface temperature sits on. */
  airC?: number;
}

export interface FrameRef {
  key: string;
  heat: Uint8Array;
  shade: Uint8Array;
}

const DAY = new THREE.Color(1.0, 0.945, 0.87);
const DUSK = new THREE.Color(1.0, 0.72, 0.48);
const NIGHT = new THREE.Color(0.55, 0.64, 0.95);

export class HeatTwinLayer implements maplibregl.CustomLayerInterface {
  readonly id = "heat-twin-3d";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private map!: maplibregl.Map;
  private renderer!: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  /**
   * Annotations that must outrank everything MapLibre paints, not just everything
   * three.js does.
   *
   * The twin is inserted *below* the "labels" layer so the route lines, POI symbols
   * and basemap labels stay legible on top of the buildings. MapLibre paints its
   * layers in list order, so anything in `scene` is on the canvas before
   * route-casing/halo/heat/core go down — and the route line then covers the
   * temperature plaques that describe it, no matter what depth state the pins ask
   * for. `depthTest: false` cannot help: it only orders draws within this one pass.
   *
   * So the plaques live here instead, and `renderOverlay` is driven by a second
   * custom layer added *after* the route layers. Same renderer, same camera, same
   * matrix — just a later slot in MapLibre's paint order.
   */
  private readonly overlayScene = new THREE.Scene();
  private readonly camera = new THREE.Camera();

  private exposurePass!: SunExposurePass;
  private ground!: GroundHeat;
  private roads!: Roads;
  private reveal!: RevealField;
  private vulnerability!: VulnerabilitySurface;
  private pins!: RoutePins;
  private sunDisc!: SunDisc;
  private lift!: LiftUniforms;
  private equityOn = false;
  /** The route the pins describe, and the heat grid they were placed against.
   *  Both are kept so a timeline move can re-place them: the markers sit where the
   *  temperature changes, and where that is depends on the frame. */
  private pinRoute: [number, number][] = [];
  private pinHeat: Uint8Array | null = null;
  private buildings!: Buildings;
  private trees!: Trees;
  private signals!: TrafficSignals;
  private landcover!: Landcover;
  private beacons!: BreakBeacons;
  /** Kept so the beacons survive a layer rebuild and a mode change. */
  private beaconRecords: BreakBeaconRecord[] = [];

  private sun: SunState = { elevationDeg: 45, azimuthDeg: 180, intensity: 1 };
  private sunDir = new THREE.Vector3(0, 0, 1);
  private sunColor = DAY.clone();
  private twinMode = false;
  private grow = 0;
  private growTarget = 0;
  private plantGrow = 1;
  private lastMarchMs = 0;
  private revealOn = false;

  constructor(
    private readonly fields: TwinFields,
    private readonly buildingFeatures: GeoJSON.Feature<GeoJSON.Polygon, BuildingProps>[],
    private readonly treeRecords: TreeRecord[],
    private readonly roadFeatures: GeoJSON.Feature<GeoJSON.LineString, RoadFeatureProps>[],
    private readonly junctionRecords: [number, number, number][] = [],
    private readonly signalRecords: SignalRecord[] = [],
  ) {}

  // ---------------------------------------------------------------- lifecycle
  onAdd(map: maplibregl.Map, gl: WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true,
    });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.exposurePass = new SunExposurePass(this.fields);
    const exposure = this.exposurePass.target.texture;
    this.reveal = new RevealField(this.fields);
    const reveal = this.reveal.texture;

    // Built before the lifted layers so its heat keyframes exist to point them at.
    this.ground = new GroundHeat(this.fields, exposure, reveal);
    this.lift = makeLiftUniforms(this.fields.vulnStatic);
    this.lift.uLiftHeatA.value = this.ground.heatTextures.a;
    this.lift.uLiftHeatB.value = this.ground.heatTextures.b;

    this.landcover = new Landcover(this.fields, exposure, reveal, this.lift);
    this.roads = new Roads(this.roadFeatures, this.fields, exposure, reveal, this.lift,
                           this.junctionRecords);
    this.buildings = new Buildings(this.buildingFeatures, this.fields, exposure, reveal, this.lift);
    this.trees = new Trees(this.treeRecords, this.fields, exposure, reveal, this.lift);

    this.vulnerability = new VulnerabilitySurface(
      this.fields, exposure, reveal, makeLutTexture(), this.lift,
    );

    this.pins = new RoutePins(this.fields, reveal, makeLutTexture(), this.lift);
    this.signals = new TrafficSignals(this.signalRecords, this.fields, exposure, reveal, this.lift);
    this.beacons = new BreakBeacons(this.fields, this.lift);
    this.beacons.set(this.beaconRecords, this.fields);

    this.scene.add(this.vulnerability.mesh);
    this.overlayScene.add(this.pins.mesh); // see overlayScene: painted after the route lines
    this.sunDisc = new SunDisc(this.fields.origin);
    this.overlayScene.add(this.sunDisc.group);
    this.scene.add(this.landcover.mesh);
    this.scene.add(this.roads.mesh);
    this.scene.add(this.ground.mesh);
    this.scene.add(this.buildings.mesh);
    this.scene.add(this.trees.canopy);
    this.scene.add(this.signals.mesh);
    this.scene.add(this.beacons.mesh);
    this.scene.add(this.trees.trunks);

    this.applySun();
    // Development hook: lets the render pipeline be inspected and the GPU exposure
    // field compared against the backend's shade grid from the console. Not wired to
    // any UI, and never attached in a production build.
    if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
      (window as unknown as { __heatTwin?: unknown }).__heatTwin = this;
    }
  }

  /** Render counters for the development hook above. */
  readonly debug = { renders: 0 };

  private disposed = false;

  onRemove() {
    this.disposed = true;
    this.exposurePass?.dispose();
    this.roads?.dispose();
    this.landcover?.dispose();
    this.reveal?.dispose();
    this.vulnerability?.dispose();
    this.pins?.dispose();
    this.sunDisc?.dispose();
    this.ground?.dispose();
    this.buildings?.dispose();
    this.trees?.dispose();
    this.signals?.dispose();
    this.beacons?.dispose();
    this.renderer?.dispose();
  }

  // ------------------------------------------------------------------- render
  render(_gl: WebGL2RenderingContext, args: maplibregl.CustomRenderMethodInput) {
    if (!this.renderer) return;

    // ease the extrusions in and out of the ground on mode change
    const d = this.growTarget - this.grow;
    if (Math.abs(d) > 0.001) {
      this.grow += d * 0.09;
      this.map.triggerRepaint();
    } else {
      this.grow = this.growTarget;
    }
    this.buildings.setGrow(this.grow);
    // Markers ride the same mode easing: flat labels on the 2D map, standing
    // signs at the z plane in the twin, animated between the two.
    this.pins?.setGrow(this.grow);
    // Masts rise with the buildings; the painted crossings stay flat either way.
    this.signals?.setGrow(this.grow);
    this.beacons?.setGrow(this.grow);

    // Keep the route's temperature profile readable as the camera pulls back.
    // Recomputed per frame rather than on a zoom event: MapLibre eases zoom over
    // many frames, and sampling only at the ends makes the pins pop between sizes.
    if (this.pins && this.map) {
      const z = this.map.getZoom();
      const lat = (this.map.getCenter().lat * Math.PI) / 180;
      const mpp = (156543.03392 * Math.cos(lat)) / Math.pow(2, z);
      this.pins.setPixelScale(mpp);
      this.roads?.setPixelScale(mpp);
      this.signals?.setPixelScale(mpp);
      this.beacons?.setPixelScale(mpp);
      // Canopy budget by how much ground a pixel covers. Close in, everything; at a
      // zoom that fits Narhe to Swargate a 2 m crown is sub-pixel, so the smallest
      // crowns come off first and the tree lines stay.
      this.trees?.setBudget(mpp <= 0.6 ? Infinity : mpp <= 1.6 ? 46000 : mpp <= 4 ? 18000 : 7000);
      const cv = this.map.getCanvas();
      this.pins.setViewport(cv.width, cv.height);
      // The sun rides the view rather than the zone: anchored to the map centre it
      // stays on screen wherever the user pans, which is what makes it a compass for
      // the shadows rather than a fixed object somewhere over Narhe.
      const c = this.map.getCenter();
      this.sunDisc?.setAnchor(c.lat, c.lng);
      this.sunDisc?.setViewport(cv.width, cv.height);
    }

    if (this.plantGrow < 1) {
      this.plantGrow = Math.min(1, this.plantGrow + 0.05);
      this.trees.setPlantGrow(this.plantGrow);
      this.map.triggerRepaint();
    }

    const visible = this.grow > 0.002;
    this.buildings.mesh.visible = visible;
    this.trees.canopy.visible = visible;
    this.trees.trunks.visible = visible;
    this.landcover?.setVisible(visible);

    // the sun march only re-runs when the sun has actually moved
    const t0 = performance.now();
    if (this.exposurePass.update(this.renderer, this.sun.elevationDeg, this.sun.azimuthDeg)) {
      this.lastMarchMs = performance.now() - t0;
    }

    this.syncCamera(args);

    this.debug.renders++;
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Second pass: the annotation scene, driven by a custom layer sitting above the
   * route lines. See `overlayScene` for why the plaques cannot ride the main pass.
   *
   * MapLibre has drawn its own line layers into the same canvas between the two
   * calls, so the GL state it left behind has to be dropped again before three.js
   * submits — `resetState` is not redundant with the one in `render`.
   */
  renderOverlay(args: maplibregl.CustomRenderMethodInput) {
    if (this.disposed || !this.renderer || !this.pins) return;
    this.syncCamera(args);
    this.renderer.resetState();
    this.renderer.render(this.overlayScene, this.camera);
  }

  /**
   * MapLibre v6 exposes several matrices here and only one of them is the
   * mercator-to-clip transform a custom layer wants. `modelViewProjectionMatrix`
   * is NOT it — feeding it mercator [0,1] coordinates puts the scene tens of
   * thousands of clip units off screen. Since the projection refactor that added
   * globe support, the transform for the default (mercator) projection lives in
   * `defaultProjectionData.mainMatrix`, whose space `tileMercatorCoords` reports
   * as [0, 0, 1, 1] — i.e. whole-world mercator, which is what LocalOrigin targets.
   */
  private syncCamera(args: maplibregl.CustomRenderMethodInput) {
    this.camera.projectionMatrix = new THREE.Matrix4()
      .fromArray(args.defaultProjectionData.mainMatrix as unknown as number[])
      .multiply(this.fields.origin.localToWorld);
  }

  // -------------------------------------------------------------------- state
  setSun(sun: SunState) {
    this.sun = sun;
    this.applySun();
    this.map?.triggerRepaint();
  }

  private applySun() {
    const el = THREE.MathUtils.degToRad(this.sun.elevationDeg);
    const az = THREE.MathUtils.degToRad(this.sun.azimuthDeg);
    // azimuth is clockwise from north, matching the backend solar model
    this.sunDir.set(Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el));
    if (this.sunDir.lengthSq() > 0) this.sunDir.normalize();

    const e = this.sun.elevationDeg;
    if (e <= 0) this.sunColor.copy(NIGHT);
    else if (e < 12) this.sunColor.copy(DUSK).lerp(DAY, e / 12);
    else this.sunColor.copy(DAY);

    const intensity = e > 0 ? this.sun.intensity : 0;
    this.buildings?.setSun(this.sunDir, intensity, e <= 2, this.sunColor, this.sun.airC);
    this.roads?.setSun(intensity, this.sunColor);
    this.landcover?.setSun(intensity);
    this.trees?.setSun(this.sunDir, intensity, this.sunColor);
    this.vulnerability?.setSun(this.sunDir, intensity, this.sunColor);
    this.pins?.setSun(this.sunDir, intensity, this.sunColor);
    this.sunDisc?.setSun(this.sun.elevationDeg, this.sun.azimuthDeg);
    this.signals?.setSun(intensity);
  }

  /** Keyframes bracketing the timeline position; blended in temperature space. */
  setKeyframes(a: FrameRef | null, b: FrameRef | null, blend: number) {
    this.ground?.setKeyframes(a, b, blend);
    // Mirror the blend onto the lift so the relief tracks the scrubber in step
    // with the colour, rather than a frame behind it.
    if (this.ground && this.lift) {
      const s = this.ground.blendState;
      this.lift.uLiftBlend.value = s.blend;
      this.lift.uLiftHasB.value = s.hasB;
    }
    // Re-place the markers against the frame now showing. They mark where the
    // temperature changes, and a different hour changes where that is — leaving them
    // put would label the right streets with last hour's readings.
    const heat = (blend < 0.5 ? a?.heat : b?.heat ?? a?.heat) ?? null;
    if (heat && heat !== this.pinHeat) {
      this.pinHeat = heat;
      if (this.pinRoute.length) this.pins?.setRoute(this.pinRoute, heat);
    }
    this.map?.triggerRepaint();
  }

  setMode(twin: boolean) {
    this.twinMode = twin;
    this.growTarget = twin ? 1 : 0;
    this.ground?.setStyle({
      // Slightly lighter than the old raster overlay's 0.58: the ground now also
      // carries sky-view ambient occlusion and live shadow tint, so the same opacity
      // read heavier than before and buried the buildings standing in it.
      opacity: twin ? 0.5 : 0.42,
      isotherms: true,
      ao: twin ? 0.75 : 0.45,
      shade: twin ? 0.8 : 0.5,
    });
    this.map?.triggerRepaint();
  }

  // ------------------------------------------------------------ progressive reveal
  /**
   * Paint a position fix into the reveal field.
   *
   * Everything already walked stays visible, so the twin builds up along the route
   * taken rather than flickering in and out around a moving disc.
   */
  addPositionFix(lat: number, lon: number, radiusM?: number) {
    if (!this.reveal) return;
    if (this.reveal.addFix(lat, lon, radiusM)) this.map?.triggerRepaint();
  }

  /**
   * Reveal the corridor along a planned route, as [lat, lon] pairs.
   *
   * This is what makes a cross-city trip affordable to draw: the geometry for the
   * whole zone is already uploaded, but only the band the route actually passes
   * through is shaded in, so buildings, canopy, road surface and the heat plane
   * all appear together along the way rather than the whole city rendering at once.
   */
  revealRoute(coords: [number, number][], radiusM?: number) {
    if (!this.reveal) return;
    if (this.reveal.addPath(coords, radiusM)) this.map?.triggerRepaint();
  }

  /**
   * Show the vulnerability index as lit relief, with the city riding on it.
   *
   * The flat heat plane steps aside while this is on: both occupy the ground, and
   * showing temperature and vulnerability in the same place at once would leave the
   * viewer unable to say which number a colour belongs to.
   */
  setEquity(on: boolean) {
    this.equityOn = on;
    this.vulnerability?.setVisible(on);
    this.ground?.setVisible(!on);
    if (this.lift) this.lift.uLiftAmp.value = on ? LIFT_AMPLITUDE_M : 0;
    this.trees?.setLifted(on);
    this.map?.triggerRepaint();
  }

  /**
   * Stand a temperature pin every PIN_SPACING_M along a route, as [lat, lon] pairs.
   *
   * Each pin reads its own temperature from the heat field on the GPU, so the whole
   * profile re-scales when the timeline moves without this being called again. Pass
   * an empty array to clear.
   */
  setRoutePins(coords: [number, number][]) {
    this.pinRoute = coords;
    if (!this.pins) return;
    if (coords.length) this.pins.setRoute(coords, this.pinHeat);
    else this.pins.clear();
    this.map?.triggerRepaint();
  }

  /** How many pins are currently standing (for the development hook). */
  get pinCount(): number {
    return this.pins?.count ?? 0;
  }

  /** Turn progressive reveal on or off across every layer at once. */
  setRevealEnabled(on: boolean) {
    this.revealOn = on;
    for (const m of this.revealMaterials()) {
      const u = m.uniforms.uRevealOn;
      if (u) u.value = on ? 1 : 0;
    }
    this.map?.triggerRepaint();
  }

  /** Drop the reveal mask entirely and show the whole zone. */
  revealAll() {
    this.reveal?.revealAll();
    this.map?.triggerRepaint();
  }

  clearReveal() {
    this.reveal?.clear();
    this.map?.triggerRepaint();
  }

  get revealCoverage() {
    return this.reveal?.coverage ?? 0;
  }

  private revealMaterials(): THREE.ShaderMaterial[] {
    const out: THREE.ShaderMaterial[] = [];
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (m && m.uniforms && "uRevealOn" in m.uniforms) out.push(m);
    });
    return out;
  }

  /** Hydration and rest stops for the selected route, as beacons in the twin. */
  setBreakStops(records: BreakBeaconRecord[]) {
    this.beaconRecords = records;
    this.beacons?.set(records, this.fields);
    this.map?.triggerRepaint();
  }

  /** Canopy planted by the intervention simulator this session. */
  setPlantedTrees(records: TreeRecord[]) {
    if (!this.trees) return;
    const grew = records.length > this.trees.planted_count;
    this.trees.setPlanted(records, this.fields);
    if (grew) {
      this.plantGrow = 0;
      this.trees.setPlantGrow(0);
    }
    this.map?.triggerRepaint();
  }

  get isTwinMode() {
    return this.twinMode;
  }

  // --------------------------------------------------------------- diagnostics
  /**
   * Agreement between the GPU exposure field and the backend's own shade grid.
   *
   * Reads back a bounded sample rather than the whole target: this is a diagnostic,
   * and a full readback of the supersampled buffer would stall the pipeline. The
   * backend remains the authority for every number the product reports; this only
   * answers "is what you're looking at the same shade the temperature came from?".
   */
  measureAgreement(shade: Uint8Array, sampleSize = 192): { agreement: number; meanAbs: number; n: number } | null {
    if (!this.renderer || !this.exposurePass) return null;
    const target = this.exposurePass.target;
    const w = Math.min(sampleSize, target.width);
    const h = Math.min(sampleSize, target.height);
    const x0 = Math.floor((target.width - w) / 2);
    const y0 = Math.floor((target.height - h) / 2);
    const buf = new Uint8Array(w * h * 4);
    try {
      this.renderer.readRenderTargetPixels(target, x0, y0, w, h, buf);
    } catch {
      return null;
    }

    const { rows, cols } = this.fields;
    let sum = 0;
    let agree = 0;
    let n = 0;
    for (let j = 0; j < h; j += 2) {
      for (let i = 0; i < w; i += 2) {
        // render-target pixel -> normalised zone position -> physics cell
        const u = (x0 + i + 0.5) / target.width;
        const v = (y0 + j + 0.5) / target.height;
        const c = Math.min(cols - 1, Math.floor(u * cols));
        // the backend grid is stored north-first; the GPU field is GL-oriented
        const r = Math.min(rows - 1, Math.floor((1 - v) * rows));
        const gpu = buf[(j * w + i) * 4] / 255;
        const cpu = shade[r * cols + c] / 255;
        const d = Math.abs(gpu - cpu);
        sum += d;
        if (d < 0.15) agree++;
        n++;
      }
    }
    if (!n) return null;
    return { agreement: agree / n, meanAbs: sum / n, n };
  }

  get stats() {
    return {
      triangles: this.buildings?.triangles ?? 0,
      roadTriangles: this.roads?.triangles ?? 0,
      roads: this.roadFeatures.length,
      trees: this.treeRecords.length,
      planted: this.trees?.planted_count ?? 0,
      marchMs: this.lastMarchMs,
      exposureRes: this.exposurePass
        ? `${this.exposurePass.target.width}x${this.exposurePass.target.height}`
        : "-",
      physicsRes: `${this.fields.cols}x${this.fields.rows}`,
      revealOn: this.revealOn,
      revealCoverage: Math.round(this.revealCoverage * 1000) / 10,
    };
  }
}
