/**
 * Multi-tile "basic tiles good" view.
 *
 * Modes (URL):
 *   ?mode=gallery     — synthetic strip of all base terrains + hills/forest
 *   ?mode=chunk       — real save window (default), framed like the hero
 *   ?x=&y=&r=         — chunk center (world) + radius in hex steps (~)
 *
 * Uses Firaxis digimaps + piece heightmaps from public/textures/civ5/.
 */

import * as THREE from "three";
import { loadSaveFromText } from "./save/load-save";
import type { GameInfo } from "./save/types";
import { posX, posY, tileFeatures } from "./save/types";
import { hex2WorldCoords } from "./hex/hex-math";
import { MapCameraControls, syncCameraToUrl } from "./render/camera-controls";
import { Civ5TileKit, type Civ5TileSpec } from "./render/civ5-tiles";
import { attachHoverInspector } from "./render/hover-inspector";
import { HexRayPicker } from "./render/tile-picker";
import { mountSiteNav } from "./ui/site-nav";
import { specInfoHtml } from "./ui/tile-inspector";

const SAVE_URL = "saves/aztecs-turn0.unciv";

function status(msg: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
}

/** Synthetic gallery: compact grid of basic terrain types for side-by-side QA. */
function galleryTiles(): Civ5TileSpec[] {
  const types: { base: string; features: string[] }[] = [
    { base: "Grassland", features: [] },
    { base: "Grassland", features: ["Hill"] },
    { base: "Grassland", features: ["Forest"] },
    { base: "Grassland", features: ["Hill", "Forest"] },
    { base: "Plains", features: [] },
    { base: "Plains", features: ["Hill"] },
    { base: "Desert", features: [] },
    { base: "Desert", features: ["Hill"] },
    { base: "Tundra", features: [] },
    { base: "Mountain", features: [] },
    { base: "Coast", features: [] },
    { base: "Ocean", features: [] },
    { base: "Snow", features: [] },
    { base: "Marsh", features: [] },
    { base: "Grassland", features: ["Jungle"] },
  ];

  // Pack into Unciv hex coords on a tight brick (col → E, row → N)
  const cols = 5;
  return types.map((t, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const hex = { x: -col + row, y: col + row };
    return {
      world: hex2WorldCoords(hex),
      baseTerrain: t.base,
      features: t.features,
      key: `gallery-${i}-${t.base}-${t.features.join("+")}`,
    };
  });
}

/** Real-save chunk: tiles whose world pos is within radius of (cx, cy). */
function chunkFromSave(
  game: GameInfo,
  cx: number,
  cy: number,
  radius: number,
): Civ5TileSpec[] {
  const out: Civ5TileSpec[] = [];
  for (const tile of game.tileMap.tileList) {
    const hex = { x: posX(tile.position), y: posY(tile.position) };
    const world = hex2WorldCoords(hex);
    if (Math.hypot(world.x - cx, world.y - cy) > radius) continue;
    out.push({
      world,
      baseTerrain: tile.baseTerrain,
      features: tileFeatures(tile),
      key: `${hex.x},${hex.y}`,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const app = document.getElementById("app")!;
  const q = new URLSearchParams(location.search);
  const mode = q.get("mode") ?? "chunk";

  status("Loading assets…");
  const kit = new Civ5TileKit();
  await kit.init();

  let tiles: Civ5TileSpec[];
  let title = "Basic tiles";

  if (mode === "gallery") {
    tiles = galleryTiles();
    title = "Terrain gallery — Firaxis digimaps + height";
  } else {
    status("Loading save…");
    const text = await (await fetch(SAVE_URL)).text();
    const game = await loadSaveFromText(text);
    // default: densest forest cluster of the aztec reference world
    const cx = Number(q.get("x") ?? 7.5);
    const cy = Number(q.get("y") ?? 1);
    const r = Number(q.get("r") ?? 14);
    tiles = chunkFromSave(game, cx, cy, r);
    title = `Save chunk — ${tiles.length} tiles @ (${cx}, ${cy}) r=${r}`;
  }

  const hudTitle = document.getElementById("hud-title");
  const hudSub = document.getElementById("hud-sub");
  if (hudTitle) hudTitle.textContent = title;
  if (hudSub)
    hudSub.textContent = `${tiles.length} tiles · digimaps + piece heights · dense foliage`;
  mountSiteNav();

  status("Building meshes…");
  const terrain = await kit.buildTerrainMesh(tiles, { foliage: "detail" });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x5a7a92);
  // Fog kept distant + desaturated: real Civ5 stays warm at play zoom
  // (frame-capture comparison); blue fog at 28u was washing all foliage.
  scene.fog = new THREE.Fog(0x8fa0ac, 55, 140);
  scene.add(new THREE.AmbientLight(0xc8d4e0, 0.28));
  scene.add(new THREE.HemisphereLight(0xb8d0f0, 0x5a4a30, 0.48));
  const sun = new THREE.DirectionalLight(0xfff0d0, 1.55);
  sun.position.set(0.8, -0.55, 0.7).normalize();
  scene.add(sun);
  scene.add(terrain);

  // bounds → camera center
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of tiles) {
    minX = Math.min(minX, t.world.x);
    minY = Math.min(minY, t.world.y);
    maxX = Math.max(maxX, t.world.x);
    maxY = Math.max(maxY, t.world.y);
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const span = Math.max(maxX - minX, maxY - minY, 4);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  app.appendChild(renderer.domElement);

  const controls = new MapCameraControls(
    renderer.domElement,
    innerWidth / innerHeight,
    { x: centerX, y: centerY },
    span,
    {
      fov: 20,
      near: 0.05,
      far: 200,
      tilt: 0.92,
      distance: span * 1.6,
      minDistance: 0.9,
      maxDistance: span * 5,
      maxTilt: 1.15,
      lookAtZ: 0.1,
    },
  );
  // camera framing via URL — camx/camy because ?x=&y= already mean chunk center
  if (q.has("camx")) controls.target.x = Number(q.get("camx"));
  if (q.has("camy")) controls.target.y = Number(q.get("camy"));
  if (q.has("dist")) controls.distance = Number(q.get("dist"));
  if (q.has("tilt")) controls.tilt = Number(q.get("tilt"));
  controls.apply();
  syncCameraToUrl(controls, { xKey: "camx", yKey: "camy" });
  const camera = controls.camera;
  window.addEventListener("resize", () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    controls.apply();
  });

  // hover tile inspector, picked against the kit's rendered surface heights
  const picker = new HexRayPicker(tiles, (t, local) => kit.groundZ(t, local.x, local.y));
  attachHoverInspector({
    dom: renderer.domElement,
    camera: () => camera,
    picker: () => picker,
    html: specInfoHtml,
  });

  status("");
  app.dataset.renderState = "ready";
  const loop = () => {
    requestAnimationFrame(loop);
    renderer.render(scene, camera);
  };
  loop();
}

main().catch((err) => {
  status(`Failed: ${(err as Error).message}`);
  console.error(err);
  document.getElementById("app")!.dataset.renderState = "error";
});
