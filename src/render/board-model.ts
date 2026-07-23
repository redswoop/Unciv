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
  /** terrain elevation at the tile center (world z) — post-smoothing */
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
  /** posKey of the tile the city sits on */
  key: string;
  name: string;
  civ: string;
  population: number;
  z: number;
}

export interface UnitMarker {
  world: Vec2;
  /** posKey of the tile the unit stands on */
  key: string;
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

/**
 * Seabed depth (negative world-z, water surface = 0) per water terrain.
 * Civ5-style: the coastline is the z=0 contour of the seabed heightfield, and
 * the coast→ocean transition is the depth-LUT tint over the deepening floor.
 * Corner welding between coast and ocean tiles produces the smooth gradient.
 */
export const SEABED_DEPTH: Record<string, number> = {
  Coast: -0.09,
  Lakes: -0.07,
  Ocean: -0.32,
};

export function seabedDepth(baseTerrain: string): number {
  return SEABED_DEPTH[baseTerrain] ?? SEABED_DEPTH.Coast!;
}

/**
 * Land tiles never drop below this: keeps tile centers (units, cities, the
 * playable read of the hex) above the waterline while their shoreline corners
 * weld down below 0. Also the floor that separates "inland low ground" from
 * the shader's beach-sand band (painted below z≈0.04) — without it, noise-dipped
 * inland plains would grow sand patches.
 */
export const LAND_MIN_H = 0.045;

/**
 * Cap for any welded corner shared with a water tile: the seabed must never
 * breach the surface. Without this, corner averaging with tall neighbours
 * (mountains: +0.78) hoisted water-tile floors above z=0 — whole coast/lake
 * tiles rendered as dry hex-shaped sand plates. Capping is symmetric across
 * the corner's trio, so the weld (identical heights on all sharers) holds.
 */
export const SHORE_CORNER_Z = -0.055;

/**
 * Raw per-tile elevation contribution (pre-smoothing).
 * Tuned for Civ5-ish gentle relief: hills are broad bumps, mountains are
 * rounded massifs — not 6-tri tent spikes. Absolute scale is world-z units
 * (hex circumradius = 1).
 */
export function tileElevation(
  baseTerrain: string,
  features: string[],
  isWater: boolean,
  naturalWonder?: string,
): number {
  if (isWater) return seabedDepth(baseTerrain);
  if (baseTerrain === "Mountain") return 0.78;
  if (naturalWonder) return 0.42;
  if (features.includes("Hill")) return 0.36;
  // plains/grassland/desert/etc: low base, micro-relief added later
  if (baseTerrain === "Snow" || baseTerrain === "Tundra") return 0.07;
  return 0.05;
}

/** Deterministic [-1, 1] hash noise from integer hex coords. */
export function hexNoise(hx: number, hy: number, salt = 0): number {
  let h = Math.imul(hx | 0, 374761393) ^ Math.imul(hy | 0, 668265263) ^ Math.imul(salt, 962287);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 0x80000000 - 1; // roughly [-1, 1)
}

/**
 * Height at a local offset inside a tile (local = world - tile.world).
 * Uses sector barycentrics + a nonlinear falloff so peaks read as rounded
 * domes rather than linear tents. Boundary (edge) heights depend only on
 * welded corner heights → seamless across tiles.
 */
export function heightAtLocal(
  centerH: number,
  cornerHeights: readonly number[],
  corners: readonly Vec2[],
  local: Vec2,
): number {
  const r = Math.hypot(local.x, local.y);
  if (r < 1e-10) return centerH;

  for (let i = 0; i < 6; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 6]!;
    // barycentric coords in triangle (origin, a, b)
    const denom = a.x * b.y - a.y * b.x;
    if (Math.abs(denom) < 1e-12) continue;
    const wa = (local.x * b.y - local.y * b.x) / denom;
    const wb = (a.x * local.y - a.y * local.x) / denom;
    if (wa < -1e-5 || wb < -1e-5) continue; // direction not in this sector wedge
    const w0 = 1 - wa - wb;
    if (w0 >= -1e-5) {
      const edgeW = Math.min(1, Math.max(0, wa + wb));
      const hA = cornerHeights[i]!;
      const hB = cornerHeights[(i + 1) % 6]!;
      const hEdge = edgeW > 1e-12 ? (wa * hA + wb * hB) / edgeW : centerH;
      // edgeW^1.55 keeps the dome broad near the center (Civ5 rolling feel)
      const t = edgeW ** 1.55;
      return centerH * (1 - t) + hEdge * t;
    }
    // Outside the hex (overlap rims, finite-difference probes, skirt spill):
    // continue flat along the ray past the edge. Snapping back to centerH was
    // a cliff that blew up the baked-shade gradient at every hill/flat border.
    return (wa * cornerHeights[i]! + wb * cornerHeights[(i + 1) % 6]!) / (wa + wb);
  }
  return centerH;
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

  // ——— tiles (raw elevations) ———
  const tiles: RenderTile[] = [];
  const tileByKey = new Map<string, RenderTile>();
  const units: UnitMarker[] = [];
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const rawHeight = new Map<string, number>();

