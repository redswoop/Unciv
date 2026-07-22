/**
 * Single-tile hero: render ONE Firaxis grassland-hill hex as faithfully as
 * we can with extracted Civ5 assets (digimap + per-tile height + tree atlas).
 *
 * Assets live in public/textures/civ5/ (gitignored — extract from local Steam
 * install via cli/extract-civ5-assets.py).
 */

import * as THREE from "three";
import { hexCornerVectors } from "./hex/hex-math";

const ALBEDO = "textures/civ5/euro_grassland_d.png";
const HEIGHT = "textures/civ5/grass_hill_01_h.png";
const FOREST = "textures/civ5/forest_europe.png";

/** Civ5 piece H is R8; borders sit near 60, peaks higher. */
const H_BASE = 60;
const H_SCALE = 0.72; // world-z units at max (255-60)
/** Subdivision density for smooth height-mapped surface. */
const DIVS = 48;

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

function sampleR8(data: Uint8ClampedArray, w: number, h: number, u: number, v: number): number {
  // u,v in [0,1], v flipped for image space
  const x = Math.min(w - 1, Math.max(0, u * (w - 1)));
  const y = Math.min(h - 1, Math.max(0, (1 - v) * (h - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (ix: number, iy: number) => data[(iy * w + ix) * 4]!; // R channel
  const a = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const b = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return a * (1 - fy) + b * fy;
}

function heightFromSample(raw: number): number {
  return (Math.max(0, raw - H_BASE) / (255 - H_BASE)) * H_SCALE;
}

/** Local hex offset → UV covering the circumradius-1 hex in [0,1]². */
function localToUV(lx: number, ly: number): [number, number] {
  // point-to-point diameter = 2
  return [lx * 0.5 + 0.5, ly * 0.5 + 0.5];
}

function buildHeightmappedHex(
  corners: { x: number; y: number }[],
  heightData: Uint8ClampedArray,
  hw: number,
  hh: number,
  divs: number,
): THREE.BufferGeometry {
  const tPer = 6 * divs * divs;
  const positions = new Float32Array(tPer * 9);
  const uvs = new Float32Array(tPer * 6);
  const normals = new Float32Array(tPer * 9);
  let p = 0;
  let u = 0;

  const heightAt = (lx: number, ly: number): number => {
    const [uu, vv] = localToUV(lx, ly);
    return heightFromSample(sampleR8(heightData, hw, hh, uu, vv));
  };

  const push = (lx: number, ly: number) => {
    const z = heightAt(lx, ly);
    positions[p++] = lx;
    positions[p++] = ly;
    positions[p++] = z;
    const [uu, vv] = localToUV(lx, ly);
    uvs[u++] = uu;
    uvs[u++] = vv;
  };

  for (let s = 0; s < 6; s++) {
    const a = corners[s]!;
    const b = corners[(s + 1) % 6]!;
    const point = (i: number, j: number): [number, number] => {
      const lx = (i * a.x + j * b.x) / divs;
      const ly = (i * a.y + j * b.y) / divs;
      return [lx, ly];
    };
    for (let i = 0; i < divs; i++) {
      for (let j = 0; j < divs - i; j++) {
        {
          const [x0, y0] = point(i, j);
          const [x1, y1] = point(i, j + 1);
          const [x2, y2] = point(i + 1, j);
          push(x0, y0);
          push(x1, y1);
          push(x2, y2);
        }
        if (j < divs - i - 1) {
          const [x0, y0] = point(i + 1, j);
          const [x1, y1] = point(i, j + 1);
          const [x2, y2] = point(i + 1, j + 1);
          push(x0, y0);
          push(x1, y1);
          push(x2, y2);
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  // silence unused
  void normals;
  return geo;
}

/**
 * Crop individual trees from the forest atlas into their own canvas textures.
 * Atlas is ~4×4 tree sprites on a solid green sheet — flood-fill from the
 * cell border so foliage greens stay intact (chroma-key was eating leaves).
 */
function cropForestFrames(img: HTMLImageElement): THREE.Texture[] {
  const cols = 4;
  const rows = 4;
  const fw = Math.floor(img.width / cols);
  const fh = Math.floor(img.height / rows);
  const frames: THREE.Texture[] = [];
  const isSheet = (r: number, g: number, b: number) => {
    // sheet is a flat olive green (~57,71,41); foliage is more varied
    const dr = r - 57;
    const dg = g - 71;
    const db = b - 41;
    const dist = dr * dr + dg * dg + db * db;
    // also treat near-uniform dark-green cells as sheet
    const maxc = Math.max(r, g, b);
    const minc = Math.min(r, g, b);
    return dist < 450 || (g > r + 8 && g > b + 8 && maxc - minc < 35 && g < 100);
  };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const canvas = document.createElement("canvas");
      canvas.width = fw;
      canvas.height = fh;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, col * fw, row * fh, fw, fh, 0, 0, fw, fh);
      const id = ctx.getImageData(0, 0, fw, fh);
      const d = id.data;
      const N = fw * fh;
      const seen = new Uint8Array(N);
      const q: number[] = [];
      const push = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= fw || y >= fh) return;
        const i = y * fw + x;
        if (seen[i]) return;
        const o = i * 4;
        if (!isSheet(d[o]!, d[o + 1]!, d[o + 2]!)) return;
        seen[i] = 1;
        q.push(i);
      };
      // seed flood from all border pixels
      for (let x = 0; x < fw; x++) {
        push(x, 0);
        push(x, fh - 1);
      }
      for (let y = 0; y < fh; y++) {
        push(0, y);
        push(fw - 1, y);
      }
      while (q.length) {
        const i = q.pop()!;
        const x = i % fw;
        const y = (i / fw) | 0;
        d[i * 4 + 3] = 0;
        push(x + 1, y);
        push(x - 1, y);
        push(x, y + 1);
        push(x, y - 1);
      }
      let opaque = 0;
      for (let i = 0; i < N; i++) if (d[i * 4 + 3]! > 10) opaque++;
      if (opaque < N * 0.04) continue;
      ctx.putImageData(id, 0, 0);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      frames.push(tex);
    }
  }
  return frames;
}

/** Scatter tree billboards on the hill from cropped forest frames. */
function addTrees(
  scene: THREE.Scene,
  forestFrames: THREE.Texture[],
  heightData: Uint8ClampedArray,
  hw: number,
  hh: number,
  corners: { x: number; y: number }[],
): void {
  if (forestFrames.length === 0) return;
  const rng = (s: number) => {
    let h = Math.imul(s ^ 0x9e3779b9, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
  };

  const count = 12;
  for (let n = 0; n < count; n++) {
    const r1 = rng(n * 17 + 3);
    const r2 = rng(n * 31 + 7);
    const r3 = rng(n * 53 + 11);
    const sector = Math.floor(r1 * 6);
    const a = corners[sector]!;
    const b = corners[(sector + 1) % 6]!;
    const t = 0.12 + r2 * 0.72;
    const s = r3 * (1 - t) * 0.8;
    const lx = t * a.x + s * b.x;
    const ly = t * a.y + s * b.y;
    const [uu, vv] = localToUV(lx, ly);
    const z = heightFromSample(sampleR8(heightData, hw, hh, uu, vv));

    const tex = forestFrames[n % forestFrames.length]!;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      alphaTest: 0.2,
    });
    const sprite = new THREE.Sprite(mat);
    const scale = 0.32 + rng(n * 41) * 0.2;
    sprite.scale.set(scale * 0.85, scale, 1);
    sprite.position.set(lx, ly, z + scale * 0.42);
    scene.add(sprite);
  }
}

async function main(): Promise<void> {
  const app = document.getElementById("app")!;
  const status = document.getElementById("status")!;

  try {
    const [albedoImg, heightImg, forestImg] = await Promise.all([
      loadImage(ALBEDO),
      loadImage(HEIGHT),
      loadImage(FOREST),
    ]);

    // bake height to pixel buffer
    const hCanvas = document.createElement("canvas");
    hCanvas.width = heightImg.width;
    hCanvas.height = heightImg.height;
    const hctx = hCanvas.getContext("2d")!;
    hctx.drawImage(heightImg, 0, 0);
    const heightData = hctx.getImageData(0, 0, heightImg.width, heightImg.height).data;

    const scene = new THREE.Scene();
    // soft Civ5-ish sky (reference shot has cool gray-blue atmosphere)
    scene.background = new THREE.Color(0x7a94a8);
    scene.fog = new THREE.Fog(0x8aa4b8, 4, 14);

    // lighting: warm key, cool fill — match reference
    scene.add(new THREE.AmbientLight(0xc8d4e0, 0.35));
    const hemi = new THREE.HemisphereLight(0xb8d0f0, 0x5a4a30, 0.55);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff0d0, 1.35);
    sun.position.set(0.8, -0.6, 0.7).normalize();
    scene.add(sun);

    const corners = hexCornerVectors();
    const geo = buildHeightmappedHex(corners, heightData, heightImg.width, heightImg.height, DIVS);

    const loader = new THREE.TextureLoader();
    const albedo = loader.load(ALBEDO);
    albedo.colorSpace = THREE.SRGBColorSpace;
    albedo.anisotropy = 8;
    // slight wrap so edges don't pin
    albedo.wrapS = albedo.wrapT = THREE.MirroredRepeatWrapping;

    const mat = new THREE.MeshLambertMaterial({ map: albedo });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);

    // subtle hex outline (Civ5 has faint dark edges)
    const edgePts: number[] = [];
    for (let i = 0; i <= 6; i++) {
      const c = corners[i % 6]!;
      const [uu, vv] = localToUV(c.x, c.y);
      const z = heightFromSample(sampleR8(heightData, heightImg.width, heightImg.height, uu, vv)) + 0.01;
      edgePts.push(c.x, c.y, z);
    }
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.Float32BufferAttribute(edgePts, 3));
    scene.add(
      new THREE.Line(
        edgeGeo,
        new THREE.LineBasicMaterial({ color: 0x2a3020, transparent: true, opacity: 0.45 }),
      ),
    );

    // Tree billboards disabled — atlas cutouts produced floating green cards.
    // Canopy can come back via hex-draped overlay or .gr2 models later.
    void forestImg;
    void cropForestFrames;
    void addTrees;

    // surrounding soft ground (reads as neighboring grassland, not green void)
    const groundMat = new THREE.MeshLambertMaterial({ map: albedo });
    const ground = new THREE.Mesh(new THREE.CircleGeometry(8, 64), groundMat);
    ground.position.z = -0.04;
    // stretch UVs so digimap tiles at world scale
    const guv = ground.geometry.attributes.uv!;
    for (let i = 0; i < guv.count; i++) {
      guv.setXY(i, guv.getX(i) * 4, guv.getY(i) * 4);
    }
    scene.add(ground);

    // camera
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    app.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(22, innerWidth / innerHeight, 0.05, 100);
    let target = new THREE.Vector2(0, 0);
    let distance = 4.2;
    let tilt = 0.95;
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

    // controls
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
    renderer.domElement.addEventListener("wheel", (e) => {
      e.preventDefault();
      distance = Math.min(12, Math.max(1.5, distance * Math.exp(e.deltaY * 0.001)));
      applyCam();
    }, { passive: false });
    renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

    window.addEventListener("resize", () => {
      renderer.setSize(innerWidth, innerHeight);
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
    });

    status.textContent = "";
    app.dataset.renderState = "ready";

    const loop = () => {
      requestAnimationFrame(loop);
      renderer.render(scene, camera);
    };
    loop();

    // silence unused
    void albedoImg;
    void forestImg;
  } catch (err) {
    status.textContent = `Failed: ${(err as Error).message}. Run: python3 cli/extract-civ5-assets.py`;
    app.dataset.renderState = "error";
    console.error(err);
  }
}

main();
