import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadSaveFromFile } from "../save/load-save";
import { readRulesetFromDisk, baseRulesetForSave } from "../ruleset/ruleset";
import { buildBoardModel, type EdgeSegment } from "./board-model";
import { hexCornerVectors } from "../hex/hex-math";
import { chainRiverPaths, riverWidthAt, smoothRiverPath } from "./river-paths";

const seg = (ax: number, ay: number, bx: number, by: number, za = 0, zb = 0): EdgeSegment => ({
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  za,
  zb,
});

describe("chainRiverPaths", () => {
  test("collinear segments chain into one path", () => {
    const paths = chainRiverPaths([seg(0, 0, 1, 0), seg(1, 0, 2, 0), seg(2, 0, 3, 0)]);
    expect(paths.length).toBe(1);
    expect(paths[0]!.points.length).toBe(4);
    expect(paths[0]!.segmentCount).toBe(3);
  });

  test("chains regardless of segment order/direction", () => {
    const paths = chainRiverPaths([seg(2, 0, 3, 0), seg(1, 0, 0, 0), seg(1, 0, 2, 0)]);
    expect(paths.length).toBe(1);
    expect(paths[0]!.segmentCount).toBe(3);
  });

  test("Y junction: straight main channel + tributary", () => {
    // main: (0,0)-(1,0)-(2,0); tributary joins at (1,0) from (1,1)
    const paths = chainRiverPaths([seg(0, 0, 1, 0), seg(1, 0, 2, 0), seg(1, 0, 1, 1)]);
    expect(paths.length).toBe(2);
    const total = paths.reduce((s, p) => s + p.segmentCount, 0);
    expect(total).toBe(3);
    // the longest path should be the straight-through one
    const main = paths.reduce((a, b) => (a.segmentCount >= b.segmentCount ? a : b));
    expect(main.segmentCount).toBe(2);
    expect(main.points.every((p) => Math.abs(p.y) < 1e-9)).toBe(true);
  });

  test("closed loop is chained once", () => {
    const paths = chainRiverPaths([
      seg(0, 0, 1, 0),
      seg(1, 0, 1, 1),
      seg(1, 1, 0, 1),
      seg(0, 1, 0, 0),
    ]);
    expect(paths.reduce((s, p) => s + p.segmentCount, 0)).toBe(4);
  });

  test("z values carried from welded corners", () => {
    const paths = chainRiverPaths([seg(0, 0, 1, 0, 0.1, 0.2), seg(1, 0, 2, 0, 0.2, 0.3)]);
    expect(paths[0]!.points.map((p) => p.z)).toEqual([0.1, 0.2, 0.3]);
  });
});

describe("smoothRiverPath", () => {
  test("passes through original nodes and densifies", () => {
    const path = chainRiverPaths([seg(0, 0, 1, 0), seg(1, 0, 1.5, 0.87)])[0]!;
    const smooth = smoothRiverPath(path, 5);
    expect(smooth.length).toBe(2 * 5 + 1);
    // endpoints exact
    expect(smooth[0]!.x).toBeCloseTo(path.points[0]!.x, 6);
    expect(smooth[smooth.length - 1]!.y).toBeCloseTo(path.points[2]!.y, 6);
    // middle node hit exactly at the segment boundary
    const mid = smooth[5]!;
    expect(mid.x).toBeCloseTo(1, 6);
    expect(mid.y).toBeCloseTo(0, 6);
  });

  test("z never overshoots node range (linear interp)", () => {
    const path = chainRiverPaths([seg(0, 0, 1, 0, -0.1, 0), seg(1, 0, 2, 0.2, 0, -0.05)])[0]!;
    for (const p of smoothRiverPath(path, 6)) {
      expect(p.z).toBeGreaterThanOrEqual(-0.1 - 1e-9);
      expect(p.z).toBeLessThanOrEqual(0 + 1e-9);
    }
  });
});

describe("riverWidthAt", () => {
  test("tapers at ends, full near middle, always positive", () => {
    const mid = riverWidthAt(0.5, 0.1, 1);
    const end = riverWidthAt(0.0, 0.1, 1);
    expect(end).toBeLessThan(mid);
    for (let u = 0; u <= 1.0001; u += 0.05) {
      expect(riverWidthAt(u, 0.1, 3)).toBeGreaterThan(0.02);
    }
  });
});

describe("real saves", () => {
  test("aztec reference world rivers all chain, nothing dropped", async () => {
    const game = await loadSaveFromFile(join(import.meta.dir, "../../public/saves/aztecs-turn0.unciv"));
    const ruleset = await readRulesetFromDisk(baseRulesetForSave(game), join(import.meta.dir, "../../public/rulesets"));
    const model = buildBoardModel(game, ruleset, hexCornerVectors());
    expect(model.rivers.length).toBeGreaterThan(0);
    const paths = chainRiverPaths(model.rivers);
    const total = paths.reduce((s, p) => s + p.segmentCount, 0);
    expect(total).toBe(model.rivers.length);
    // chains actually formed: fewer paths than raw segments
    expect(paths.length).toBeLessThan(model.rivers.length / 1.5);
  });

  test("late-game save rivers chain at scale", async () => {
    const game = await loadSaveFromFile(join(import.meta.dir, "../../public/saves/turn518-14civs.unciv"));
    const ruleset = await readRulesetFromDisk(baseRulesetForSave(game), join(import.meta.dir, "../../public/rulesets"));
    const model = buildBoardModel(game, ruleset, hexCornerVectors());
    const paths = chainRiverPaths(model.rivers);
    expect(paths.reduce((s, p) => s + p.segmentCount, 0)).toBe(model.rivers.length);
  });
});
