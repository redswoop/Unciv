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
import { Civ5TileKit, type Civ5TileSpec } from "./render/civ5-tiles";
import { mountSiteNav } from "./ui/site-nav";

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

    const camera = new THREE.PerspectiveCamera(22, innerWidth / innerHeight, 0.03, 100);
    let target = new THREE.Vector2(0, 0);
    // Slightly pulled back so the full tree stand reads as a mass
    let distance = 4.6;
    let tilt = 0.8;
    const applyCam = () => {
      camera.position.set(
        target.x,
        target.y - Math.sin(tilt) * distance,
        Math.cos(tilt) * distance,
      );
      camera.up.set(0, 1, 0);
      camera.lookAt(target.x, target.y, 0.15);
    };
    applyCam();

    let dragging: "pan" | "tilt" | null = null;
    let lastX = 0;
    let lastY = 0;
    const worldPerPixel = () => {
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
        const s = worldPerPixel();
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
        distance = Math.min(12, Math.max(0.7, distance * Math.exp(e.deltaY * 0.001)));
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
