import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadSaveFromFile, loadSaveFromText } from "./load-save";
import { summarizeGame } from "./game-summary";
import { posKey, tileFeatures } from "./types";
import { getDistance } from "../hex/hex-math";

const SAVE = join(import.meta.dir, "../../public/saves/turn518-14civs.unciv");
const SAVE2 = join(import.meta.dir, "../../public/saves/turn206-huge.unciv");

describe("loadSave against a REAL archived multiplayer save (turn 518)", () => {
  test("parses and passes basic sanity", async () => {
    const game = await loadSaveFromFile(SAVE);
    expect(game.turns).toBe(518);
    expect(game.civilizations.length).toBeGreaterThan(10);
    expect(game.tileMap.tileList.length).toBeGreaterThan(5000);
  });

  test("map is a radius-57 hexagon with a full tile set", async () => {
    const game = await loadSaveFromFile(SAVE);
    const radius = game.tileMap.mapParameters?.mapSize?.radius;
    expect(radius).toBe(57);
    // every tile position must be inside the hexagon radius
    for (const tile of game.tileMap.tileList) {
      const d = getDistance(
        { x: tile.position?.x ?? 0, y: tile.position?.y ?? 0 },
        { x: 0, y: 0 },
      );
      expect(d).toBeLessThanOrEqual(57);
    }
    // no duplicate positions
    const keys = new Set(game.tileMap.tileList.map((t) => posKey(t.position)));
    expect(keys.size).toBe(game.tileMap.tileList.length);
  });

  test("every tile has a baseTerrain and features are readable", async () => {
    const game = await loadSaveFromFile(SAVE);
    for (const tile of game.tileMap.tileList) {
      expect(typeof tile.baseTerrain).toBe("string");
      expect(tile.baseTerrain.length).toBeGreaterThan(0);
      tileFeatures(tile); // must not throw
    }
  });

  test("civs have cities with locations and owned tiles (border source)", async () => {
    const game = await loadSaveFromFile(SAVE);
    const s = summarizeGame(game);
    const withCities = s.civs.filter((c) => c.cities.length > 0);
    expect(withCities.length).toBeGreaterThanOrEqual(5);
    const totalOwned = withCities.reduce((n, c) => n + c.ownedTileCount, 0);
    expect(totalOwned).toBeGreaterThan(100);
  });

  test("units sit on tiles with owner and name", async () => {
    const game = await loadSaveFromFile(SAVE);
    const s = summarizeGame(game);
    expect(s.totalUnits).toBeGreaterThan(20);
  });

  test("second real save (turn 206, rectangular Huge map) also parses", async () => {
    const game = await loadSaveFromFile(SAVE2);
    expect(game.turns).toBe(206);
    expect(game.tileMap.tileList.length).toBeGreaterThan(3000);
  });
});

describe("loadSaveFromText wrapping variants", () => {
  test("plain JSON text (unzipped saves) loads too", async () => {
    const text = '{civilizations:[{civName:Rome}],tileMap:{tileList:[{baseTerrain:Ocean}]}}';
    const game = await loadSaveFromText(text);
    expect(game.civilizations[0]?.civName).toBe("Rome");
  });

  test("rejects non-saves with a clear error", async () => {
    await expect(loadSaveFromText("{hello:world}")).rejects.toThrow(/civilizations/);
  });
});
