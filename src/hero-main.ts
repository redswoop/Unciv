/**
 * Hero tile lab: one perfect-ish Civ5 hex.
 *
 * Current target: **Plains + Forest** — open plains digimap under a dense
 * stand of trees (a bunch of trees filling the hex, not a couple of props).
 * Neighbours are bare plains for contrast.
 */

import * as THREE from "three";
import {
  getClockPositionToHexcoord,
  hex2WorldCoords,
  NEIGHBOR_CLOCK_POSITIONS,
} from "./hex/hex-math";
import { MapCameraControls, syncCameraToUrl } from "./render/camera-controls";
import { Civ5TileKit, type Civ5TileSpec } from "./render/civ5-tiles";
import { attachHoverInspector } from "./render/hover-inspector";
import { HexRayPicker } from "./render/tile-picker";
import { mountSiteNav } from "./ui/site-nav";
import { specInfoHtml } from "./ui/tile-inspector";

async function main(): Promise<void> {
  const app = document.getElementById("app")!;
  const status = document.getElementById("status")!;

  try {
    status.textContent = "Loading Civ5 assets…";
    const kit = new Civ5TileKit();
    await kit.init();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x7a94a8);
    scene.fog = new THREE.Fog(0x8aa4b8, 5, 16);

    scene.add(new THREE.AmbientLight(0xd0dce8, 0.4));
    scene.add(new THREE.HemisphereLight(0xc4daf0, 0x6a5a38, 0.52));
    const sun = new THREE.DirectionalLight(0xfff2dc, 1.3);
    sun.position.set(0.75, -0.55, 0.75).normalize();
    scene.add(sun);

    status.textContent = "Building plains forest…";

    // Center: flat plains + forest. Neighbours: bare plains (contrast).
    const tiles: Civ5TileSpec[] = [
      {
        world: hex2WorldCoords({ x: 0, y: 0 }),
        baseTerrain: "Plains",
        features: ["Forest"],
        key: "hero-plains-forest",
      },
    ];
    NEIGHBOR_CLOCK_POSITIONS.forEach((clock, i) => {
      const d = getClockPositionToHexcoord(clock);
      tiles.push({
        world: hex2WorldCoords({ x: d.x, y: d.y }),
        baseTerrain: "Plains",
        features: [],
        key: `hero-plain-n-${i}`,
      });
    });

    const terrain = await kit.buildTerrainMesh(tiles, { divs: 28, foliage: "hero" });
    scene.add(terrain);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    app.appendChild(renderer.domElement);

    const controls = new MapCameraControls(
      renderer.domElement,
      innerWidth / innerHeight,
      { x: 0, y: 0 },
      4,
      {
        fov: 22,
        near: 0.03,
        far: 100,
        tilt: 0.8,
        // Slightly pulled back so the full tree stand reads as a mass
        distance: 4.6,
        minDistance: 0.7,
        maxDistance: 12,
        maxTilt: 1.15,
        lookAtZ: 0.15,
      },
    );
    const q = new URLSearchParams(location.search);
    if (q.has("x")) controls.target.x = Number(q.get("x"));
    if (q.has("y")) controls.target.y = Number(q.get("y"));
    if (q.has("dist")) controls.distance = Number(q.get("dist"));
    if (q.has("tilt")) controls.tilt = Number(q.get("tilt"));
    controls.apply();
    syncCameraToUrl(controls);
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

    status.textContent = "";
    mountSiteNav();
    app.dataset.renderState = "ready";

    const loop = () => {
      requestAnimationFrame(loop);
      renderer.render(scene, camera);
    };
    loop();
  } catch (err) {
    status.textContent = `Failed: ${(err as Error).message}. Run: python3 cli/extract-civ5-assets.py`;
    app.dataset.renderState = "error";
    console.error(err);
  }
}

main();