  const riverEdges: { key: string; clock: number }[] = [];
  for (const tile of game.tileMap.tileList) {
    const hex = { x: posX(tile.position), y: posY(tile.position) };
    const world = hex2WorldCoords(hex);
    const key = posKey(tile.position);
    const terrainDef = resolveTerrain(ruleset, tile.baseTerrain);
    const features = tileFeatures(tile);
    const isWater = terrainDef?.type === "Water";
    let elev = tileElevation(tile.baseTerrain, features, isWater, tile.naturalWonder);
    // micro-relief so plains aren't dead-flat (water stays 0)
    if (!isWater) {
      const n = hexNoise(hex.x, hex.y, 7);
      const n2 = hexNoise(hex.x, hex.y, 19);
      if (tile.baseTerrain === "Mountain") elev += 0.07 * n + 0.03 * n2;
      else if (features.includes("Hill")) elev += 0.05 * n + 0.025 * n2;
      else elev += 0.028 * n + 0.012 * n2; // gentle rolling plains
    }
    rawHeight.set(key, elev);

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
      height: elev, // replaced by smoothed value below
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
        key,
        name: unit.name,
        civ: owner,
        military: isMilitaryUnit(ruleset, unit.name),
        z: elev, // patched after smooth
      });
    }
  }

  // ——— Laplacian smooth: blend each land tile with neighbours so massifs
  // merge and hills roll instead of reading as isolated cones. Water locked
  // at its seabed depth (negative — see SEABED_DEPTH). ———
  for (const rt of tiles) {
    const raw = rawHeight.get(rt.key)!;
    if (raw < 0) {
      rt.height = raw;
      continue;
    }
    let sum = raw;
    let w = 1;
    for (const clock of NEIGHBOR_CLOCK_POSITIONS) {
      const d = getClockPositionToHexcoord(clock);
      const nKey = `${rt.hex.x + d.x},${rt.hex.y + d.y}`;
      const nr = rawHeight.get(nKey);
      if (nr === undefined) continue;
      // water neighbours pull shores down gently — toward the beach, not the
      // abyss (deep ocean capped at coast depth here; true depth still welds
      // in via corner averaging below)
      const nw = nr < 0 ? 0.55 : 0.45;
      sum += Math.max(nr, SEABED_DEPTH.Coast!) * nw;
      w += nw;
    }
    // keep a solid fraction of self so mountains don't dissolve
    const selfW = rt.baseTerrain === "Mountain" ? 0.72 : 0.55;
    const blended = sum / w;
    // land centers stay above the waterline; corners may weld below it
    rt.height = Math.max(LAND_MIN_H, selfW * raw + (1 - selfW) * blended);
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
      let touchesWater = rt.height < 0;
      for (const clock of [clockA, clockB]) {
        const d = getClockPositionToHexcoord(clock);
        const neighbor = tileByKey.get(`${rt.hex.x + d.x},${rt.hex.y + d.y}`);
        if (neighbor) {
          sum += neighbor.height;
          n++;
          if (neighbor.height < 0) touchesWater = true;
        }
      }
      // shoreline corners stay submerged (see SHORE_CORNER_Z) — land slopes
      // INTO the sea and mountains become sea cliffs, instead of hoisting
      // neighbouring seabed above the waterline
      const c = sum / n;
      rt.cornerHeights[i] = touchesWater ? Math.min(c, SHORE_CORNER_Z) : c;
    }
  }

  // ——— water centers: no dome. heightAtLocal keeps interiors near centerH,
  // which turned every water tile into a bowl (deep center, shallow welded
  // rim) — adjacent coast tiles read as sand ridges along every shared hex
  // edge. Re-center each water tile on the plain MEAN of its welded corners:
  // any deepening bias re-creates a donut (shallow rim, deep middle) in
  // narrow bays whose corners are all capped at SHORE_CORNER_Z. The seaward
  // depth grade comes entirely from corner variation. ———
  for (const rt of tiles) {
    if (rt.height >= 0) continue;
    rt.height = rt.cornerHeights.reduce((s, h) => s + h, 0) / 6;
  }

  // patch unit z to post-smooth tile height (created before laplacian pass)
  {
    let ui = 0;
    for (const tile of game.tileMap.tileList) {
      const rt = tileByKey.get(posKey(tile.position))!;
      for (const unit of [tile.militaryUnit, tile.civilianUnit, ...(tile.airUnits ?? [])]) {
        if (!unit?.name) continue;
        // water tiles have negative seabed heights — ships float at the surface
        if (ui < units.length) units[ui]!.z = Math.max(rt.height, 0.02);
        ui++;
      }
    }
  }

  // ——— cities sit on their tile's elevation ———
  for (const { city, civName } of pendingCities) {
    cities.push({
      world: hex2WorldCoords({ x: posX(city.location), y: posY(city.location) }),
      key: posKey(city.location),
      name: city.name ?? "?",
      civ: civName,
      population: city.population?.population ?? 1,
      z: Math.max(tileByKey.get(posKey(city.location))?.height ?? 0, 0.02),
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
