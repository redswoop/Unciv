import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildBoardModel,
  heightAtLocal,
  LAND_MIN_H,
  SEABED_DEPTH,
  SHORE_CORNER_Z,
  type BoardModel,
} from "./board-model";
import { loadSaveFromFile } from "../save/load-save";
import { baseRulesetForSave, readRulesetFromDisk } from "../ruleset/ruleset";
import { hexCornerVectors } from "../hex/hex-math";
import assetMap from "./asset-map.json";

const RULESET_DIR = join(import.meta.dir, "../../public/rulesets");
const SAVE = join(import.meta.dir, "../../public/saves/turn518-14civs.unciv");

let model: BoardModel;

beforeAll(async () => {
  const game = await loadSaveFromFile(SAVE);
  const ruleset = await readRulesetFromDisk(baseRulesetForSave(game), RULESET_DIR);
  model = buildBoardModel(game, ruleset, hexCornerVectors());
});

describe("board model from the REAL turn-518 save", () => {
  test("all 9919 tiles have world positions inside bounds", () => {
    expect(model.tiles.length).toBe(9919);
    for (const t of model.tiles) {
      expect(t.world.x).toBeGreaterThanOrEqual(model.bounds.minX);
      expect(t.world.x).toBeLessThanOrEqual(model.bounds.maxX);
    }
  });

  test("asset map covers every base terrain and feature in the save", () => {
    const bases = assetMap.baseTerrain as Record<string, unknown>;
    const feats = assetMap.features as Record<string, unknown>;
    const missingBase = new Set<string>();
    const missingFeat = new Set<string>();
    for (const t of model.tiles) {
      if (!bases[t.baseTerrain]) missingBase.add(t.baseTerrain);
      for (const f of t.features) if (!feats[f]) missingFeat.add(f);
    }
    expect([...missingBase]).toEqual([]);
    expect([...missingFeat]).toEqual([]);
  });

  test("territory exists and every owner has colors", () => {
    const owned = model.tiles.filter((t) => t.owner);
    expect(owned.length).toBeGreaterThan(300);
    for (const t of owned) {
      expect(model.civColors.get(t.owner!)).toBeDefined();
    }
  });

  test("borders are closed loops: every border edge's civ owns the center tile", () => {
    expect(model.borders.length).toBeGreaterThan(100);
    // border segment endpoints are hex corner points: distance from center = 1
    for (const b of model.borders.slice(0, 500)) {
      const da = Math.hypot(b.a.x - b.center.x, b.a.y - b.center.y);
      expect(da).toBeCloseTo(1, 6);
    }
  });

  test("rivers exist on this map and are hex-edge segments (length 1)", () => {
    expect(model.rivers.length).toBeGreaterThanOrEqual(40); // this map has 48
    for (const r of model.rivers.slice(0, 200)) {
      expect(Math.hypot(r.a.x - r.b.x, r.a.y - r.b.y)).toBeCloseTo(1, 6);
    }
  });

  test("roads connect adjacent tile centers (length sqrt(3))", () => {
    expect(model.roads.length).toBeGreaterThan(20);
    for (const r of model.roads) {
      expect(Math.hypot(r.from.x - r.to.x, r.from.y - r.to.y)).toBeCloseTo(Math.sqrt(3), 6);
    }
  });

  test("cities and units carry owners with colors", () => {
    expect(model.cities.length).toBeGreaterThanOrEqual(20);
    expect(model.units.length).toBeGreaterThan(20);
    for (const c of model.cities) expect(model.civColors.has(c.civ)).toBe(true);
    for (const u of model.units) expect(model.civColors.has(u.civ)).toBe(true);
    const military = model.units.filter((u) => u.military).length;
    expect(military).toBeGreaterThan(0);
    expect(military).toBeLessThan(model.units.length); // some civilians too
  });

  test("relief: welded corners — tiles sharing a corner agree on its height", () => {
    // corner i of a tile coincides with corners of its neighbours; collect
    // heights by rounded world position and assert they never disagree
    const byPos = new Map<string, number>();
    for (const t of model.tiles) {
      for (let i = 0; i < 6; i++) {
        const hour = [11, 1, 3, 5, 7, 9][i]!;
        const angle = (2 * Math.PI * hour) / 12;
        const x = t.world.x + Math.sin(angle);
        const y = t.world.y + Math.cos(angle);
        const key = `${x.toFixed(4)},${y.toFixed(4)}`;
        const prev = byPos.get(key);
        if (prev !== undefined) {
          expect(Math.abs(prev - t.cornerHeights[i]!)).toBeLessThan(1e-9);
        } else {
          byPos.set(key, t.cornerHeights[i]!);
        }
      }
    }
  });

  test("relief: water fully submerged, land raised, mountains highest", () => {
    let maxMtn = 0;
    let maxHill = 0;
    let maxFlat = 0;
    const depths: Record<string, { sum: number; n: number }> = {};
    for (const t of model.tiles) {
      if (t.baseTerrain === "Ocean" || t.baseTerrain === "Coast" || t.baseTerrain === "Lakes") {
        // centers re-derived from welded corners (no per-tile bowl), and the
        // whole tile — corners included — stays below the waterline
        expect(t.height).toBeLessThanOrEqual(SHORE_CORNER_Z + 1e-9);
        for (const c of t.cornerHeights) {
          expect(c).toBeLessThanOrEqual(SHORE_CORNER_Z + 1e-9);
        }
        const d = (depths[t.baseTerrain] ??= { sum: 0, n: 0 });
        d.sum += t.height;
        d.n++;
      } else if (t.baseTerrain === "Mountain") {
        expect(t.height).toBeGreaterThan(0.25);
        maxMtn = Math.max(maxMtn, t.height);
      } else if (t.features.includes("Hill")) {
        expect(t.height).toBeGreaterThan(0);
        maxHill = Math.max(maxHill, t.height);
      } else {
        expect(t.height).toBeGreaterThan(0);
        maxFlat = Math.max(maxFlat, t.height);
      }
    }
    // mountains dominate, hills sit above plains — soft hierarchy, not tents
    expect(maxMtn).toBeGreaterThan(maxHill);
    expect(maxHill).toBeGreaterThan(maxFlat);
    // the depth-LUT gradient needs ocean floors deeper than coast on average
    const avg = (k: string) => depths[k]!.sum / depths[k]!.n;
    expect(avg("Ocean")).toBeLessThan(avg("Coast"));
  });

  test("coastline: land centers float, shoreline corners weld underwater", () => {
    const land = model.tiles.filter(
      (t) => t.baseTerrain !== "Ocean" && t.baseTerrain !== "Coast" && t.baseTerrain !== "Lakes",
    );
    // every land CENTER stays above the waterline (units/cities never drown,
    // and the beach-sand shader band stays exclusive to shores)
    for (const t of land) expect(t.height).toBeGreaterThanOrEqual(LAND_MIN_H);
    // ...but shoreline tiles dip their welded corners BELOW z=0, so the
    // rendered waterline is an organic contour crossing inside the hex —
    // not a hex-edge cliff
    const dipped = land.filter((t) => Math.min(...t.cornerHeights) < 0);
    expect(dipped.length).toBeGreaterThan(50);
    // inland tiles stay fully dry
    const dry = land.filter((t) => Math.min(...t.cornerHeights) >= LAND_MIN_H);
    expect(dry.length).toBeGreaterThan(1000);
  });

  test("coastline: coast→ocean welds a smooth depth gradient", () => {
    const coast = model.tiles.filter((t) => t.baseTerrain === "Coast");
    expect(coast.length).toBeGreaterThan(100);
    // near-shore coast corners rise to the shore cap; ocean-facing coast
    // corners sink toward ocean depth — the smooth teal→navy transition
    expect(coast.some((t) => Math.max(...t.cornerHeights) > SHORE_CORNER_Z - 0.005)).toBe(true);
    expect(coast.some((t) => Math.min(...t.cornerHeights) < -0.15)).toBe(true);
    // no coast corner ever dips below true ocean depth (positive corners are
    // fine — mountains weld sea-cliff rims well above the waterline)
    for (const t of coast) {
      for (const c of t.cornerHeights) {
        expect(c).toBeGreaterThanOrEqual(SEABED_DEPTH.Ocean!);
      }
    }
  });

  test("coastline: ships and coastal cities sit at/above the water surface", () => {
    for (const u of model.units) expect(u.z).toBeGreaterThanOrEqual(0.02);
    for (const c of model.cities) expect(c.z).toBeGreaterThanOrEqual(0.02);
  });

  test("relief: heightfield is a dome — interior above edge average on peaks", () => {
    const corners = hexCornerVectors();
    const mtns = model.tiles.filter((t) => t.baseTerrain === "Mountain").slice(0, 40);
    expect(mtns.length).toBeGreaterThan(0);
    for (const t of mtns) {
      const edgeAvg =
        t.cornerHeights.reduce((s, h) => s + h, 0) / t.cornerHeights.length;
      // nonlinear falloff keeps center proud of the welded rim
      expect(t.height).toBeGreaterThan(edgeAvg - 1e-6);
      const mid = heightAtLocal(t.height, t.cornerHeights, corners, {
        x: corners[0]!.x * 0.5,
        y: corners[0]!.y * 0.5,
      });
      // mid-radius sits between center and rim
      expect(mid).toBeLessThanOrEqual(t.height + 1e-6);
      expect(mid).toBeGreaterThanOrEqual(Math.min(...t.cornerHeights) - 1e-6);
    }
  });

  test("relief: heightAtLocal is continuous across the hex boundary", () => {
    // Probes just past the rim (mesh OVERLAP, finite-difference shading,
    // blend-skirt corner spill) must continue the edge surface. Snapping back
    // to centerH out there exploded the baked-shade gradient at every
    // hill/flat border — the full-map "crazy patterns at height transitions".
    const corners = hexCornerVectors();
    const relief = model.tiles
      .filter((t) => t.baseTerrain === "Mountain" || t.features.includes("Hill"))
      .slice(0, 60);
    expect(relief.length).toBeGreaterThan(0);
    for (const t of relief) {
      for (let sec = 0; sec < 6; sec++) {
        const a = corners[sec]!;
        const b = corners[(sec + 1) % 6]!;
        // edge midpoint direction, sampled just inside and just outside
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const inside = heightAtLocal(t.height, t.cornerHeights, corners, {
          x: mx * 0.995,
          y: my * 0.995,
        });
        const outside = heightAtLocal(t.height, t.cornerHeights, corners, {
          x: mx * 1.08,
          y: my * 1.08,
        });
        expect(Math.abs(outside - inside)).toBeLessThan(0.02);
      }
    }
  });

  test("no shearing: tiles on the same latitude share exact world Y", () => {
    const byLat = new Map<number, number[]>();
    for (const t of model.tiles) {
      const lat = t.hex.x + t.hex.y;
      const ys = byLat.get(lat) ?? [];
      ys.push(t.world.y);
      byLat.set(lat, ys);
    }
    for (const [, ys] of byLat) {
      const first = ys[0]!;
      for (const y of ys) expect(Math.abs(y - first)).toBeLessThan(1e-9);
    }
  });
});
