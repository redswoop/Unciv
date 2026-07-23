/**
 * Map camera: pan (drag), zoom (wheel), tilt (right-drag).
 *
 * Tuned to read like Civ5's default map view: narrow FOV (mild perspective —
 * hexes stay nearly constant size across the frame) with a mid-high lookdown
 * angle so hill faces and mountain cliffs read as 3D form, not a top-down
 * spreadsheet. Zoom dollies distance only; FOV stays fixed so zoom never
 * reintroduces vanishing-point distortion.
 *
 * URL framing (reproducible screenshots): ?x=&y=&dist=&tilt=
 * `dist` is camera-to-target distance in world units.
 */

import * as THREE from "three";

/** Vertical FOV in degrees. ~16° ≈ Civ5 mild perspective; 45° was "tabletop model". */
export const MAP_FOV = 16;

/**
 * Multiply a "legacy" (FOV-45-era) distance by this to get the camera
 * distance that covers the same board height at MAP_FOV.
 *   visibleH = 2 * d * tan(fov/2)
 */
export const DIST_SCALE =
  Math.tan(((45 / 2) * Math.PI) / 180) / Math.tan(((MAP_FOV / 2) * Math.PI) / 180);

export class MapCameraControls {
  readonly camera: THREE.PerspectiveCamera;
  target: THREE.Vector2;
  /** Camera-to-look-at distance (world units). */
  distance: number;
  /**
   * Radians from straight-down (0 = top-down). Civ5 default sits around
   * 0.85–0.95 so you see the south faces of relief.
   */
  tilt = 0.9;
  private minDistance: number;
  private maxDistance: number;
  private minTilt = 0.25;
  private maxTilt = 1.1;

  private dragging: "pan" | "tilt" | null = null;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private readonly dom: HTMLElement,
    aspect: number,
    center: { x: number; y: number },
    boardRadius: number,
  ) {
    // far plane must clear the full board when camera is pulled back at narrow FOV
    this.camera = new THREE.PerspectiveCamera(MAP_FOV, aspect, 0.2, boardRadius * 24);
    this.target = new THREE.Vector2(center.x, center.y);
    // default: most of the map in frame, same visual coverage as old FOV45 * 1.35
    this.distance = boardRadius * 1.35 * DIST_SCALE;
    // Allow close inspection of a single hex / tree stand (was 3.5× ~ too far)
    this.minDistance = 0.85 * DIST_SCALE;
    this.maxDistance = boardRadius * 3.2 * DIST_SCALE;
    // near plane must stay under minDistance * cos(max tilt) so close zoom doesn't clip
    this.camera.near = 0.05;
    this.camera.updateProjectionMatrix();
    this.apply();

    dom.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    dom.addEventListener("wheel", this.onWheel, { passive: false });
    dom.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  apply(): void {
    // camera sits "south" of the target, raised by cos(tilt)
    const cam = this.camera;
    const d = this.distance;
    cam.position.set(
      this.target.x,
      this.target.y - Math.sin(this.tilt) * d,
      Math.cos(this.tilt) * d,
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(this.target.x, this.target.y, 0);
  }

  /** world-units-per-pixel at the target plane, for pixel-accurate panning */
  private worldPerPixel(): number {
    const h = 2 * this.distance * Math.tan((this.camera.fov * Math.PI) / 360);
    return h / this.dom.clientHeight;
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.dragging = e.button === 2 ? "tilt" : "pan";
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.dragging === "pan") {
      const s = this.worldPerPixel();
      this.target.x -= dx * s;
      this.target.y += dy * s * Math.cos(this.tilt);
    } else {
      this.tilt = Math.min(this.maxTilt, Math.max(this.minTilt, this.tilt + dy * 0.005));
    }
    this.apply();
  };

  private onPointerUp = (): void => {
    this.dragging = null;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const factor = Math.exp(e.deltaY * 0.001);
    this.distance = Math.min(this.maxDistance, Math.max(this.minDistance, this.distance * factor));
    this.apply();
  };
}
