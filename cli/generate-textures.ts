/**
 * Generate procedural stand-in terrain textures under the Artful Terrain
 * Textures taxonomy (see src/render/asset-map.json). These are PLACEHOLDERS:
 * swap in real pack conversions by dropping PNGs with the same names into
 * public/textures/artful/ — no code change (asset mapping is data, not code).
 *
 * Style goals: painterly value-noise ground in Civ5-flavored palettes,
 * seamless tiling (lattice noise with wrap), subtle large-scale mottling.
 *
 *   bun run cli/generate-textures.ts
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { encodePng } from "./lib/png";

const SIZE = 256;
const OUT = join(import.meta.dir, "../public/textures/artful");

type RGB = [number, number, number];

/** Deterministic hash noise on a wrapping lattice. */
function makeNoise(seed: number, lattice: number): (x: number, y: number) => number {
  const rand = (ix: number, iy: number): number => {
    let h = (ix * 374761393 + iy * 668265263 + seed * 962287) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = Math.imul(h, 1274126177) | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const gx = (x / SIZE) * lattice;
    const gy = (y / SIZE) * lattice;
    const x0 = Math.floor(gx) % lattice;
    const y0 = Math.floor(gy) % lattice;
    const x1 = (x0 + 1) % lattice;
    const y1 = (y0 + 1) % lattice;
    const fx = smooth(gx - Math.floor(gx));
    const fy = smooth(gy - Math.floor(gy));
    const a = rand(x0, y0) * (1 - fx) + rand(x1, y0) * fx;
    const b = rand(x0, y1) * (1 - fx) + rand(x1, y1) * fx;
    return a * (1 - fy) + b * fy;
  };
}

/** Fractal noise, still seamless. */
function fbm(seed: number, octaves: number[]): (x: number, y: number) => number {
  const noises = octaves.map((lat, i) => makeNoise(seed + i * 7919, lat));
  const weights = octaves.map((_, i) => 1 / 2 ** i);
  const total = weights.reduce((a, b) => a + b, 0);
  return (x, y) =>
    noises.reduce((sum, n, i) => sum + n(x, y) * weights[i]!, 0) / total;
}

function lerp3(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

interface GroundSpec {
  name: string;
  dark: RGB;
  light: RGB;
  /** extra speckle color + probability */
  speckle?: { color: RGB; p: number };
  alpha?: number;
}

function ground(spec: GroundSpec, seed: number): Uint8Array {
  const n1 = fbm(seed, [4, 8, 16, 32]);
  const n2 = fbm(seed + 31337, [8, 32]);
  const speckleNoise = makeNoise(seed + 555, 64);
  const px = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const v = 0.65 * n1(x, y) + 0.35 * n2(x, y);
      let [r, g, b] = lerp3(spec.dark, spec.light, v);
      if (spec.speckle && speckleNoise(x, y) > 1 - spec.speckle.p) {
        [r, g, b] = lerp3([r, g, b], spec.speckle.color, 0.7);
      }
      const i = (y * SIZE + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = Math.round((spec.alpha ?? 1) * 255);
    }
  }
  return px;
}

/** Feature overlays: blobs of cover (trees, ice...) with alpha falloff. */
function blobOverlay(
  base: RGB,
  highlight: RGB,
  density: number,
  blobR: [number, number],
  seed: number,
  maxAlpha = 0.85,
): Uint8Array {
  const px = new Uint8Array(SIZE * SIZE * 4);
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  const blobs: { x: number; y: number; r: number; v: number }[] = [];
  const count = Math.round(density * 220);
  for (let i = 0; i < count; i++) {
    blobs.push({
      x: rnd() * SIZE,
      y: rnd() * SIZE,
      r: blobR[0] + rnd() * (blobR[1] - blobR[0]),
      v: rnd(),
    });
  }
  const alphaAt = new Float32Array(SIZE * SIZE);
  const colorV = new Float32Array(SIZE * SIZE);
  for (const blob of blobs) {
    const r2 = blob.r * blob.r;
    const minX = Math.floor(blob.x - blob.r - SIZE);
    for (let dyw = -1; dyw <= 1; dyw++) {
      for (let dxw = -1; dxw <= 1; dxw++) {
        const bx = blob.x + dxw * SIZE;
        const by = blob.y + dyw * SIZE;
        if (bx + blob.r < 0 || bx - blob.r > SIZE || by + blob.r < 0 || by - blob.r > SIZE) continue;
        for (let y = Math.max(0, Math.floor(by - blob.r)); y < Math.min(SIZE, by + blob.r); y++) {
          for (let x = Math.max(0, Math.floor(bx - blob.r)); x < Math.min(SIZE, bx + blob.r); x++) {
            const d2 = (x - bx) ** 2 + (y - by) ** 2;
            if (d2 < r2) {
              const t = 1 - d2 / r2;
              const idx = y * SIZE + x;
              if (t > alphaAt[idx]!) {
                alphaAt[idx] = t;
                colorV[idx] = blob.v;
              }
            }
          }
        }
      }
    }
    void minX;
  }
  for (let i = 0; i < SIZE * SIZE; i++) {
    const a = Math.min(1, alphaAt[i]! * 1.6) * maxAlpha;
    const [r, g, b] = lerp3(base, highlight, colorV[i]!);
    px[i * 4] = r;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = b;
    px[i * 4 + 3] = Math.round(a * 255);
  }
  return px;
}

