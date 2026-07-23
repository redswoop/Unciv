/**
 * Base Ruleset loader + name resolver.
 *
 * GameInfo references content by NAME ("Grassland", "Oil well", "Persia").
 * The definitions live in the ruleset JSONs vendored from yairm210/Unciv
 * under public/rulesets/<base ruleset>/. This module resolves save names
 * into those definitions and never throws on a miss — real saves reference
 * nations/terrains that drift across versions, so misses are collected for
 * reporting instead (see unresolved()).
 */

import { parseGdxJson, type GdxValue } from "../save/gdx-json";
import type { GameInfo } from "../save/types";

export const BASE_RULESETS = ["Civ V - Vanilla", "Civ V - Gods & Kings"] as const;
export type BaseRulesetName = (typeof BASE_RULESETS)[number];

export interface TerrainDef {
  name: string;
  type: "Land" | "Water" | "TerrainFeature" | "NaturalWonder";
  RGB?: [number, number, number];
  overrideStats?: boolean;
  occursOn?: string[];
  turnsInto?: string;
  impassable?: boolean;
  unbuildable?: boolean;
}

export interface TileImprovementDef {
  name: string;
  terrainsCanBeBuiltOn?: string[];
  shortcutKey?: string;
}

export interface TileResourceDef {
  name: string;
  resourceType?: "Bonus" | "Luxury" | "Strategic";
  terrainsCanBeFoundOn?: string[];
}

export interface NationDef {
  name: string;
  /** Border/area color. */
  outerColor?: [number, number, number];
  /** Text/icon color. */
  innerColor?: [number, number, number];
  cityStateType?: string;
}

export interface UnitDef {
  name: string;
  unitType?: string;
}

export interface BuildingDef {
  name: string;
  isWonder?: boolean;
  isNationalWonder?: boolean;
  requiredTech?: string;
}

/** One column of Techs.json — techs grouped by column with a shared era. */
export interface TechColumnDef {
  columnNumber?: number;
  era?: string;
  techs?: { name?: string }[];
}

export interface UnitTypeDef {
  name: string;
  movementType?: "Land" | "Water" | "Air";
}

export interface Ruleset {
  name: string;
  terrains: Map<string, TerrainDef>;
  improvements: Map<string, TileImprovementDef>;
  resources: Map<string, TileResourceDef>;
  nations: Map<string, NationDef>;
  units: Map<string, UnitDef>;
  unitTypes: Map<string, UnitTypeDef>;
  /** World + national wonders and regular buildings (empty if Buildings.json absent). */
  buildings: Map<string, BuildingDef>;
  /** tech name -> { era, column } from Techs.json (empty if absent). */
  techInfo: Map<string, { era: string; column: number }>;
  /** Era names in tech-column order (deduped, e.g. Ancient era → Information era). */
  eraOrder: string[];
  /** Names the save asked for that the ruleset does not define. */
  unresolved: Set<string>;
}

function toMap<T extends { name: string }>(raw: GdxValue): Map<string, T> {
  const map = new Map<string, T>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const e = entry as { name?: string };
      if (e && typeof e === "object" && typeof e.name === "string") {
        map.set(e.name, entry as T);
      }
    }
  }
  return map;
}

export interface RulesetFileText {
  terrains: string;
  improvements: string;
  resources: string;
  nations: string;
  units: string;
  unitTypes: string;
  /** Optional (older vendored rulesets lack them): city-era + wonder support. */
  techs?: string;
  buildings?: string;
}

/** Pure constructor from file texts — I/O stays at the edges (browser fetch / Bun file). */
export function buildRuleset(name: string, files: RulesetFileText): Ruleset {
  const techInfo = new Map<string, { era: string; column: number }>();
  const eraOrder: string[] = [];
  if (files.techs) {
    const columns = parseGdxJson(files.techs);
    if (Array.isArray(columns)) {
      for (const raw of columns) {
        const col = raw as TechColumnDef;
        const era = col.era ?? "?";
        if (!eraOrder.includes(era)) eraOrder.push(era);
        for (const t of col.techs ?? []) {
          if (t.name) techInfo.set(t.name, { era, column: col.columnNumber ?? 0 });
        }
      }
    }
  }
  return {
    name,
    terrains: toMap<TerrainDef>(parseGdxJson(files.terrains)),
    improvements: toMap<TileImprovementDef>(parseGdxJson(files.improvements)),
    resources: toMap<TileResourceDef>(parseGdxJson(files.resources)),
    nations: toMap<NationDef>(parseGdxJson(files.nations)),
    units: toMap<UnitDef>(parseGdxJson(files.units)),
    unitTypes: toMap<UnitTypeDef>(parseGdxJson(files.unitTypes)),
    buildings: files.buildings
      ? toMap<BuildingDef>(parseGdxJson(files.buildings))
      : new Map(),
    techInfo,
    eraOrder,
    unresolved: new Set(),
  };
}

