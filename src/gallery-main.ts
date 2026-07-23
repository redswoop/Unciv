/**
 * Art galleries (/gallery.html): every resource on its home terrain, cities
 * across eras × sizes, natural wonders, improvements — side-by-side QA sheets
 * for the on-map art, rendered with the same kit as the real map.
 *
 * Modes (URL ?mode=):
 *   resources     each ruleset resource on the first terrain it can be found on
 *   cities        era styles × population sizes (+ wonder landmark demo)
 *   wonders       every mapped natural wonder on its ruleset terrain
 *   improvements  improvement decals/pads on fitting terrain
 */

import * as THREE from "three";
import { MapCameraControls, syncCameraToUrl } from "./render/camera-controls";
import { Civ5TileKit, type Civ5TileSpec } from "./render/civ5-tiles";
import {
  buildImprovementDecals,
  buildNaturalWonderArt,
  buildResourceBubbles,
  type OverlayTile,
} from "./render/civ5-overlays";
import { buildResourceTerrainArt } from "./render/resource-terrain";
import { buildCityMeshes, type CitySite, type EraStyle } from "./render/city-mesh";
import type { CityMarker } from "./render/board-model";
import { fetchRuleset, type Ruleset, type TerrainDef } from "./ruleset/ruleset";
import assetMap from "./render/asset-map.json";
import { mountSiteNav } from "./ui/site-nav";

type Mode = "resources" | "cities" | "wonders" | "improvements";

const q = new URLSearchParams(location.search);
const mode = (q.get("mode") ?? "resources") as Mode;

function status(msg: string): void {
  document.getElementById("status")!.textContent = msg;
}

interface Entry {
  label: string;
  spec: Civ5TileSpec;
  overlay: OverlayTile;
}

/** Where can this thing stand? Resolve a ruleset terrain list to base+features. */
function siteFor(
  ruleset: Ruleset,
  names: string[] | undefined,
  fallback: string,
): { base: string; features: string[] } {
  for (const name of names ?? []) {
    const def: TerrainDef | undefined = ruleset.terrains.get(name);
    if (!def) continue;
    if (def.type === "TerrainFeature") {
      const feats = [name];
      // hills stack under forest visually; keep single feature + Hill only for Hill
      return { base: "Grassland", features: name === "Hill" ? ["Hill"] : feats };
    }
    if (def.type === "Land" || def.type === "Water") {
      return { base: name, features: [] };
    }
  }
  return { base: fallback, features: [] };
}

function labelSprite(text: string, x: number, y: number, z: number): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 96;
  const ctx = c.getContext("2d")!;
  ctx.font = "bold 44px Georgia, serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(8,12,20,0.9)";
  ctx.strokeText(text, 256, 48, 500);
  ctx.fillStyle = "#f3ead2";
  ctx.fillText(text, 256, 48, 500);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }),
  );
  sprite.renderOrder = 20;
  sprite.position.set(x, y, z);
  sprite.scale.set(2.1, 0.39, 1);
  return sprite;
}

