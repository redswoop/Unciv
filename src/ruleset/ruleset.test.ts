import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  baseRulesetForSave,
  isMilitaryUnit,
  readRulesetFromDisk,
  resolveNation,
  resolveTerrain,
} from "./ruleset";
import { loadSaveFromFile } from "../save/load-save";
import { tileFeatures } from "../save/types";

const RULESET_DIR = join(import.meta.dir, "../../public/rulesets");
const SAVE = join(import.meta.dir, "../../public/saves/turn518-14civs.unciv");

describe("ruleset loading", () => {
  test("Vanilla ruleset parses despite comments/trailing commas", async () => {
    const rs = await readRulesetFromDisk("Civ V - Vanilla", RULESET_DIR);
    expect(rs.terrains.size).toBeGreaterThan(20);
    expect(rs.nations.size).toBeGreaterThan(30);
    const grass = resolveTerrain(rs, "Grassland");
    expect(grass?.type).toBe("Land");
    expect(grass?.RGB).toEqual([0, 163, 0]);
  });

  test("G&K ruleset parses too", async () => {
    const rs = await readRulesetFromDisk("Civ V - Gods & Kings", RULESET_DIR);
    expect(rs.terrains.size).toBeGreaterThan(20);
  });

  test("military vs civilian classification", async () => {
    const rs = await readRulesetFromDisk("Civ V - Vanilla", RULESET_DIR);
    expect(isMilitaryUnit(rs, "Warrior")).toBe(true);
    expect(isMilitaryUnit(rs, "Worker")).toBe(false);
    expect(isMilitaryUnit(rs, "Settler")).toBe(false);
  });
});

describe("resolver against the REAL save", () => {
  test("old save defaults to Vanilla", async () => {
    const game = await loadSaveFromFile(SAVE);
    expect(baseRulesetForSave(game)).toBe("Civ V - Vanilla");
  });

  test("terrain coverage: every baseTerrain + feature in the save resolves", async () => {
    const game = await loadSaveFromFile(SAVE);
    const rs = await readRulesetFromDisk(baseRulesetForSave(game), RULESET_DIR);
    const missing = new Set<string>();
    for (const tile of game.tileMap.tileList) {
      if (!resolveTerrain(rs, tile.baseTerrain)) missing.add(tile.baseTerrain);
      for (const f of tileFeatures(tile)) {
        if (!resolveTerrain(rs, f)) missing.add(f);
      }
      if (tile.naturalWonder && !resolveTerrain(rs, tile.naturalWonder)) {
        missing.add(tile.naturalWonder);
      }
    }
    expect([...missing]).toEqual([]);
  });

  test("nation colors: majors resolve; drift is reported not thrown", async () => {
    const game = await loadSaveFromFile(SAVE);
    const rs = await readRulesetFromDisk(baseRulesetForSave(game), RULESET_DIR);
    let resolved = 0;
    let missing = 0;
    for (const civ of game.civilizations) {
      const name = civ.civName ?? "";
      if (name === "Barbarians") continue;
      const nation = resolveNation(rs, name);
      if (nation?.outerColor) resolved++;
      else missing++;
    }
    // 2021 nations vs master Nations.json — expect the vast majority to resolve
    expect(resolved).toBeGreaterThan(30);
    expect(missing).toBeLessThan(10);
  });
});
