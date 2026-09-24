"use client";

import * as maplibregl from "maplibre-gl";
import * as THREE from "three";
import type { ZoneFields } from "@/lib/api";

/**
 * The local metric frame the 3D twin renders in.
 *
 * It is the *same* projection the backend uses (services/geo.py): metres east/north
 * of the zone's SW corner, via a local equirectangular approximation that is accurate
 * to well under a metre across a zone this size. Rendering in these coordinates keeps
 * vertex data in the 0..2200 range where float32 has ~0.2 mm of precision, instead of
 * Mercator's 0..1 range where a 1 m feature is ~2.6e-8 units and geometry visibly
 * jitters as the camera moves.
 *
 * The Mercator anchor is taken at the zone *centre* rather than the SW corner so the
 * linearised Mercator scale factor is correct in the middle of the zone and its error
 * is split across both halves.
 */
export class LocalOrigin {
  readonly lat0: number;
  readonly lon0: number;
  readonly mPerDegLat: number;
  readonly mPerDegLon: number;
  readonly widthM: number;
  readonly heightM: number;
  /** local metres (x east, y north, z up) -> MapLibre Mercator world space */
  readonly localToWorld: THREE.Matrix4;

  constructor(o: ZoneFields["origin"]) {
    this.lat0 = o.lat0;
    this.lon0 = o.lon0;
    this.mPerDegLat = o.m_per_deg_lat;
    this.mPerDegLon = o.m_per_deg_lon;
    this.widthM = o.width_m;
    this.heightM = o.height_m;

    const cx = o.width_m / 2;
    const cy = o.height_m / 2;
    const [clat, clon] = this.toLatLon(cx, cy);
    const merc = maplibregl.MercatorCoordinate.fromLngLat({ lng: clon, lat: clat }, 0);
    const s = merc.meterInMercatorCoordinateUnits();

    // Mercator y grows southward, our local y grows northward -> negate y scale.
    this.localToWorld = new THREE.Matrix4()
      .makeTranslation(merc.x, merc.y, merc.z)
      .multiply(new THREE.Matrix4().makeScale(s, -s, s))
      .multiply(new THREE.Matrix4().makeTranslation(-cx, -cy, 0));
  }

  /** Mirrors backend geo.to_xy: lat/lon -> metres east/north of the SW corner. */
  toXY(lat: number, lon: number): [number, number] {
    return [(lon - this.lon0) * this.mPerDegLon, (lat - this.lat0) * this.mPerDegLat];
  }

  /** Mirrors backend geo.to_latlon. */
  toLatLon(x: number, y: number): [number, number] {
    return [this.lat0 + y / this.mPerDegLat, this.lon0 + x / this.mPerDegLon];
  }

  /** Normalised field coordinates (0..1, u east, v north) for texture sampling. */
  toUV(lat: number, lon: number): [number, number] {
    const [x, y] = this.toXY(lat, lon);
    return [x / this.widthM, y / this.heightM];
  }
}
