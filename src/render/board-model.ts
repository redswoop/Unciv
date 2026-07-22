/**
 * Pure transformation: GameInfo + Ruleset -> flat render model.
 * Everything three.js draws comes from here; nothing here imports three.js,
 * so the whole mapping is testable against the real save in bun:test.
 */

import {
  getClockPositionToHexcoord,
  hex2WorldCoords,
  NEIGHBOR_CLOCK_POSITIONS,
  type Vec2,
} from "../hex/hex-math";
import {
  posKey,
  posX,
  posY,
  tileFeatures,
  type CityData,
  type GameInfo,
  type TileData,
} from "../save/types";
import { isMilitaryUnit, resolveNation, resolveTerrain, type Ruleset } from "../ruleset/ruleset";

export interface CivColors {
  outer: [number, number, number];
  inner: [number, number, number];
}

export interface RenderTile {
  key: string;
  hex: Vec2;
  world: Vec2;
  baseTerrain: string;
  /** ruleset RGB for tint fallback, if known */
  terrainRGB?: [number, number, number];
  features: string[];
  naturalWonder?: string;
  resource?: string;
  resourceType?: "Bonus" | "Luxury" | "Strategic";
  improvement?: string;
  roadStatus?: "Road" | "Railroad";
  owner?: string;
  /** terrain elevation at the tile center (world z) */
  height: number;
  /**
   * elevation at each hex corner, averaged over the tiles sharing that
   * corner — symmetric, so adjacent tiles produce identical corner heights
   * and the relief mesh is seamless. Order matches hexCornerVectors().
   */
  cornerHeights: [number, number, number, number, number, number];
}

export interface EdgeSegment {
  a: Vec2;
  b: Vec2;
  /** elevations at a and b (0 for flat maps) */
  za: number;
  zb: number;
}

export interface BorderSegment extends EdgeSegment {
  civ: string;
  /** center of the owning tile, for insetting the border into the tile */
  center: Vec2;
}

export interface RoadSegment {
  from: Vec2;
  to: Vec2;
  zFrom: number;
  zTo: number;
  kind: "Road" | "Railroad";
}

export interface CityMarker {
  world: Vec2;
  name: string;
  civ: string;
  population: number;
  z: number;
}

export interface UnitMarker {
  world: Vec2;
  name: string;
  civ: string;
  military: boolean;
  z: number;
}

export interface BoardModel {
  tiles: RenderTile[];
  /** civName -> colors (with deterministic fallback for ruleset drift) */
  civColors: Map<string, CivColors>;
  borders: BorderSegment[];
  rivers: EdgeSegment[];
  roads: RoadSegment[];
  cities: CityMarker[];
  units: UnitMarker[];
  /** world-space bounding box of all tiles */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  turns: number;
}

