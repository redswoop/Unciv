import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildBoardModel, type BoardModel } from "../render/board-model";
import { TileInfoIndex, tileInfoHtml } from "./tile-inspector";
import { loadSaveFromFile } from "../save/load-save";
import { baseRulesetForSave, readRulesetFromDisk } from "../ruleset/ruleset";
import { hexCornerVectors } from "../hex/hex-math";

const RULESET_DIR = join(import.meta.dir, "../../public/rulesets");
const SAVE = join(import.meta.dir, "../../public/saves/turn518-14civs.unciv");

let model: BoardModel;
let index: TileInfoIndex;

beforeAll(async () => {
  const game = await loadSaveFromFile(SAVE);
  const ruleset = await readRulesetFromDisk(baseRulesetForSave(game), RULESET_DIR);
  model = buildBoardModel(game, ruleset, hexCornerVectors());
  index = new TileInfoIndex(model);
});

describe("tile inspector info from the REAL turn-518 save", () => {
  test("city tiles report their city with civ and population", () => {
    for (const city of model.cities) {
      const tile = model.tiles.find((t) => t.key === city.key)!;
      const info = index.info(tile);
      expect(info.city?.name).toBe(city.name);
      const html = tileInfoHtml(info);
      expect(html).toContain(city.name);
      expect(html).toContain(city.civ);
      expect(html).toContain(`pop ${city.population}`);
    }
  });

  test("unit tiles list every unit standing there", () => {
    const withUnits = model.tiles.filter((t) => index.info(t).units.length > 0);
    expect(withUnits.length).toBeGreaterThan(20);
    let total = 0;
    for (const t of withUnits) {
      const info = index.info(t);
      total += info.units.length;
      const html = tileInfoHtml(info);
      for (const u of info.units) expect(html).toContain(u.name);
    }
    expect(total).toBe(model.units.length);
  });

  test("resource tiles render the resource with its type", () => {
    const t = model.tiles.find((x) => x.resource && x.resourceType)!;
    expect(t).toBeDefined();
    const html = tileInfoHtml(index.info(t));
    expect(html).toContain(t.resource!);
    expect(html).toContain(`(${t.resourceType!})`);
  });

  test("plain water tile renders terrain title and hex coords only", () => {
    const t = model.tiles.find(
      (x) =>
        x.baseTerrain === "Ocean" &&
        x.features.length === 0 &&
        !x.resource &&
        !x.owner &&
        index.info(x).units.length === 0,
    )!;
    const html = tileInfoHtml(index.info(t));
    expect(html).toContain("Ocean");
    expect(html).toContain(`hex ${t.hex.x}, ${t.hex.y}`);
    expect(html).not.toContain("ti-row");
  });

  test("html escapes markup in names", () => {
    const t = model.tiles[0]!;
    const html = tileInfoHtml({
      tile: { ...t, owner: "<script>alert(1)</script>" },
      units: [],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
