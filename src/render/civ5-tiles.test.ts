import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildBoardModel, type BoardModel } from "./board-model";
import { loadSaveFromFile } from "../save/load-save";
import { baseRulesetForSave, readRulesetFromDisk } from "../ruleset/ruleset";
import { hexCornerVectors } from "../hex/hex-math";
import { knownTerrains, lookFor, needsWaterSurface, terrainHeightAt } from "./civ5-tiles";
import { SEABED_DEPTH } from "./board-model";

const RULESET_DIR = join(import.meta.dir, "../../public/rulesets");
const SAVE = join(import.meta.dir, "../../public/saves/turn518-14civs.unciv");

let model: BoardModel;

beforeAll(async () => {
  const game = await loadSaveFromFile(SAVE);
  const ruleset = await readRulesetFromDisk(baseRulesetForSave(game), RULESET_DIR);
  model = buildBoardModel(game, ruleset, hexCornerVectors());
});

describe("civ5 tile kit: the four core land looks are pinned", () => {
  test("flat Grassland = green digimap + flat piece", () => {
    const look = lookFor("Grassland", []);
    expect(look.digimap).toBe("euro_grassland_d.png");
    expect(look.heights).toEqual(["grass_flat_h.png"]);
    expect(look.flat).toBe(true);
    expect(look.water).toBeUndefined();
  });

  test("flat Plains = brown digimap + flat piece", () => {
    const look = lookFor("Plains", []);
    expect(look.digimap).toBe("euro_plain_d.png");
    expect(look.heights).toEqual(["plains_flat_h.png"]);
    expect(look.flat).toBe(true);
  });

  test("Grassland+Hill = SAME green digimap, hill relief pieces", () => {
    const look = lookFor("Grassland", ["Hill"]);
    expect(look.digimap).toBe("euro_grassland_d.png");
    expect(look.heights).toEqual(["grass_hill_01_h.png", "grass_hill_02_h.png"]);
    expect(look.flat).toBe(false);
    expect(look.hScale).toBeGreaterThan(0.2); // must visibly read as a hill
  });

  test("Plains+Hill = SAME brown digimap, hill relief pieces", () => {
    const look = lookFor("Plains", ["Hill"]);
    expect(look.digimap).toBe("euro_plain_d.png");
    expect(look.heights).toEqual(["plains_hill_01_h.png", "plains_hill_02_h.png"]);
    expect(look.flat).toBe(false);
  });

  test("hills never change the ground paint, only the relief", () => {
    for (const base of ["Grassland", "Plains", "Desert", "Tundra", "Snow"]) {
      expect(lookFor(base, ["Hill"]).digimap).toBe(lookFor(base, []).digimap);
      expect(lookFor(base, ["Hill"]).flat).toBe(false);
    }
  });

  test("only Mountain samples triplanar (steep faces need side projection)", () => {
    expect(lookFor("Mountain", []).triplanar).toBe(true);
    for (const base of ["Grassland", "Plains", "Desert", "Tundra", "Snow", "Coast"]) {
      expect(lookFor(base, []).triplanar).toBeUndefined();
      expect(lookFor(base, ["Hill"]).triplanar).toBeUndefined();
    }
  });

  test("non-Hill features never change the base look", () => {
    const plain = lookFor("Grassland", []);
    for (const f of [["Forest"], ["Jungle"], ["Marsh"], ["Fallout"], ["Oasis"]]) {
      expect(lookFor("Grassland", f)).toEqual(plain);
    }
  });
});

describe("civ5 tile kit: land-land blend priorities", () => {
  test("every land terrain has a blend priority; water has none", () => {
    for (const base of knownTerrains()) {
      const look = lookFor(base, []);
      if (look.water) expect(look.blendPriority).toBeUndefined();
      else expect(look.blendPriority).toBeGreaterThan(0);
    }
  });

  test("wash direction is Civ5-like: grass over plains over desert", () => {
    const pri = (b: string) => lookFor(b, []).blendPriority!;
    expect(pri("Grassland")).toBeGreaterThan(pri("Plains"));
    expect(pri("Plains")).toBeGreaterThan(pri("Desert"));
    expect(pri("Tundra")).toBeGreaterThan(pri("Snow"));
    expect(pri("Mountain")).toBeGreaterThan(pri("Grassland"));
  });

  test("hills inherit the base terrain's priority (same wash as flat)", () => {
    expect(lookFor("Grassland", ["Hill"]).blendPriority).toBe(
      lookFor("Grassland", []).blendPriority!,
    );
  });
});

