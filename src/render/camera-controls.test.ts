import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { applyMapPose, groundPointAtNdc, MAP_FOV } from "./camera-controls";

/**
 * Replicates MapCameraControls.zoomAt: dolly, then shift target by the drift
 * of the ground point under the cursor. Returns the point after correction.
 */
function zoomKeepingCursor(
  cam: THREE.PerspectiveCamera,
  target: { x: number; y: number },
  distance: number,
  tilt: number,
  ndc: { x: number; y: number },
  factor: number,
): { point: THREE.Vector2; target: { x: number; y: number }; distance: number } {
  applyMapPose(cam, target, distance, tilt);
  const before = groundPointAtNdc(cam, ndc.x, ndc.y)!;
  const d2 = distance * factor;
  applyMapPose(cam, target, d2, tilt);
  const after = groundPointAtNdc(cam, ndc.x, ndc.y)!;
  const t2 = { x: target.x + before.x - after.x, y: target.y + before.y - after.y };
  applyMapPose(cam, t2, d2, tilt);
  return { point: groundPointAtNdc(cam, ndc.x, ndc.y)!, target: t2, distance: d2 };
}

describe("cursor-anchored zoom", () => {
  const cam = new THREE.PerspectiveCamera(MAP_FOV, 16 / 9, 0.05, 500);

  test("screen center maps to the camera target", () => {
    applyMapPose(cam, { x: 15, y: 12 }, 40, 0.9);
    const p = groundPointAtNdc(cam, 0, 0)!;
    expect(p.x).toBeCloseTo(15, 6);
    expect(p.y).toBeCloseTo(12, 6);
  });

  test("ground point under the cursor stays fixed through zoom", () => {
    for (const tilt of [0.25, 0.9, 1.1]) {
      for (const factor of [0.5, 0.9, 1.8]) {
        for (const ndc of [
          { x: 0.7, y: 0.4 },
          { x: -0.9, y: -0.8 },
          { x: 0, y: 0.95 },
        ]) {
          applyMapPose(cam, { x: 15, y: 12 }, 40, tilt);
          const anchor = groundPointAtNdc(cam, ndc.x, ndc.y)!;
          const z = zoomKeepingCursor(cam, { x: 15, y: 12 }, 40, tilt, ndc, factor);
          expect(z.point.x).toBeCloseTo(anchor.x, 6);
          expect(z.point.y).toBeCloseTo(anchor.y, 6);
        }
      }
    }
  });

  test("zooming at center leaves the target unchanged", () => {
    const z = zoomKeepingCursor(cam, { x: 15, y: 12 }, 40, 0.9, { x: 0, y: 0 }, 0.6);
    expect(z.target.x).toBeCloseTo(15, 6);
    expect(z.target.y).toBeCloseTo(12, 6);
    expect(z.distance).toBeCloseTo(24, 6);
  });
});
