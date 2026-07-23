/**
 * Map camera: pan (drag), zoom (wheel, anchored at the cursor), tilt (right-drag).
 *
 * Tuned to read like Civ5's default map view: narrow FOV (mild perspective —
 * hexes stay nearly constant size across the frame) with a mid-high lookdown
 * angle so hill faces and mountain cliffs read as 3D form, not a top-down
 * spreadsheet. Zoom dollies distance only; FOV stays fixed so zoom never
 * reintroduces vanishing-point distortion. Wheel zoom keeps the ground point
 * under the cursor fixed (see `groundPointAtNdc` invariant test).
 *
 * URL framing (reproducible screenshots): ?x=&y=&dist=&tilt=
 * `dist` is camera-to-target distance in world units.
 * `syncCameraToUrl` mirrors live framing back into the URL via replaceState,
 * so the current view is always shareable/reload-safe.
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

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

/** Per-view knobs; defaults reproduce the classic full-map framing. */
export interface MapCameraOptions {
  fov?: number;
  near?: number;
  far?: number;
  tilt?: number;
  distance?: number;
  minDistance?: number;
  maxDistance?: number;
  minTilt?: number;
  maxTilt?: number;
  /** z the camera looks at — hero/chunk views aim slightly above the ground. */
  lookAtZ?: number;
}

/** Pose a camera "south" of the target, raised by cos(tilt). Pure — testable. */
export function applyMapPose(
  camera: THREE.PerspectiveCamera,
  target: { x: number; y: number },
  distance: number,
  tilt: number,
  lookAtZ = 0,
): void {
  camera.position.set(
    target.x,
    target.y - Math.sin(tilt) * distance,
    Math.cos(tilt) * distance,
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(target.x, target.y, lookAtZ);
  camera.updateMatrixWorld();
}

/** Where the ray through an NDC point hits the z=0 ground plane (null if it misses). */
export function groundPointAtNdc(
  camera: THREE.PerspectiveCamera,
  ndcX: number,
  ndcY: number,
): THREE.Vector2 | null {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(GROUND_PLANE, hit)) return null;
  return new THREE.Vector2(hit.x, hit.y);
}

export class MapCameraControls {
  readonly camera: THREE.PerspectiveCamera;
  target: THREE.Vector2;
  /** Camera-to-look-at distance (world units). */
  distance: number;
  /**
   * Radians from straight-down (0 = top-down). Civ5 default sits around
   * 0.85–0.95 so you see the south faces of relief.
   */
  tilt: number;
  /** Fired after any user-driven camera change (pan/tilt/zoom). */
  onChange: (() => void) | null = null;
  private readonly lookAtZ: number;
  private minDistance: number;
  private maxDistance: number;
  private minTilt: number;
  private maxTilt: number;

  private dragging: "pan" | "tilt" | null = null;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private readonly dom: HTMLElement,
    aspect: number,
    center: { x: number; y: number },
    boardRadius: number,
    opts: MapCameraOptions = {},
  ) {
    // far plane must clear the full board when camera is pulled back at narrow FOV;
    // near plane must stay under minDistance * cos(max tilt) so close zoom doesn't clip
    this.camera = new THREE.PerspectiveCamera(
      opts.fov ?? MAP_FOV,
      aspect,
      opts.near ?? 0.05,
      opts.far ?? boardRadius * 24,
    );
    this.target = new THREE.Vector2(center.x, center.y);
    // default: most of the map in frame, same visual coverage as old FOV45 * 1.35
    this.distance = opts.distance ?? boardRadius * 1.35 * DIST_SCALE;
    this.tilt = opts.tilt ?? 0.9;
    // Allow close inspection of a single hex / tree stand (was 3.5× ~ too far)
    this.minDistance = opts.minDistance ?? 0.85 * DIST_SCALE;
    this.maxDistance = opts.maxDistance ?? boardRadius * 3.2 * DIST_SCALE;
    this.minTilt = opts.minTilt ?? 0.25;
    this.maxTilt = opts.maxTilt ?? 1.1;
    this.lookAtZ = opts.lookAtZ ?? 0;
    this.apply();

    dom.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    dom.addEventListener("wheel", this.onWheel, { passive: false });
    dom.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  apply(): void {
    applyMapPose(this.camera, this.target, this.distance, this.tilt, this.lookAtZ);
  }

  /**
   * Dolly by wheel delta, keeping the ground point under (clientX, clientY)
   * fixed on screen: zoom heads where the cursor points, not screen center.
   */
  zoomAt(clientX: number, clientY: number, deltaY: number): void {
    const before = this.groundAtClient(clientX, clientY);
    const factor = Math.exp(deltaY * 0.001);
    this.distance = Math.min(this.maxDistance, Math.max(this.minDistance, this.distance * factor));
    this.apply();
    if (before) {
      const after = this.groundAtClient(clientX, clientY);
      if (after) {
        // camera position is linear in target, so one shift is exact for the plane
        this.target.x += before.x - after.x;
        this.target.y += before.y - after.y;
        this.apply();
      }
    }
    this.onChange?.();
  }

  private groundAtClient(clientX: number, clientY: number): THREE.Vector2 | null {
    const rect = this.dom.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return groundPointAtNdc(
      this.camera,
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
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
    this.onChange?.();
  };

  private onPointerUp = (): void => {
    this.dragging = null;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.zoomAt(e.clientX, e.clientY, e.deltaY);
  };
}

/**
 * Mirror the live camera framing into the URL query (replaceState, throttled)
 * so the current view survives reload and can be shared. Never fires on boot —
 * only on user gestures — so scripted screenshot URLs stay untouched.
 */
export function syncCameraToUrl(
  controls: MapCameraControls,
  opts: { xKey?: string; yKey?: string; legacyDist?: boolean } = {},
): void {
  const xKey = opts.xKey ?? "x";
  const yKey = opts.yKey ?? "y";
  let pending: number | null = null;
  const write = (): void => {
    pending = null;
    const q = new URLSearchParams(location.search);
    q.set(xKey, controls.target.x.toFixed(2));
    q.set(yKey, controls.target.y.toFixed(2));
    if (opts.legacyDist) {
      // main view convention: `dist` in FOV-45-equivalent units (see app-boot)
      q.set("dist", (controls.distance / DIST_SCALE).toFixed(2));
      q.delete("distRaw");
    } else {
      q.set("dist", controls.distance.toFixed(2));
    }
    q.set("tilt", controls.tilt.toFixed(3));
    history.replaceState(null, "", `${location.pathname}?${q}${location.hash}`);
  };
  controls.onChange = () => {
    if (pending === null) pending = window.setTimeout(write, 150);
  };
}