describe("civ5 tile kit against the REAL turn-518 save", () => {
  test("every base terrain in the save has an explicit look (no fallback)", () => {
    const known = new Set(knownTerrains());
    const missing = new Set<string>();
    for (const t of model.tiles) {
      if (!known.has(t.baseTerrain)) missing.add(t.baseTerrain);
    }
    expect([...missing]).toEqual([]);
  });

  test("all four core combos actually occur on this map", () => {
    const combos = new Set<string>();
    for (const t of model.tiles) {
      if (t.baseTerrain !== "Grassland" && t.baseTerrain !== "Plains") continue;
      combos.add(`${t.baseTerrain}|${t.features.includes("Hill") ? "hill" : "flat"}`);
    }
    expect([...combos].sort()).toEqual([
      "Grassland|flat",
      "Grassland|hill",
      "Plains|flat",
      "Plains|hill",
    ]);
  });

  test("extracted assets exist for every look used by this save", async () => {
    const dir = join(import.meta.dir, "../../public/textures/civ5");
    const files = new Set<string>();
    for (const t of model.tiles) {
      const look = lookFor(t.baseTerrain, t.features);
      files.add(look.digimap);
      for (const h of look.heights) files.add(h);
    }
    const missing: string[] = [];
    for (const f of files) {
      if (!(await Bun.file(join(dir, f)).exists())) missing.push(f);
    }
    expect(missing).toEqual([]);
  });

  test("water: all water looks share ONE seabed material (no underwater seams)", () => {
    for (const base of ["Coast", "Ocean", "Lakes", "Atoll"]) {
      const look = lookFor(base, []);
      expect(look.water).toBe(true);
      expect(look.digimap).toBe("euro_coast_d.png");
      expect(look.seabedDepth).toBeLessThan(0);
    }
    // ocean floor deeper than coast floor — drives the depth-LUT gradient
    expect(lookFor("Ocean", []).seabedDepth!).toBeLessThan(lookFor("Coast", []).seabedDepth!);
  });

  test("water: seabed follows the welded board base — waterline is the z=0 contour", () => {
    const corners = hexCornerVectors();
    const coast = model.tiles.find((t) => t.baseTerrain === "Coast")!;
    const spec = {
      world: coast.world,
      baseTerrain: coast.baseTerrain,
      features: coast.features,
      key: coast.key,
      height: coast.height,
      cornerHeights: coast.cornerHeights,
    };
    const look = lookFor(coast.baseTerrain, coast.features);
    // center sits at the welded (negative) seabed — within the shoreline
    // wobble amplitude (±0.065) that bends the waterline off hex geometry
    expect(Math.abs(terrainHeightAt(spec, look, null, corners, 0, 0) - coast.height)).toBeLessThan(0.08);
    expect(coast.height).toBeLessThan(0);
    // without board heights (chunk/gallery demos) it falls back to the look depth
    const bare = { ...spec, height: undefined, cornerHeights: undefined };
    expect(terrainHeightAt(bare, look, null, corners, 0, 0)).toBe(SEABED_DEPTH.Coast!);
  });

  test("water surface covers every water tile + dipped shore tiles, not inland", () => {
    const specs = model.tiles.map((t) => ({
      world: t.world,
      baseTerrain: t.baseTerrain,
      features: t.features,
      key: t.key,
      height: t.height,
      cornerHeights: t.cornerHeights,
    }));
    const water = specs.filter((s) => lookFor(s.baseTerrain, s.features).water);
    expect(water.length).toBeGreaterThan(1000);
    for (const s of water) expect(needsWaterSurface(s)).toBe(true);
    const land = specs.filter((s) => !lookFor(s.baseTerrain, s.features).water);
    const shore = land.filter((s) => needsWaterSurface(s));
    const inland = land.filter((s) => !needsWaterSurface(s));
    // the surface reaches into shoreline land tiles (where the waterline
    // contour lives) but skips the dry interior
    expect(shore.length).toBeGreaterThan(50);
    expect(inland.length).toBeGreaterThan(1000);
    for (const s of inland) {
      expect(Math.min(...s.cornerHeights!)).toBeGreaterThanOrEqual(0.02);
    }
  });

  test("relief heightmaps are not constant-flat duds", async () => {
    // A mis-decoded piece (e.g. a 512x512 multi-hex cluster read as 128x128)
    // comes out as a constant image, which PNG-compresses to ~200 bytes and
    // silently renders the tile flat. Real pieces are several KB.
    const dir = join(import.meta.dir, "../../public/textures/civ5");
    const files = new Set<string>();
    for (const t of model.tiles) {
      const look = lookFor(t.baseTerrain, t.features);
      if (look.flat || look.water) continue;
      for (const h of look.heights) files.add(h);
    }
    expect(files.size).toBeGreaterThan(0);
    const duds: string[] = [];
    for (const f of files) {
      if (Bun.file(join(dir, f)).size < 1024) duds.push(f);
    }
    expect(duds).toEqual([]);
  });
});