async function main(): Promise<void> {
  const app = document.getElementById("app")!;

  // mode links
  const modesEl = document.getElementById("modes")!;
  modesEl.innerHTML = (["resources", "cities", "wonders", "improvements"] as Mode[])
    .map((m) => `<a href="/gallery.html?mode=${m}" class="${m === mode ? "active" : ""}">${m}</a>`)
    .join("");
  mountSiteNav();

  status("Loading ruleset + assets…");
  const ruleset = await fetchRuleset("Civ V - Gods & Kings");
  const kit = new Civ5TileKit();
  await kit.init();

  const entries: Entry[] = [];
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x21374f);
  scene.fog = new THREE.Fog(0x2c4258, 60, 160);

  const COLS = mode === "cities" ? 6 : 6;
  const DX = 3.0;
  const DY = 3.4;
  const place = (i: number): { x: number; y: number } => ({
    x: (i % COLS) * DX,
    y: -Math.floor(i / COLS) * DY,
  });

  const civ5 = assetMap.civ5 as {
    naturalWonders: Record<string, { file: string; mode: string; scale: number }>;
    resourceBubbles: Record<string, string>;
    improvementDecals: Record<string, unknown>;
  };

  if (mode === "resources") {
    document.getElementById("hud-title")!.textContent = "Resource gallery";
    let i = 0;
    for (const [name, def] of ruleset.resources) {
      // city-made trade goods (Jewelry, Porcelain) never appear on tiles
      if (!def.terrainsCanBeFoundOn?.length) continue;
      const { x, y } = place(i++);
      const site = siteFor(ruleset, def.terrainsCanBeFoundOn, "Grassland");
      const key = `g-res-${name}`;
      entries.push({
        label: name,
        spec: {
          world: { x, y },
          baseTerrain: site.base,
          features: site.features,
          key,
          clearBubble: true,
          clearCenter: true,
        },
        overlay: {
          world: { x, y },
          key,
          baseTerrain: site.base,
          features: site.features,
          resource: name,
        },
      });
    }
  } else if (mode === "wonders") {
    document.getElementById("hud-title")!.textContent = "Natural wonders";
    let i = 0;
    for (const name of Object.keys(civ5.naturalWonders)) {
      if (name === "*") continue;
      const { x, y } = place(i++);
      const def = ruleset.terrains.get(name);
      const site = siteFor(
        ruleset,
        def?.occursOn ?? (def?.turnsInto ? [def.turnsInto] : undefined),
        "Mountain",
      );
      const key = `g-won-${name}`;
      entries.push({
        label: name,
        spec: {
          world: { x, y },
          baseTerrain: site.base,
          features: [],
          key,
          suppressPiece: true,
        },
        overlay: {
          world: { x, y },
          key,
          baseTerrain: site.base,
          features: [],
          naturalWonder: name,
        },
      });
    }
  } else if (mode === "improvements") {
    document.getElementById("hud-title")!.textContent = "Improvements";
    const IMPROVEMENTS: [string, string, string[]][] = [
      ["Farm", "Grassland", []],
      ["Mine", "Grassland", ["Hill"]],
      ["Pasture", "Grassland", []],
      ["Camp", "Plains", ["Forest"]],
      ["Quarry", "Desert", ["Hill"]],
      ["Lumber mill", "Grassland", ["Forest"]],
      ["Trading post", "Plains", []],
      ["Fort", "Plains", []],
      ["Academy", "Grassland", []],
      ["Citadel", "Plains", []],
      ["Customs house", "Grassland", []],
      ["Manufactory", "Plains", []],
      ["Landmark", "Grassland", []],
      ["Oil well", "Tundra", []],
    ];
    IMPROVEMENTS.forEach(([name, base, features], i) => {
      const { x, y } = place(i);
      const key = `g-imp-${name}`;
      entries.push({
        label: name,
        spec: {
          world: { x, y },
          baseTerrain: base,
          features,
          key,
          clearCenter: true,
        },
        overlay: { world: { x, y }, key, baseTerrain: base, features, improvement: name },
      });
    });
  } else {
    document.getElementById("hud-title")!.textContent = "Cities — era × size";
    const styles: EraStyle[] = [
      "ancient",
      "classical",
      "medieval",
      "renaissance",
      "industrial",
      "modern",
    ];
    const pops = [2, 6, 12, 22];
    let i = 0;
    for (const pop of pops) {
      for (const style of styles) {
        const { x, y } = place(i++);
        const key = `g-city-${style}-${pop}`;
        entries.push({
          label: `${style} · pop ${pop}${pop === 22 ? " · wonders" : ""}`,
          spec: { world: { x, y }, baseTerrain: "Grassland", features: [], key },
          overlay: { world: { x, y }, key, baseTerrain: "Grassland", features: [] },
        });
      }
    }
  }

  status("Building terrain…");
  const specs = entries.map((e) => e.spec);
  const specByKey = new Map(specs.map((s) => [s.key, s]));
  const terrain = await kit.buildTerrainMesh(specs, { foliage: "detail" });
  scene.add(terrain);

  const groundZ = (t: OverlayTile, lx: number, ly: number): number =>
    kit.groundZ(specByKey.get(t.key)!, lx, ly);
  const overlays = entries.map((e) => e.overlay);

  status("Building art…");
  const timeUniforms: { value: number }[] = [];
  let bubbleUpdate: ((cam: THREE.PerspectiveCamera, h: number) => void) | null = null;

  if (mode === "resources") {
    const [bubbles, art] = await Promise.all([
      buildResourceBubbles(overlays, groundZ),
      buildResourceTerrainArt(overlays, groundZ, {
        wheatDecalUrl: "textures/civ5/decal/wheat_farm_d.png",
      }),
    ]);
    scene.add(bubbles.layer.group);
    scene.add(art.group);
    bubbleUpdate = (cam, h) => bubbles.layer.update(cam, h);
    timeUniforms.push(...art.timeUniforms);
  } else if (mode === "wonders") {
    scene.add(await buildNaturalWonderArt(overlays, groundZ));
  } else if (mode === "improvements") {
    const [decals, art] = await Promise.all([
      buildImprovementDecals(overlays, groundZ),
      buildResourceTerrainArt(overlays, groundZ, {}),
    ]);
    scene.add(decals);
    scene.add(art.group);
    timeUniforms.push(...art.timeUniforms);
  } else {
    const styles: Record<string, EraStyle> = {};
    const sites: CitySite[] = entries.map((e) => {
      const style = e.spec.key.split("-")[2] as EraStyle;
      styles[e.spec.key] = style;
      const pop = Number(e.spec.key.split("-")[3]);
      const marker: CityMarker = {
        world: e.spec.world,
        key: e.spec.key,
        name: "",
        civ: "gallery",
        population: pop,
        z: 0.02,
        era: undefined,
        eraT: 0,
        wonders: pop === 22 ? ["W1", "W2", "W3"] : [],
        capital: false,
      };
      return {
        marker,
        style,
        groundZ: (lx: number, ly: number) => kit.groundZ(e.spec, lx, ly),
      };
    });
    scene.add(buildCityMeshes(sites));
  }

  // labels
  for (const e of entries) {
    scene.add(labelSprite(e.label, e.spec.world.x, e.spec.world.y - 1.35, 0.3));
  }

  // lights (match chunk demo)
  scene.add(new THREE.AmbientLight(0xc8d4e0, 0.28));
  scene.add(new THREE.HemisphereLight(0xb8d0f0, 0x5a4a30, 0.48));
  const sun = new THREE.DirectionalLight(0xfff0d0, 1.55);
  sun.position.set(0.8, -0.55, 0.7).normalize();
  scene.add(sun);

  const rows = Math.ceil(entries.length / COLS);
  const centerX = ((COLS - 1) * DX) / 2;
  const centerY = -((rows - 1) * DY) / 2;
  const span = Math.max(COLS * DX, rows * DY, 6);

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
    span / 2,
    {
      fov: 20,
      near: 0.05,
      far: 220,
      tilt: 0.62,
      distance: span * 1.6,
      minDistance: 1.2,
      maxDistance: span * 4,
      maxTilt: 1.2,
      lookAtZ: 0.05,
    },
  );
  if (q.has("camx")) controls.target.x = Number(q.get("camx"));
  if (q.has("camy")) controls.target.y = Number(q.get("camy"));
  if (q.has("dist")) controls.distance = Number(q.get("dist"));
  if (q.has("tilt")) controls.tilt = Number(q.get("tilt"));
  controls.apply();
  syncCameraToUrl(controls, { xKey: "camx", yKey: "camy" });

  window.addEventListener("resize", () => {
    renderer.setSize(innerWidth, innerHeight);
    controls.camera.aspect = innerWidth / innerHeight;
    controls.camera.updateProjectionMatrix();
    controls.apply();
  });

  status("");
  app.dataset.renderState = "ready";
  const loop = () => {
    requestAnimationFrame(loop);
    const t = (performance.now() % 3600000) / 1000;
    for (const u of timeUniforms) u.value = t;
    bubbleUpdate?.(controls.camera, renderer.domElement.clientHeight);
    renderer.render(scene, controls.camera);
  };
  loop();
}

main().catch((err) => {
  status(`Failed: ${(err as Error).message}`);
  console.error(err);
  document.getElementById("app")!.dataset.renderState = "error";
});
