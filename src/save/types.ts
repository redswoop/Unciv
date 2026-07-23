/**
 * Minimal subset of Unciv's GameInfo that the renderer needs for a static
 * frame. Field names mirror the real serialization (see docs/SAVE_FORMAT.md);
 * everything the renderer does not consume is intentionally absent — the
 * parser keeps unknown fields on the raw object, we just don't type them.
 *
 * These types are written against REAL saves (2021-era minimal-format saves
 * from the community archive AND the current master serialization), so:
 *  - every field that libGDX omits when it equals the default is optional
 *  - positions omit zero components (`{}` means (0,0))
 *  - unit owner is the civ *name* in old saves, may be civID in new ones
 */

export interface HexPos {
  x?: number;
  y?: number;
}

export interface UnitData {
  owner?: string;
  name?: string;
  /** Newer saves may carry an instance display name. */
  instanceName?: string;
  health?: number;
}

export interface TileData {
  position?: HexPos;
  baseTerrain: string;
  /** Modern field (array). */
  terrainFeatures?: string[];
  /** Very old saves used a single feature string. */
  terrainFeature?: string;
  naturalWonder?: string;
  resource?: string;
  improvement?: string;
  roadStatus?: "None" | "Road" | "Railroad";
  hasBottomRightRiver?: boolean;
  hasBottomRiver?: boolean;
  hasBottomLeftRiver?: boolean;
  militaryUnit?: UnitData;
  civilianUnit?: UnitData;
  airUnits?: UnitData[];
}

export interface MapSizeData {
  name?: string;
  radius?: number;
  width?: number;
  height?: number;
}

export interface MapParametersData {
  type?: string;
  shape?: string;
  mapSize?: MapSizeData;
  worldWrap?: boolean;
  seed?: number;
}

export interface TileMapData {
  mapParameters?: MapParametersData;
  tileList: TileData[];
}

export interface CityData {
  location?: HexPos;
  name?: string;
  id?: string;
  foundingCiv?: string;
  previousOwner?: string;
  health?: number;
  population?: { population?: number };
  /** Tiles owned by this city — the source of territory borders. */
  tiles?: HexPos[];
  workedTiles?: HexPos[];
  isBeingRazed?: boolean;
  isOriginalCapital?: boolean;
  /** Built buildings — world wonders resolved against Buildings.json. */
  cityConstructions?: { builtBuildings?: string[] };
}

export interface CivilizationData {
  civName?: string;
  /** Newer saves carry a stable id distinct from the display name. */
  civID?: string;
  playerType?: "Human" | "AI";
  playerId?: string;
  gold?: number;
  cities?: CityData[];
  /** Researched techs — the source of the civ's era (city looks). */
  tech?: { techsResearched?: string[] };
}

export interface GameParametersData {
  baseRuleset?: string;
  difficulty?: string;
  numberOfCityStates?: number;
  isOnlineMultiplayer?: boolean;
}

export interface GameInfo {
  civilizations: CivilizationData[];
  tileMap: TileMapData;
  gameParameters?: GameParametersData;
  turns?: number;
  difficulty?: string;
  currentPlayer?: string;
  gameId?: string;
  version?: { number?: number; createdWith?: { text?: string } };
}

/** Position helper: libGDX omits zero components. */
export function posX(p: HexPos | undefined): number {
  return p?.x ?? 0;
}
export function posY(p: HexPos | undefined): number {
  return p?.y ?? 0;
}
export function posKey(p: HexPos | undefined): string {
  return `${posX(p)},${posY(p)}`;
}

/** Tile features across save generations. */
export function tileFeatures(tile: TileData): string[] {
  if (tile.terrainFeatures && tile.terrainFeatures.length > 0) {
    return tile.terrainFeatures;
  }
  if (tile.terrainFeature) return [tile.terrainFeature];
  return [];
}
