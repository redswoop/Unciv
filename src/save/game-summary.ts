/**
 * Text summary of a parsed save — the Phase 0 "done when" check:
 * tile count, civ list, city list, plus terrain/unit histograms that
 * double as input for auditing asset-map coverage.
 */

import {
  type GameInfo,
  type CivilizationData,
  posKey,
  tileFeatures,
} from "./types";

export interface GameSummary {
  turns: number;
  mapDescription: string;
  tileCount: number;
  terrainCounts: Map<string, number>;
  featureCounts: Map<string, number>;
  resourceCounts: Map<string, number>;
  improvementCounts: Map<string, number>;
  civs: {
    name: string;
    playerType: string;
    cities: { name: string; pos: string; pop: number }[];
    ownedTileCount: number;
  }[];
  unitCounts: Map<string, number>;
  totalUnits: number;
  naturalWonders: string[];
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function civDisplayName(civ: CivilizationData): string {
  return civ.civName ?? civ.civID ?? "?";
}

export function summarizeGame(game: GameInfo): GameSummary {
  const terrainCounts = new Map<string, number>();
  const featureCounts = new Map<string, number>();
  const resourceCounts = new Map<string, number>();
  const improvementCounts = new Map<string, number>();
  const unitCounts = new Map<string, number>();
  const naturalWonders = new Set<string>();
  let totalUnits = 0;

  for (const tile of game.tileMap.tileList) {
    bump(terrainCounts, tile.baseTerrain);
    for (const f of tileFeatures(tile)) bump(featureCounts, f);
    if (tile.resource) bump(resourceCounts, tile.resource);
    if (tile.improvement) bump(improvementCounts, tile.improvement);
    if (tile.naturalWonder) naturalWonders.add(tile.naturalWonder);
    const units = [tile.militaryUnit, tile.civilianUnit, ...(tile.airUnits ?? [])];
    for (const u of units) {
      if (!u?.name) continue;
      totalUnits++;
      bump(unitCounts, u.name);
    }
  }

  const civs = game.civilizations.map((civ) => ({
    name: civDisplayName(civ),
    playerType: civ.playerType ?? "AI",
    cities: (civ.cities ?? []).map((c) => ({
      name: c.name ?? "?",
      pos: posKey(c.location),
      pop: c.population?.population ?? 1,
    })),
    ownedTileCount: (civ.cities ?? []).reduce(
      (n, c) => n + (c.tiles?.length ?? 0),
      0,
    ),
  }));

  const mp = game.tileMap.mapParameters;
  const size = mp?.mapSize;
  const mapDescription = [
    mp?.type ?? "unknown-type",
    size?.name,
    size?.radius !== undefined ? `radius ${size.radius}` : undefined,
    mp?.worldWrap ? "world-wrap" : undefined,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    turns: game.turns ?? 0,
    mapDescription,
    tileCount: game.tileMap.tileList.length,
    terrainCounts,
    featureCounts,
    resourceCounts,
    improvementCounts,
    civs,
    unitCounts,
    totalUnits,
    naturalWonders: [...naturalWonders].sort(),
  };
}

function topEntries(map: Map<string, number>, n = 100): string {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `    ${k}: ${v}`)
    .join("\n");
}

export function formatSummary(s: GameSummary): string {
  const lines: string[] = [];
  lines.push(`Turn ${s.turns} — ${s.mapDescription}`);
  lines.push(`Tiles: ${s.tileCount}`);
  lines.push(`Natural wonders: ${s.naturalWonders.join(", ") || "none"}`);
  lines.push(`\nTerrain:\n${topEntries(s.terrainCounts)}`);
  lines.push(`\nFeatures:\n${topEntries(s.featureCounts)}`);
  lines.push(`\nResources:\n${topEntries(s.resourceCounts)}`);
  lines.push(`\nImprovements:\n${topEntries(s.improvementCounts)}`);
  const civsWithCities = s.civs.filter((c) => c.cities.length > 0);
  const others = s.civs.filter((c) => c.cities.length === 0);
  lines.push(`\nCivilizations (${s.civs.length} total, ${civsWithCities.length} with cities):`);
  for (const civ of civsWithCities) {
    lines.push(
      `  ${civ.name} [${civ.playerType}] — ${civ.cities.length} cities, ${civ.ownedTileCount} tiles`,
    );
    for (const city of civ.cities) {
      lines.push(`      ${city.name} @ (${city.pos}) pop ${city.pop}`);
    }
  }
  if (others.length > 0) {
    lines.push(`  (cityless: ${others.map((c) => c.name).join(", ")})`);
  }
  lines.push(`\nUnits: ${s.totalUnits}\n${topEntries(s.unitCounts, 15)}`);
  return lines.join("\n");
}