const FILE_NAMES: Record<keyof RulesetFileText, string> = {
  terrains: "Terrains.json",
  improvements: "TileImprovements.json",
  resources: "TileResources.json",
  nations: "Nations.json",
  units: "Units.json",
  unitTypes: "UnitTypes.json",
  techs: "Techs.json",
  buildings: "Buildings.json",
};

const OPTIONAL_FILES = new Set<keyof RulesetFileText>(["techs", "buildings"]);

/** Browser: fetch the vendored ruleset from public/. */
export async function fetchRuleset(base: BaseRulesetName): Promise<Ruleset> {
  const entries = await Promise.all(
    (Object.entries(FILE_NAMES) as [keyof RulesetFileText, string][]).map(
      async ([key, file]) => {
        // encodeURI, not encodeURIComponent: the dev static server (sirv)
        // serves "Gods & Kings" with a literal &, but %26 falls through to
        // the SPA HTML fallback — which then explodes in parseGdxJson
        const res = await fetch(encodeURI(`rulesets/${base}/${file}`)).catch(() => null);
        if (!res?.ok) {
          if (OPTIONAL_FILES.has(key)) return [key, undefined] as const;
          throw new Error(`Failed to fetch ruleset file ${base}/${file}: ${res?.status}`);
        }
        return [key, await res.text()] as const;
      },
    ),
  );
  return buildRuleset(base, Object.fromEntries(entries) as unknown as RulesetFileText);
}

/** Bun/tests: read the vendored ruleset from disk. */
export async function readRulesetFromDisk(
  base: BaseRulesetName,
  rootDir: string,
): Promise<Ruleset> {
  const bun = (globalThis as { Bun?: { file(p: string): { text(): Promise<string>; exists(): Promise<boolean> } } }).Bun;
  if (!bun) throw new Error("readRulesetFromDisk requires Bun");
  const entries = await Promise.all(
    (Object.entries(FILE_NAMES) as [keyof RulesetFileText, string][]).map(
      async ([key, file]) => {
        const f = bun.file(`${rootDir}/${base}/${file}`);
        if (OPTIONAL_FILES.has(key) && !(await f.exists())) return [key, undefined] as const;
        return [key, await f.text()] as const;
      },
    ),
  );
  return buildRuleset(base, Object.fromEntries(entries) as unknown as RulesetFileText);
}

/** Which base ruleset does a save want? Old saves predate the field → Vanilla. */
export function baseRulesetForSave(game: GameInfo): BaseRulesetName {
  const wanted = game.gameParameters?.baseRuleset;
  if (wanted && (BASE_RULESETS as readonly string[]).includes(wanted)) {
    return wanted as BaseRulesetName;
  }
  return "Civ V - Vanilla";
}

function resolve<T>(ruleset: Ruleset, map: Map<string, T>, name: string): T | undefined {
  const def = map.get(name);
  if (def === undefined) ruleset.unresolved.add(name);
  return def;
}

export function resolveTerrain(rs: Ruleset, name: string): TerrainDef | undefined {
  return resolve(rs, rs.terrains, name);
}
export function resolveImprovement(rs: Ruleset, name: string): TileImprovementDef | undefined {
  return resolve(rs, rs.improvements, name);
}
export function resolveResource(rs: Ruleset, name: string): TileResourceDef | undefined {
  return resolve(rs, rs.resources, name);
}
export function resolveNation(rs: Ruleset, name: string): NationDef | undefined {
  return resolve(rs, rs.nations, name);
}
export function resolveUnit(rs: Ruleset, name: string): UnitDef | undefined {
  return resolve(rs, rs.units, name);
}

/**
 * A civ's current era: the era of its furthest-column researched tech.
 * Undefined when Techs.json is absent or nothing matches (very old saves).
 */
export function civEra(rs: Ruleset, techsResearched: string[] | undefined): string | undefined {
  let best: { era: string; column: number } | undefined;
  for (const t of techsResearched ?? []) {
    const info = rs.techInfo.get(t);
    if (info && (!best || info.column > best.column)) best = info;
  }
  return best?.era;
}

/** World wonders only — national wonders repeat per civ and aren't landmarks. */
export function isWorldWonder(rs: Ruleset, buildingName: string): boolean {
  return rs.buildings.get(buildingName)?.isWonder === true;
}

/** Is this unit name a military unit? (unitType → UnitTypes; civilians lack ranged/melee strength) */
export function isMilitaryUnit(rs: Ruleset, unitName: string): boolean {
  const unit = rs.units.get(unitName) as
    | (UnitDef & { strength?: number; rangedStrength?: number })
    | undefined;
  if (!unit) return false;
  return (unit.strength ?? 0) > 0 || (unit.rangedStrength ?? 0) > 0;
}
