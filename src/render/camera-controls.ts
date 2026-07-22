/**
 * Map camera: pan (drag / WASD), zoom-to-cursor (wheel), tilt (right-drag).
 * The camera looks at a target on the board plane (z=0) from a distance and
 * tilt angle — enough tilt to sell the Civ5 look, clamped so the board never
 * flips or goes edge-on.
 */

import * as THREE from "three";

export class MapCameraControls {
  readonly camera: THREE.PerspectiveCamera;
  target: THREE.Vector2;
  distance: number;
  /** radians from straight-down; 0 = top-down */
  tilt = 0.6;
  private minDistance = 4;
  private maxDistance: number;

  private dragging: "pan" | "tilt" | null = null;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private readonly dom: HTMLElement,
    aspect: number,
    center: { x: number; y: number },
    boardRadius: number,
  ) {
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, boardRadius * 10);
    this.target = new THREE.Vector2(center.x, center.y);
    this.distance = boardRadius * 1.35;
    this.maxDistance = boardRadius * 3;
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
      this.tilt = Math.min(1.15, Math.max(0.05, this.tilt + dy * 0.005));
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
