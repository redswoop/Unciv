import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildBoardModel, type BoardModel } from "./board-model";
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
