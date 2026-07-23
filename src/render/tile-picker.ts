/**
 * Pure ray → tile picking (no three.js). The camera ray is intersected with
 * a horizontal plane whose height is refined iteratively against the actual
 * terrain surface, so hovering a mountain face picks the mountain — a flat
 * z=0 pick would land on the tile *behind* it whenever the camera is tilted.
 *
 * HexRayPicker is generic over anything with a world position on the hex
 * grid: the full-map board model (TilePicker) and the chunk/hero/gallery
 * Civ5TileSpec views (with Civ5TileKit.groundZ as the surface function).
 */

import { getDistance, roundHexCoords, world2HexCoords, type Vec2 } from "../hex/hex-math";
import { heightAtLocal, type BoardModel, type RenderTile } from "./board-model";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PickableTile {
  /** tile center in world space (must sit on the Unciv hex grid) */
  world: Vec2;
}

export class HexRayPicker<T extends PickableTile> {
  private readonly byHex = new Map<string, T>();

  constructor(
    tiles: readonly T[],
    /** terrain surface height at a local offset from the tile center */
    private readonly surfaceZ: (tile: T, local: Vec2) => number,
    /** upper bound on any surface height — the ray march starts here */
    private readonly maxHeight = 1.5,
  ) {
    for (const t of tiles) {
      const hex = roundHexCoords(world2HexCoords(t.world));
      this.byHex.set(`${hex.x},${hex.y}`, t);
    }
  }

  /** Tile containing a flat world point (undefined off-map). */
  tileAt(p: Vec2): T | undefined {
    const hex = roundHexCoords(world2HexCoords(p));
    return this.byHex.get(`${hex.x},${hex.y}`);
  }

  /** Terrain surface height at a world point (0 off-map). */
  heightAt(p: Vec2, tile = this.tileAt(p)): number {
    if (!tile) return 0;
    return this.surfaceZ(tile, { x: p.x - tile.world.x, y: p.y - tile.world.y });
  }

  /**
   * Tile under a descending ray (world space, +z up): the FIRST point where
   * the ray dips below the terrain surface — i.e. the surface the camera
   * actually sees, so a mountain face occludes the tiles behind it. Coarse
   * march (a fraction of a hex per step) between the z=maxHeight and z=0
   * plane crossings, then bisection to sharpen the hit.
   */
  pick(origin: Vec3, dir: Vec3): T | undefined {
    if (dir.z >= -1e-9) return undefined;
    const tTop = Math.max(0, (this.maxHeight - origin.z) / dir.z);
    const tGround = -origin.z / dir.z;
    if (tGround <= 0) return undefined;

    const below = (t: number): boolean => {
      const p = { x: origin.x + dir.x * t, y: origin.y + dir.y * t };
      return origin.z + dir.z * t <= this.heightAt(p) + 1e-9;
    };

    // step ≈ 1/20 of a tile spacing in the horizontal plane
    const horiz = Math.hypot(dir.x, dir.y);
    const stepT = horiz > 1e-9 ? 0.08 / horiz : tGround - tTop;
    const n = Math.max(1, Math.ceil((tGround - tTop) / Math.max(stepT, 1e-9)));

    let lo = tTop;
    let hi: number | null = below(tTop) ? tTop : null;
    if (hi === null) {
      for (let i = 1; i <= n; i++) {
        const t = tTop + ((tGround - tTop) * i) / n;
        if (below(t)) {
          hi = t;
          break;
        }
        lo = t;
      }
    }
    if (hi === null) return undefined; // never met the surface (off-map)
    let hit = hi;
    for (let i = 0; i < 24 && hit > lo; i++) {
      const mid = (lo + hit) / 2;
      if (below(mid)) hit = mid;
      else lo = mid;
    }
    return this.tileAt({ x: origin.x + dir.x * hit, y: origin.y + dir.y * hit });
  }
}

/** Full-map picker over the board model's welded relief. */
export class TilePicker extends HexRayPicker<RenderTile> {
  constructor(model: BoardModel, corners: Vec2[]) {
    super(model.tiles, (t, local) =>
      heightAtLocal(t.height, t.cornerHeights, corners, local),
    );
  }
}

/** Hex distance between two picked tiles (test helper re-export). */
export function tileHexDistance(a: RenderTile, b: RenderTile): number {
  return getDistance(a.hex, b.hex);
}
