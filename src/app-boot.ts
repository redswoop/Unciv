/**
 * Shared app bootstrap. Two entries use it:
 *  - main.ts: normal build, fetches save/ruleset/textures from public/
 *  - embedded-main.ts: single-file build with everything inlined (for
 *    artifact/offline distribution) — no network at all
 */

import * as THREE from "three";
import { loadSaveFromText } from "./save/load-save";
import type { GameInfo } from "./save/types";
import type { Ruleset } from "./ruleset/ruleset";
import { buildBoardModel } from "./render/board-model";
import { buildScene } from "./render/scene";
import { MapCameraControls } from "./render/camera-controls";
import { hexCornerVectors } from "./hex/hex-math";

export interface AppOptions {
  /** Raw text of the save to load on boot (wire format, not parsed). */
  initialSaveText(): Promise<string>;
  /** Resolve the ruleset a given save wants. */
  rulesetFor(game: GameInfo): Promise<Ruleset>;
  /** Optional texture resolver (embedded builds map file names to data URIs). */
  resolveTexture?: (file: string) => string;
}

export async function bootApp(opts: AppOptions): Promise<void> {
  const app = document.getElementById("app")!;
  const status = document.getElementById("status")!;
  const hud = document.getElementById("hud")!;

  let renderer: THREE.WebGLRenderer | null = null;
  let controls: MapCameraControls | null = null;
  let currentScene: THREE.Scene | null = null;

  async function show(game: GameInfo): Promise<void> {
    status.textContent = "Resolving ruleset…";
    const ruleset = await opts.rulesetFor(game);
    status.textContent = "Building board…";
    const model = buildBoardModel(game, ruleset, hexCornerVectors());
    const { scene, center, radius } = buildScene(model, opts.resolveTexture);

    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(window.innerWidth, window.innerHeight);
      app.appendChild(renderer.domElement);
    }
    currentScene = scene;
    controls = new MapCameraControls(
      renderer.domElement,
      window.innerWidth / window.innerHeight,
      center,
      radius,
    );
    // reproducible framing via URL: ?x=..&y=..&dist=..&tilt=..
    const q = new URLSearchParams(location.search);
    if (q.has("x")) controls.target.x = Number(q.get("x"));
    if (q.has("y")) controls.target.y = Number(q.get("y"));
    if (q.has("dist")) controls.distance = Number(q.get("dist"));
    if (q.has("tilt")) controls.tilt = Number(q.get("tilt"));
    controls.apply();

    // HUD
    hud.hidden = false;
    const civsWithCities = [...model.civColors.entries()].filter(([name]) =>
      model.cities.some((c) => c.civ === name),
    );
    document.getElementById("hud-title")!.textContent = `Turn ${model.turns}`;
    document.getElementById("hud-sub")!.textContent =
      `${model.tiles.length} tiles · ${model.cities.length} cities · ${model.units.length} units · ruleset: ${ruleset.name}`;
    document.getElementById("legend")!.innerHTML = civsWithCities
      .map(
        ([name, colors]) =>
          `<span><span class="sw" style="background: rgb(${colors.outer.join(",")})"></span>${name}</span>`,
      )
      .join("");
    if (ruleset.unresolved.size > 0) {
      console.warn("Unresolved ruleset names:", [...ruleset.unresolved]);
    }

    status.textContent = "";
    app.dataset.renderState = "ready";
  }

  function loop(): void {
    requestAnimationFrame(loop);
    if (renderer && controls && currentScene) {
      renderer.render(currentScene, controls.camera);
    }
  }

  window.addEventListener("resize", () => {
    if (!renderer || !controls) return;
    renderer.setSize(window.innerWidth, window.innerHeight);
    controls.camera.aspect = window.innerWidth / window.innerHeight;
    controls.camera.updateProjectionMatrix();
    controls.apply();
  });

  document.getElementById("file-input")!.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    app.dataset.renderState = "loading";
    status.textContent = "Parsing save…";
    try {
      await show(await loadSaveFromText(await file.text()));
    } catch (err) {
      status.textContent = `Failed: ${(err as Error).message}`;
      app.dataset.renderState = "error";
    }
  });

  try {
    const game = await loadSaveFromText(await opts.initialSaveText());
    await show(game);
    loop();
  } catch (err) {
    status.textContent = `Failed to load: ${(err as Error).message}`;
    app.dataset.renderState = "error";
    loop();
  }
}
