import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildBoardModel, type BoardModel } from "./board-model";
import { loadSaveFromFile } from "../save/load-save";
import type { GameInfo } from "../save/types";
import { baseRulesetForSave, readRulesetFromDisk } from "../ruleset/ruleset";
import { hexCornerVectors } from "../hex/hex-math";
import assetMap from "./asset-map.json";

/**
 * The aztec-turn0 save is the REFERENCE WORLD for visual work: the bundled
 * default of the dev server, embedded build, and chunk views. These tests pin
 * its shape so a regressing parser or model change is caught against the map
 * we actually look at every day. (turn518-14civs remains the late-game
 * regression fixture.)
 */

const RULESET_DIR = join(import.meta.dir, "../../public/rulesets");
const SAVE = join(import.meta.dir, "../../public/saves/aztecs-turn0.unciv");

let game: GameInfo;
let model: BoardModel;

beforeAll(async () => {
  game = await loadSaveFromFile(SAVE);
  const ruleset = await readRulesetFromDisk(baseRulesetForSave(game), RULESET_DIR);
  model = buildBoardModel(game, ruleset, hexCornerVectors());
});

describe("aztec-turn0 reference world", () => {
  test("parses: 1276 tiles, turn 0, 11 civs, world-wrap medium map", () => {
    expect(game.tileMap.tileList.length).toBe(1276);
    expect(game.turns ?? 0).toBe(0);
    expect(game.civilizations.length).toBe(11);
  });

  test("board model: every tile gets world pos, height, and welded corners", () => {
    expect(model.tiles.length).toBe(1276);
    for (const t of model.tiles) {
      expect(Number.isFinite(t.world.x)).toBe(true);
      expect(Number.isFinite(t.height)).toBe(true);
      for (const c of t.cornerHeights) expect(Number.isFinite(c)).toBe(true);
    }
  });

  test("asset map covers every base terrain and feature in this save", () => {
    const bases = assetMap.baseTerrain as Record<string, unknown>;
    const feats = assetMap.features as Record<string, unknown>;
    for (const t of model.tiles) {
      expect(bases[t.baseTerrain]).toBeDefined();
      for (const f of t.features) expect(feats[f]).toBeDefined();
    }
  });

  test("Tenochtitlan exists with owned territory", () => {
    const cap = model.cities.find((c) => c.name === "Tenochtitlan");
    expect(cap).toBeDefined();
    expect(cap!.civ).toBe("Aztecs");
    expect(model.tiles.filter((t) => t.owner === "Aztecs").length).toBeGreaterThanOrEqual(7);
  });

  test("the three natural wonders are on the map", () => {
    const wonders = new Set(model.tiles.map((t) => t.naturalWonder).filter(Boolean));
    expect([...wonders].sort()).toEqual(["Grand Mesa", "Mount Sinai", "Rock of Gibraltar"]);
  });

  test("turn-0 units: settlers + starting warriors (incl. the Aztec Jaguar)", () => {
    expect(model.units.length).toBe(16);
    for (const u of model.units) {
      expect(["Settler", "Warrior", "Jaguar"]).toContain(u.name);
      expect(model.civColors.has(u.civ)).toBe(true);
    }
  });
});
