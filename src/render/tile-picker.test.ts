import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildBoardModel, type BoardModel, type RenderTile } from "./board-model";
import { HexRayPicker, TilePicker, tileHexDistance, type Vec3 } from "./tile-picker";
import { hex2WorldCoords } from "../hex/hex-math";
import { loadSaveFromFile } from "../save/load-save";
import { baseRulesetForSave, readRulesetFromDisk } from "../ruleset/ruleset";
import { hexCornerVectors } from "../hex/hex-math";

const RULESET_DIR = join(import.meta.dir, "../../public/rulesets");
const SAVE = join(import.meta.dir, "../../public/saves/turn518-14civs.unciv");

let model: BoardModel;
let picker: TilePicker;

beforeAll(async () => {
  const game = await loadSaveFromFile(SAVE);
  const ruleset = await readRulesetFromDisk(baseRulesetForSave(game), RULESET_DIR);
  model = buildBoardModel(game, ruleset, hexCornerVectors());
  picker = new TilePicker(model, hexCornerVectors());
});

/** Ray from the default camera geometry (tilt 0.9) through a world point. */
function tiltedRay(target: Vec3, tilt = 0.9, dist = 18): { origin: Vec3; dir: Vec3 } {
  const origin = {
    x: target.x,
    y: target.y - Math.sin(tilt) * dist,
    z: target.z + Math.cos(tilt) * dist,
  };
  const len = Math.hypot(target.x - origin.x, target.y - origin.y, target.z - origin.z);
  return {
    origin,
    dir: {
      x: (target.x - origin.x) / len,
      y: (target.y - origin.y) / len,
      z: (target.z - origin.z) / len,
    },
  };
}

describe("tile picking against the REAL turn-518 save", () => {
  test("straight-down rays over every tile center pick that tile", () => {
    for (let i = 0; i < model.tiles.length; i += 37) {
      const t = model.tiles[i]!;
      const picked = picker.pick(
        { x: t.world.x, y: t.world.y, z: 30 },
        { x: 0, y: 0, z: -1 },
      );
      expect(picked?.key).toBe(t.key);
    }
  });

  test("tilted camera rays through each mountain apex pick that mountain (or the shoulder actually in front)", () => {
    const mountains = model.tiles.filter((t) => t.baseTerrain === "Mountain");
    expect(mountains.length).toBeGreaterThan(50);
    let exact = 0;
    for (const m of mountains) {
      const { origin, dir } = tiltedRay({ x: m.world.x, y: m.world.y, z: m.height });
      const picked = picker.pick(origin, dir)!;
      expect(picked).toBeDefined();
      // a neighbouring peak's shoulder can legitimately be in front of the
      // apex; anything further than 1 hex means the relief refinement failed
      expect(tileHexDistance(picked, m)).toBeLessThanOrEqual(1);
      if (picked.key === m.key) exact++;
    }
    expect(exact / mountains.length).toBeGreaterThan(0.85);
  });

  test("relief refinement matters: naive z=0 picks miss mountains the picker hits", () => {
    const mountains = model.tiles.filter((t) => t.baseTerrain === "Mountain");
    let fixedByRefinement = 0;
    for (const m of mountains) {
      const { origin, dir } = tiltedRay({ x: m.world.x, y: m.world.y, z: m.height });
      // where the ray crosses z=0 — the pick a flat ground plane would give
      const t0 = -origin.z / dir.z;
      const flat = picker.tileAt({ x: origin.x + dir.x * t0, y: origin.y + dir.y * t0 });
      const picked = picker.pick(origin, dir);
      if (flat?.key !== m.key && picked?.key === m.key) fixedByRefinement++;
    }
    // this map has exactly 10 such mountains at the default tilt
    expect(fixedByRefinement).toBeGreaterThanOrEqual(10);
  });

  test("rays that never descend or point off-map pick nothing", () => {
    expect(picker.pick({ x: 0, y: 0, z: 5 }, { x: 0, y: 1, z: 0.2 })).toBeUndefined();
    expect(
      picker.pick(
        { x: model.bounds.maxX + 500, y: model.bounds.maxY + 500, z: 30 },
        { x: 0, y: 0, z: -1 },
      ),
    ).toBeUndefined();
  });

  test("water tiles pick at exactly z=0", () => {
    const water = model.tiles.find((t) => t.baseTerrain === "Ocean")!;
    const { origin, dir } = tiltedRay({ x: water.world.x, y: water.world.y, z: 0 });
    expect(picker.pick(origin, dir)?.key).toBe(water.key);
  });
});

describe("generic HexRayPicker over Civ5TileSpec-style tiles (chunk/gallery/hero views)", () => {
  // gallery-style brick packing, incl. a tall "mountain" spec
  const specs = Array.from({ length: 15 }, (_, i) => {
    const col = i % 5;
    const row = Math.floor(i / 5);
    return {
      world: hex2WorldCoords({ x: -col + row, y: col + row }),
      baseTerrain: i === 7 ? "Mountain" : "Grassland",
      key: `spec-${i}`,
    };
  });
  const surface = (t: (typeof specs)[number]) => (t.baseTerrain === "Mountain" ? 0.8 : 0.05);
  const picker = new HexRayPicker(specs, surface);

  test("straight-down rays pick each spec despite non-hex keys", () => {
    for (const s of specs) {
      const picked = picker.pick({ x: s.world.x, y: s.world.y, z: 20 }, { x: 0, y: 0, z: -1 });
      expect(picked?.key).toBe(s.key);
    }
  });

  test("tilted ray through the mountain apex picks the mountain, not the tile behind", () => {
    const m = specs[7]!;
    const { origin, dir } = tiltedRay({ x: m.world.x, y: m.world.y, z: 0.8 });
    // the flat z=0 crossing lands outside the mountain hex at this tilt
    const t0 = -origin.z / dir.z;
    const flat = picker.tileAt({ x: origin.x + dir.x * t0, y: origin.y + dir.y * t0 });
    expect(flat?.key).not.toBe(m.key);
    expect(picker.pick(origin, dir)?.key).toBe(m.key);
  });
});

describe("cities and units carry tile keys for the inspector", () => {
  test("every city key resolves to a real tile", () => {
    const keys = new Set(model.tiles.map((t: RenderTile) => t.key));
    for (const c of model.cities) expect(keys.has(c.key)).toBe(true);
    for (const u of model.units) expect(keys.has(u.key)).toBe(true);
  });
});