/** Deterministic fallback color for civs missing from the ruleset. */
function fallbackColor(name: string): CivColors {
  let h = 2166136261;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const hue = ((h >>> 0) % 360) / 360;
  const f = (n: number) => {
    const k = (n + hue * 12) % 12;
    return Math.round(255 * (0.6 - 0.35 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return { outer: [f(0), f(8), f(4)], inner: [255, 255, 255] };
}

const BARBARIAN_COLORS: CivColors = { outer: [60, 60, 60], inner: [255, 60, 60] };

/** Tile-owned river edges: hasBottom*River -> clock position of that edge. */
const RIVER_EDGES: [keyof TileData, number][] = [
  ["hasBottomRiver", 6],
  ["hasBottomRightRiver", 4],
  ["hasBottomLeftRiver", 8],
];

/**
 * Corner pair bounding the edge that faces the given clock position.
 * hexCornerVectors() ordering: corner[i]..corner[i+1] face NEIGHBOR_CLOCK_POSITIONS[i].
 */
export function edgeCorners(
  center: Vec2,
  clock: number,
  corners: Vec2[],
  cornerHeights?: readonly number[],
): EdgeSegment {
  const i = NEIGHBOR_CLOCK_POSITIONS.indexOf(clock as 12);
  const a = corners[i]!;
  const b = corners[(i + 1) % 6]!;
  return {
    a: { x: center.x + a.x, y: center.y + a.y },
    b: { x: center.x + b.x, y: center.y + b.y },
    za: cornerHeights?.[i] ?? 0,
    zb: cornerHeights?.[(i + 1) % 6] ?? 0,
  };
}

/** Terrain elevation model: water at sea level, land low, hills up, peaks high. */
export function tileElevation(
  baseTerrain: string,
  features: string[],
  isWater: boolean,
  naturalWonder?: string,
): number {
  if (isWater) return 0;
  if (baseTerrain === "Mountain") return 1.1;
  if (naturalWonder) return 0.6;
  if (features.includes("Hill")) return 0.42;
  return 0.09;
}

export function buildBoardModel(game: GameInfo, ruleset: Ruleset, corners: Vec2[]): BoardModel {
  // ——— ownership: civ -> cities -> tiles ———
  const ownerByTile = new Map<string, string>();
  const civColors = new Map<string, CivColors>();
  const cities: CityMarker[] = [];
  const pendingCities: { city: CityData; civName: string }[] = [];

  for (const civ of game.civilizations) {
    const civName = civ.civName ?? civ.civID ?? "?";
    const nation = resolveNation(ruleset, civName);
    civColors.set(
      civName,
      civName === "Barbarians"
        ? BARBARIAN_COLORS
        : nation?.outerColor
          ? { outer: nation.outerColor, inner: nation.innerColor ?? [255, 255, 255] }
          : fallbackColor(civName),
    );
    for (const city of civ.cities ?? []) {
      pendingCities.push({ city, civName });
      // city center may or may not be listed in city.tiles; own it explicitly
      ownerByTile.set(posKey(city.location), civName);
      for (const t of city.tiles ?? []) ownerByTile.set(posKey(t), civName);
    }
  }

  // ——— tiles ———
  const tiles: RenderTile[] = [];
  const tileByKey = new Map<string, RenderTile>();
  const units: UnitMarker[] = [];
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  const riverEdges: { key: string; clock: number }[] = [];
  for (const tile of game.tileMap.tileList) {
    const hex = { x: posX(tile.position), y: posY(tile.position) };
    const world = hex2WorldCoords(hex);
    const key = posKey(tile.position);
    const terrainDef = resolveTerrain(ruleset, tile.baseTerrain);
    const features = tileFeatures(tile);
    const rt: RenderTile = {
      key,
      hex,
      world,
      baseTerrain: tile.baseTerrain,
      terrainRGB: terrainDef?.RGB,
      features,
      naturalWonder: tile.naturalWonder,
      resource: tile.resource,
      resourceType: tile.resource
        ? ruleset.resources.get(tile.resource)?.resourceType
        : undefined,
      improvement: tile.improvement,
      roadStatus: tile.roadStatus === "Road" || tile.roadStatus === "Railroad" ? tile.roadStatus : undefined,
      owner: ownerByTile.get(key),
      height: tileElevation(
        tile.baseTerrain,
        features,
        terrainDef?.type === "Water",
        tile.naturalWonder,
      ),
      cornerHeights: [0, 0, 0, 0, 0, 0],
    };
    tiles.push(rt);
    tileByKey.set(key, rt);
    bounds.minX = Math.min(bounds.minX, world.x);
    bounds.minY = Math.min(bounds.minY, world.y);
    bounds.maxX = Math.max(bounds.maxX, world.x);
    bounds.maxY = Math.max(bounds.maxY, world.y);

    for (const [field, clock] of RIVER_EDGES) {
      if (tile[field] === true) riverEdges.push({ key, clock });
    }

    for (const unit of [tile.militaryUnit, tile.civilianUnit, ...(tile.airUnits ?? [])]) {
      if (!unit?.name) continue;
      const owner = unit.owner ?? "?";
      if (!civColors.has(owner)) civColors.set(owner, fallbackColor(owner));
      units.push({
        world,
        name: unit.name,
        civ: owner,
        military: isMilitaryUnit(ruleset, unit.name),
        z: rt.height,
      });
    }
  }

  // ——— corner heights: average over the tiles sharing each corner ———
  // corner[i] (hexCornerVectors order) is shared with the neighbours at
  // clock positions NEIGHBOR_CLOCK_POSITIONS[(i+5)%6] and NEIGHBOR_CLOCK_POSITIONS[i].
  // Averaging over the *existing* members of that trio is symmetric, so
  // adjacent tiles compute identical heights for the shared corner.
  for (const rt of tiles) {
    for (let i = 0; i < 6; i++) {
      const clockA = NEIGHBOR_CLOCK_POSITIONS[(i + 5) % 6]!;
      const clockB = NEIGHBOR_CLOCK_POSITIONS[i]!;
      let sum = rt.height;
      let n = 1;
      for (const clock of [clockA, clockB]) {
        const d = getClockPositionToHexcoord(clock);
        const neighbor = tileByKey.get(`${rt.hex.x + d.x},${rt.hex.y + d.y}`);
        if (neighbor) {
          sum += neighbor.height;
          n++;
        }
      }
      rt.cornerHeights[i] = sum / n;
    }
  }

  // ——— cities sit on their tile's elevation ———
  for (const { city, civName } of pendingCities) {
    cities.push({
      world: hex2WorldCoords({ x: posX(city.location), y: posY(city.location) }),
      name: city.name ?? "?",
      civ: civName,
      population: city.population?.population ?? 1,
      z: tileByKey.get(posKey(city.location))?.height ?? 0,
    });
  }

  // ——— rivers (each tile owns its three bottom edges), draped on relief ———
  const rivers: EdgeSegment[] = [];
  for (const { key, clock } of riverEdges) {
    const rt = tileByKey.get(key)!;
    rivers.push(edgeCorners(rt.world, clock, corners, rt.cornerHeights));
  }

  // ——— borders: owned tile edges where the neighbour owner differs ———
  const borders: BorderSegment[] = [];
  for (const rt of tiles) {
    if (!rt.owner) continue;
    for (const clock of NEIGHBOR_CLOCK_POSITIONS) {
      const d = getClockPositionToHexcoord(clock);
      const nKey = `${rt.hex.x + d.x},${rt.hex.y + d.y}`;
      const neighbor = tileByKey.get(nKey);
      if (neighbor?.owner !== rt.owner) {
        borders.push({
          ...edgeCorners(rt.world, clock, corners, rt.cornerHeights),
          civ: rt.owner,
          center: rt.world,
        });
      }
    }
  }

  // ——— roads: connect adjacent road tiles (city centers count as connectors) ———
  const roadKind = new Map<string, "Road" | "Railroad">();
  for (const rt of tiles) if (rt.roadStatus) roadKind.set(rt.key, rt.roadStatus);
  const cityKeys = new Set<string>();
  for (const civ of game.civilizations) {
    for (const city of civ.cities ?? []) cityKeys.add(posKey(city.location));
  }
  const roads: RoadSegment[] = [];
  for (const rt of tiles) {
    const kind = roadKind.get(rt.key);
    if (!kind && !cityKeys.has(rt.key)) continue;
    for (const clock of NEIGHBOR_CLOCK_POSITIONS) {
      const d = getClockPositionToHexcoord(clock);
      const nKey = `${rt.hex.x + d.x},${rt.hex.y + d.y}`;
      const nKind = roadKind.get(nKey);
      const nIsCity = cityKeys.has(nKey);
      if (!nKind && !nIsCity) continue;
      // draw each pair once: only from the lexically smaller key
      if (rt.key > nKey) continue;
      // a city with no road still connects to neighbouring roads
      const drawKind = kind === "Railroad" && nKind === "Railroad" ? "Railroad" : "Road";
      const neighbor = tileByKey.get(nKey);
      if (!neighbor) continue;
      roads.push({
        from: rt.world,
        to: neighbor.world,
        zFrom: rt.height,
        zTo: neighbor.height,
        kind: drawKind,
      });
    }
  }

  return {
    tiles,
    civColors,
    borders,
    rivers,
    roads,
    cities,
    units,
    bounds,
    turns: game.turns ?? 0,
  };
}
