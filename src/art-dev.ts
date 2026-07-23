/**
 * Dev sheet for the procedural on-terrain art (animals, minerals, plants,
 * sea life, improvement decals). Not linked from the site nav — open
 * /art.html on the dev server. Screenshot-driven iteration:
 *   bun run e2e/screenshot.ts http://127.0.0.1:5199/art.html /tmp/art.png
 */

import {
  drawAnimal,
  drawMineralSprite,
  drawCrabs,
  drawFieldDecal,
  drawFishSchool,
  drawImprovementDecal,
  drawMineralDecal,
  drawOilSeep,
  drawPearlBed,
  drawPlantSprite,
  drawWhale,
  type AnimalSpecies,
  type ImprovementDecalKind,
  type MineralKind,
  type PlantKind,
} from "./render/resource-terrain";

const app = document.getElementById("app")!;

function section(title: string): HTMLDivElement {
  const h = document.createElement("h3");
  h.textContent = title;
  app.appendChild(h);
  const row = document.createElement("div");
  row.className = "row";
  app.appendChild(row);
  return row;
}

function cell(row: HTMLDivElement, label: string, size: number, draw: (ctx: CanvasRenderingContext2D) => void): void {
  const div = document.createElement("div");
  div.className = "cell";
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  draw(c.getContext("2d")!);
  div.appendChild(c);
  const l = document.createElement("div");
  l.textContent = label;
  div.appendChild(l);
  row_append(row, div);
}

function row_append(row: HTMLDivElement, el: HTMLElement): void {
  row.appendChild(el);
}

{
  const row = section("Animals (side view, standing + grazing)");
  const species: AnimalSpecies[] = ["cow", "sheep", "horse", "deer", "bison", "elephant"];
  for (const s of species) {
    cell(row, s, 128, (ctx) => drawAnimal(ctx, s, 128, 128, false));
    cell(row, `${s} grazing`, 128, (ctx) => drawAnimal(ctx, s, 128, 128, true));
  }
}

{
  const row = section("Minerals");
  const kinds: MineralKind[] = [
    "stone", "marble", "iron", "coal", "copper", "salt",
    "gold", "silver", "gems", "aluminum", "uranium",
  ];
  for (const k of kinds) cell(row, k, 160, (ctx) => drawMineralSprite(ctx, k, 160, 160, 3));
}

{
  const row = section("Plant sprites");
  const kinds: PlantKind[] = ["banana", "citrus", "cocoa", "silk", "sugar", "spices", "incense"];
  for (const k of kinds) cell(row, k, 128, (ctx) => drawPlantSprite(ctx, k, 128, 128, 1));
}

{
  const row = section("Field decals");
  const kinds: PlantKind[] = ["wine", "cotton", "dyes", "truffles"];
  for (const k of kinds) cell(row, k, 160, (ctx) => drawFieldDecal(ctx, k, 160, 7));
}

{
  const row = section("Sea + oil");
  cell(row, "fish school", 160, (ctx) => drawFishSchool(ctx, 160));
  cell(row, "whale", 160, (ctx) => drawWhale(ctx, 160));
  cell(row, "pearls", 160, (ctx) => drawPearlBed(ctx, 160));
  cell(row, "crabs", 160, (ctx) => drawCrabs(ctx, 160));
  cell(row, "oil seep", 160, (ctx) => drawOilSeep(ctx, 160));
}

{
  const row = section("Improvement decals");
  const kinds: ImprovementDecalKind[] = ["pasture", "mine", "quarry", "camp"];
  for (const k of kinds) cell(row, k, 160, (ctx) => drawImprovementDecal(ctx, k, 160, 2));
}

app.dataset.renderState = "ready";