mkdirSync(OUT, { recursive: true });

const writes: [string, Uint8Array][] = [
  // ——— base terrains (opaque) — Artful pack coverage ———
  ["grassland", ground({ name: "grassland", dark: [58, 106, 40], light: [110, 156, 62], speckle: { color: [140, 176, 88], p: 0.05 } }, 1)],
  ["plains", ground({ name: "plains", dark: [156, 128, 62], light: [198, 168, 96], speckle: { color: [120, 132, 60], p: 0.05 } }, 2)],
  ["desert", ground({ name: "desert", dark: [196, 168, 116], light: [232, 210, 156], speckle: { color: [176, 146, 96], p: 0.03 } }, 3)],
  ["tundra", ground({ name: "tundra", dark: [116, 116, 96], light: [158, 156, 128], speckle: { color: [196, 200, 190], p: 0.06 } }, 4)],
  ["snow", ground({ name: "snow", dark: [206, 214, 224], light: [242, 246, 250] }, 5)],
  ["ocean", ground({ name: "ocean", dark: [7, 22, 70], light: [26, 52, 100] }, 6)], // Artful waterdepthcolor deep end
  ["coast", ground({ name: "coast", dark: [40, 92, 130], light: [56, 128, 158], speckle: { color: [100, 168, 190], p: 0.04 } }, 7)], // Artful waterdepthcolor shallow end
  ["lakes", ground({ name: "lakes", dark: [48, 108, 142], light: [70, 140, 170] }, 8)], // Artful waterdepthcolor shallowest band
  ["mountain", ground({ name: "mountain", dark: [88, 84, 82], light: [150, 146, 142], speckle: { color: [220, 222, 224], p: 0.08 } }, 9)],
  ["fallout-ground", ground({ name: "fallout", dark: [70, 84, 38], light: [112, 128, 52], speckle: { color: [150, 168, 60], p: 0.1 } }, 10)],
  // ——— feature overlays (alpha) ———
  ["forest", blobOverlay([26, 60, 26], [52, 96, 44], 1.1, [7, 14], 21)],
  ["jungle", blobOverlay([18, 62, 30], [40, 110, 46], 1.4, [8, 16], 22)],
  ["hill", blobOverlay([0, 0, 0], [255, 244, 214], 0.5, [16, 34], 23, 0.28)],
  ["marsh", blobOverlay([38, 72, 60], [70, 104, 78], 0.9, [6, 12], 24, 0.6)],
  ["oasis", blobOverlay([40, 120, 150], [90, 180, 140], 0.7, [10, 20], 25, 0.8)],
  ["ice", blobOverlay([210, 226, 240], [245, 250, 254], 0.9, [10, 22], 26, 0.9)],
  ["atoll", blobOverlay([120, 190, 180], [200, 230, 210], 0.6, [8, 16], 27, 0.8)],
  ["flood-plains", blobOverlay([90, 130, 60], [140, 170, 80], 0.8, [8, 18], 28, 0.5)],
  ["fallout", blobOverlay([90, 110, 30], [140, 160, 40], 1.0, [8, 16], 29, 0.55)],
];

// Never clobber real pack conversions (cli/convert-artful.py output):
// only fill missing files unless --force is given.
const force = process.argv.includes("--force");
for (const [name, rgba] of writes) {
  const path = join(OUT, `${name}.png`);
  if (!force && (await Bun.file(path).exists())) {
    console.log("kept ", path);
    continue;
  }
  await Bun.write(path, encodePng(SIZE, SIZE, rgba));
  console.log("wrote", path);
}
console.log(`\n${writes.length} textures generated (${SIZE}x${SIZE}, seamless).`);
