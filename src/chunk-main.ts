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
import { Civ5TileKit, type Civ5TileSpec } from "./render/civ5-tiles";

const SAVE_URL = "saves/turn518-14civs.unciv";

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
    // default: Korea-ish framing from earlier work (world coords)
    const cx = Number(q.get("x") ?? -4.5);
    const cy = Number(q.get("y") ?? 12);
    const r = Number(q.get("r") ?? 14);
    tiles = chunkFromSave(game, cx, cy, r);
    title = `Save chunk — ${tiles.length} tiles @ (${cx}, ${cy}) r=${r}`;
  }

  const hudTitle = document.getElementById("hud-title");
  const hudSub = document.getElementById("hud-sub");
  if (hudTitle) hudTitle.textContent = title;
  if (hudSub)
    hudSub.textContent = `${tiles.length} tiles · digimaps + piece heightmaps · forest billboards`;

  status("Building meshes…");
  const terrain = await kit.buildTerrainMesh(tiles);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x5a7a92);
  scene.fog = new THREE.Fog(0x6a8aa0, 28, 70);
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

  const camera = new THREE.PerspectiveCamera(20, innerWidth / innerHeight, 0.1, 200);
  let target = new THREE.Vector2(centerX, centerY);
  let distance = span * 1.6;
  let tilt = 0.92;
  const applyCam = () => {
    camera.position.set(
      target.x,
      target.y - Math.sin(tilt) * distance,
      Math.cos(tilt) * distance,
    );
    camera.up.set(0, 1, 0);
    camera.lookAt(target.x, target.y, 0.1);
  };
  applyCam();

  let dragging: "pan" | "tilt" | null = null;
  let lastX = 0;
  let lastY = 0;
  const wpp = () => {
    const h = 2 * distance * Math.tan((camera.fov * Math.PI) / 360);
    return h / renderer.domElement.clientHeight;
  };
  renderer.domElement.addEventListener("pointerdown", (e) => {
    dragging = e.button === 2 ? "tilt" : "pan";
    lastX = e.clientX;
    lastY = e.clientY;
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (dragging === "pan") {
      const s = wpp();
      target.x -= dx * s;
      target.y += dy * s * Math.cos(tilt);
    } else {
      tilt = Math.min(1.15, Math.max(0.25, tilt + dy * 0.005));
    }
    applyCam();
  });
  window.addEventListener("pointerup", () => {
    dragging = null;
  });
  renderer.domElement.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      distance = Math.min(span * 5, Math.max(3, distance * Math.exp(e.deltaY * 0.001)));
      applyCam();
    },
    { passive: false },
  );
  renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("resize", () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
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
