/**
 * Entry for the fully self-contained single-file build (artifact/offline).
 * Everything — the real save, the ruleset, every texture — is inlined at
 * build time; the page makes zero network requests.
 */

import { bootApp } from "./app-boot";
import { buildRuleset, baseRulesetForSave } from "./ruleset/ruleset";

import saveText from "../public/saves/aztecs-turn0.unciv?raw";

import vTerrains from "../public/rulesets/Civ V - Vanilla/Terrains.json?raw";
import vImprovements from "../public/rulesets/Civ V - Vanilla/TileImprovements.json?raw";
import vResources from "../public/rulesets/Civ V - Vanilla/TileResources.json?raw";
import vNations from "../public/rulesets/Civ V - Vanilla/Nations.json?raw";
import vUnits from "../public/rulesets/Civ V - Vanilla/Units.json?raw";
import vUnitTypes from "../public/rulesets/Civ V - Vanilla/UnitTypes.json?raw";

import gkTerrains from "../public/rulesets/Civ V - Gods & Kings/Terrains.json?raw";
import gkImprovements from "../public/rulesets/Civ V - Gods & Kings/TileImprovements.json?raw";
import gkResources from "../public/rulesets/Civ V - Gods & Kings/TileResources.json?raw";
import gkNations from "../public/rulesets/Civ V - Gods & Kings/Nations.json?raw";
import gkUnits from "../public/rulesets/Civ V - Gods & Kings/Units.json?raw";
import gkUnitTypes from "../public/rulesets/Civ V - Gods & Kings/UnitTypes.json?raw";

import grassland from "../public/textures/artful/grassland.png?inline";
import plains from "../public/textures/artful/plains.png?inline";
import desert from "../public/textures/artful/desert.png?inline";
import tundra from "../public/textures/artful/tundra.png?inline";
import snow from "../public/textures/artful/snow.png?inline";
import ocean from "../public/textures/artful/ocean.png?inline";
import coast from "../public/textures/artful/coast.png?inline";
import lakes from "../public/textures/artful/lakes.png?inline";
import mountain from "../public/textures/artful/mountain.png?inline";
import forest from "../public/textures/artful/forest.png?inline";
import jungle from "../public/textures/artful/jungle.png?inline";
import hill from "../public/textures/artful/hill.png?inline";
import marsh from "../public/textures/artful/marsh.png?inline";
import oasis from "../public/textures/artful/oasis.png?inline";
import ice from "../public/textures/artful/ice.png?inline";
import atoll from "../public/textures/artful/atoll.png?inline";
import floodPlains from "../public/textures/artful/flood-plains.png?inline";
import fallout from "../public/textures/artful/fallout.png?inline";

const TEXTURES: Record<string, string> = {
  "grassland.png": grassland,
  "plains.png": plains,
  "desert.png": desert,
  "tundra.png": tundra,
  "snow.png": snow,
  "ocean.png": ocean,
  "coast.png": coast,
  "lakes.png": lakes,
  "mountain.png": mountain,
  "forest.png": forest,
  "jungle.png": jungle,
  "hill.png": hill,
  "marsh.png": marsh,
  "oasis.png": oasis,
  "ice.png": ice,
  "atoll.png": atoll,
  "flood-plains.png": floodPlains,
  "fallout.png": fallout,
};

const RULESET_FILES = {
  "Civ V - Vanilla": {
    terrains: vTerrains,
    improvements: vImprovements,
    resources: vResources,
    nations: vNations,
    units: vUnits,
    unitTypes: vUnitTypes,
  },
  "Civ V - Gods & Kings": {
    terrains: gkTerrains,
    improvements: gkImprovements,
    resources: gkResources,
    nations: gkNations,
    units: gkUnits,
    unitTypes: gkUnitTypes,
  },
} as const;

await bootApp({
  initialSaveText: async () => saveText,
  rulesetFor: async (game) => {
    const name = baseRulesetForSave(game);
    return buildRuleset(name, RULESET_FILES[name]);
  },
  resolveTexture: (file) => TEXTURES[file] ?? file,
});
