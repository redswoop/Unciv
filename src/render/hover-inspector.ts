/**
 * Shared hover-tooltip wiring: pointer events → camera ray → HexRayPicker →
 * TileTooltip. Used by every view (full map, chunk, gallery, hero); the
 * picking math itself stays three-free in tile-picker.ts.
 */

import * as THREE from "three";
import type { HexRayPicker, PickableTile } from "./tile-picker";
import { TileTooltip } from "../ui/tile-inspector";

export interface HoverInspectorOptions<T extends PickableTile> {
  dom: HTMLElement;
  /** current camera (callback — views may rebuild it on save reload) */
  camera: () => THREE.Camera | null;
  /** current picker (callback for the same reason) */
  picker: () => HexRayPicker<T> | null;
  /** tooltip body for a picked tile; null/empty hides the tooltip */
  html: (tile: T) => string | null;
}

export function attachHoverInspector<T extends PickableTile>(
  opts: HoverInspectorOptions<T>,
): void {
  const tooltip = new TileTooltip();
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  opts.dom.addEventListener("pointermove", (e) => {
    const camera = opts.camera();
    const picker = opts.picker();
    if (!camera || !picker || e.buttons !== 0) {
      tooltip.hide();
      return;
    }
    ndc.set(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const tile = picker.pick(raycaster.ray.origin, raycaster.ray.direction);
    const html = tile ? opts.html(tile) : null;
    if (!html) {
      tooltip.hide();
      return;
    }
    tooltip.show(e.clientX, e.clientY, html);
  });
  opts.dom.addEventListener("pointerleave", () => tooltip.hide());
  opts.dom.addEventListener("pointerdown", () => tooltip.hide());
}
