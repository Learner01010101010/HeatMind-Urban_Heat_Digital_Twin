"use client";

import type * as maplibregl from "maplibre-gl";
import type { HeatTwinLayer } from "./HeatTwinLayer";

/** Exported so the map can remove this layer before the twin that backs it. */
export const OVERLAY_LAYER_ID = "heat-twin-overlay";

/**
 * The twin's annotation pass, as its own MapLibre layer.
 *
 * The twin itself is inserted below "labels" so basemap labels, POI symbols and the
 * route lines all stay readable on top of the buildings. That ordering is right for
 * geometry and wrong for annotations: MapLibre paints in list order, so the route
 * line went down *after* the temperature plaques and covered the very numbers it was
 * being described by. Depth state cannot arbitrate that — the two are different
 * layers in a painter's algorithm, not two draws in one depth-tested pass.
 *
 * This layer carries no resources of its own. It holds the twin and calls back into
 * it for a second render of the annotation scene, so both passes share one renderer,
 * one camera and one local origin. Added last, with no `beforeId`, it is the final
 * thing on the canvas.
 */
export class HeatTwinOverlayLayer implements maplibregl.CustomLayerInterface {
  readonly id = OVERLAY_LAYER_ID;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  constructor(private readonly twin: HeatTwinLayer) {}

  onAdd() {
    /* no resources: the twin owns the renderer and the scene */
  }

  onRemove() {
    /* nothing to dispose — the twin disposes the pins with the rest of its scene */
  }

  render(_gl: WebGL2RenderingContext, args: maplibregl.CustomRenderMethodInput) {
    this.twin.renderOverlay(args);
  }
}
