/**
 * Firaxis-style tile rendering kit.
 *
 * Each base terrain maps to a digimap (world-UV) + optional piece heightmap
 * (local-UV displacement). Forests/jungles get billboard scatters from the
 * Civ5 tree atlas. Assets live in public/textures/civ5/ (extracted, gitignored).
 */

import * as THREE from "three";
import { hexCornerVectors, type Vec2 } from "../hex/hex-math";

const ROOT = "textures/civ5/";
const H_BASE = 60;
/** World digimap repeat scale (world units → UV). */
export const DIGIMAP_UV = 0.22;
/** Default subdivisions per hex sector (chunk/hero). Full map uses a lower value. */
export const TILE_DIVS = 20;
/** Full-map density: 8 → ~384 tris/tile × 10k ≈ 4M tris, fine for WebGL. */
export const TILE_DIVS_FULLMAP = 8;
/** Slight overlap seals AA cracks between digimap groups. */
const OVERLAP = 1.02;

/** True if Firaxis digimaps have been extracted to public/textures/civ5/. */
export async function civ5AssetsAvailable(): Promise<boolean> {
  try {
    const r = await fetch(ROOT + "euro_grassland_d.png", { method: "HEAD" });
    return r.ok;
  } catch {
    return false;
  }
}

export interface Civ5TileSpec {
  world: Vec2;
  baseTerrain: string;
  features: string[];
  /** stable hash input for variant pick */
  key: string;
}

interface TerrainLook {
  digimap: string;
  /** piece height PNGs; empty → flat */
  heights: string[];
  /** scale for (byte - H_BASE) → world z */
  hScale: number;
  /** if true, treat constant-196 flat pieces as zero relief */
  flat: boolean;
  water?: boolean;
}

const LOOKS: Record<string, TerrainLook> = {
  Grassland: {
    digimap: "euro_grassland_d.png",
    heights: ["grass_flat_h.png"],
    hScale: 0.05,
    flat: true,
  },
  Plains: {
    digimap: "euro_plain_d.png",
    heights: ["plains_flat_h.png"],
    hScale: 0.05,
    flat: true,
  },
  Desert: {
    digimap: "euro_desert_d.png",
    heights: ["desert_flat_h.png"],
    hScale: 0.06,
    flat: true,
  },
  Tundra: {
    digimap: "euro_tundra_d.png",
    heights: ["tundra_flat_h.png"],
    hScale: 0.06,
    flat: true,
  },
  Snow: {
    digimap: "generic_snow_d.png",
    heights: ["generic_snow_h.png"], // digimap-sized; may fail → flat
    hScale: 0.08,
    flat: true,
  },
  Mountain: {
    digimap: "euro_mountain_base_d.png",
    heights: ["mountain_11_h.png", "mountain_12_h.png"],
    hScale: 0.85,
    flat: false,
  },
  Coast: {
    digimap: "euro_coast_d.png",
    heights: [],
    hScale: 0,
    flat: true,
    water: true,
  },
  Ocean: {
    digimap: "euro_shallow_seas_d.png",
    heights: [],
    hScale: 0,
    flat: true,
    water: true,
  },
  Lakes: {
    digimap: "euro_shallow_seas_d.png",
    heights: [],
    hScale: 0,
    flat: true,
    water: true,
  },
  Marsh: {
    digimap: "marsh_d.png",
    heights: [],
    hScale: 0.04,
    flat: true,
  },
  // Unciv extras → nearest digimap
  "Flood plains": {
    digimap: "euro_plain_d.png",
    heights: [],
    hScale: 0.04,
    flat: true,
  },
  Ice: {
    digimap: "generic_snow_d.png",
    heights: [],
    hScale: 0.03,
    flat: true,
  },
  Atoll: {
    digimap: "euro_coast_d.png",
    heights: [],
    hScale: 0,
    flat: true,
    water: true,
  },
};

const HILL_HEIGHTS: Record<string, string[]> = {
  Grassland: ["grass_hill_01_h.png", "grass_hill_02_h.png"],
  Plains: ["plains_hill_01_h.png", "plains_hill_02_h.png", "plains_hill_21_h.png"],
  Desert: ["desert_hill_01_h.png", "desert_hill_12_h.png"],
  Tundra: ["tundra_hill_01_h.png"],
  Snow: ["tundra_hill_01_h.png"],
};

function hashKey(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function lookFor(base: string, features: string[]): TerrainLook {
  const baseLook = LOOKS[base] ?? LOOKS.Plains!;
  const hasHill = features.includes("Hill");
  if (hasHill && base !== "Mountain") {
    const heights = HILL_HEIGHTS[base] ?? HILL_HEIGHTS.Grassland!;
    return {
      digimap: baseLook.digimap,
      heights,
      hScale: 0.42,
      flat: false,
    };
  }
  return baseLook;
}

function sampleR8(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  u: number,
  v: number,
): number {
  const x = Math.min(w - 1, Math.max(0, u * (w - 1)));
  const y = Math.min(h - 1, Math.max(0, (1 - v) * (h - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (ix: number, iy: number) => data[(iy * w + ix) * 4]!;
  const a = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const b = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return a * (1 - fy) + b * fy;
}

function localToUV(lx: number, ly: number): [number, number] {
  return [lx * 0.5 + 0.5, ly * 0.5 + 0.5];
}

async function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function imageToRgba(img: HTMLImageElement): {
  data: Uint8ClampedArray;
  w: number;
  h: number;
} {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, img.width, img.height);
  return { data: id.data, w: img.width, h: img.height };
}

export interface HeightField {
  data: Uint8ClampedArray;
  w: number;
  h: number;
  hScale: number;
  flat: boolean;
}

export function sampleHeight(hf: HeightField | null, lx: number, ly: number): number {
  if (!hf || hf.flat) return 0.035;
  const [u, v] = localToUV(lx, ly);
  const raw = sampleR8(hf.data, hf.w, hf.h, u, v);
  // constant-196 flat sentinels (flat piece maps)
  if (raw > 180) return 0.035;
  let z = (Math.max(0, raw - H_BASE) / (255 - H_BASE)) * hf.hScale;
  // soft falloff near hex rim so neighbours meet without cliffs
  const r = Math.hypot(lx, ly); // circumradius 1 at corners
  if (r > 0.72) {
    const t = Math.min(1, (r - 0.72) / 0.28);
    const s = t * t * (3 - 2 * t);
    z = z * (1 - s) + 0.035 * s;
  }
  return z;
}

/**
 * Crop forest/jungle atlas cells into transparent tree textures.
 * Civ5's forest_europe sheet is olive-green with trees; corners are often
 * already a=0. We (1) honor source alpha, (2) chroma-key residual sheet green,
 * (3) reject cells that are still mostly solid rectangles (the floating
 * green squares bug).
 */
export function cropAtlasFrames(img: HTMLImageElement): THREE.Texture[] {
  const cols = 4;
  const rows = 4;
  const fw = Math.floor(img.width / cols);
  const fh = Math.floor(img.height / rows);
  const frames: THREE.Texture[] = [];

  /** Olive sheet key used by Civ5 forest/jungle atlases. */
  const isSheetRgb = (r: number, g: number, b: number) => {
    // tight match to (57,71,41) and near-neighbors
    const dr = r - 57;
    const dg = g - 71;
    const db = b - 41;
    if (dr * dr + dg * dg + db * db < 900) return true;
    // flat low-saturation greens typical of the sheet fill
    const maxc = Math.max(r, g, b);
    const minc = Math.min(r, g, b);
    return g > 45 && g < 120 && g >= r && g >= b && maxc - minc < 45 && r < 100 && b < 90;
  };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const canvas = document.createElement("canvas");
      canvas.width = fw;
      canvas.height = fh;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, fw, fh);
      ctx.drawImage(img, col * fw, row * fh, fw, fh, 0, 0, fw, fh);
      const id = ctx.getImageData(0, 0, fw, fh);
      const d = id.data;
      const N = fw * fh;

      // Pass 1: anything already transparent or sheet-colored → a=0
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        const r = d[o]!;
        const g = d[o + 1]!;
        const b = d[o + 2]!;
        const a = d[o + 3]!;
        if (a < 12 || isSheetRgb(r, g, b)) {
          d[o + 3] = 0;
        }
      }

      // Pass 2: flood-fill residual sheet from borders (catches near-key greens)
      const seen = new Uint8Array(N);
      const q: number[] = [];
      const tryPush = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= fw || y >= fh) return;
        const i = y * fw + x;
        if (seen[i]) return;
        const o = i * 4;
        // already clear
        if (d[o + 3]! < 12) {
          seen[i] = 1;
          q.push(i);
          return;
        }
        if (!isSheetRgb(d[o]!, d[o + 1]!, d[o + 2]!)) return;
        seen[i] = 1;
        q.push(i);
      };
      for (let x = 0; x < fw; x++) {
        tryPush(x, 0);
        tryPush(x, fh - 1);
      }
      for (let y = 0; y < fh; y++) {
        tryPush(0, y);
        tryPush(fw - 1, y);
      }
      while (q.length) {
        const i = q.pop()!;
        d[i * 4 + 3] = 0;
        const x = i % fw;
        const y = (i / fw) | 0;
        tryPush(x + 1, y);
        tryPush(x - 1, y);
        tryPush(x, y + 1);
        tryPush(x, y - 1);
      }

      // Stats: opaque pixel count + bounding box fill ratio
      let opaque = 0;
      let minX = fw;
      let minY = fh;
      let maxX = 0;
      let maxY = 0;
      for (let i = 0; i < N; i++) {
        if (d[i * 4 + 3]! < 20) continue;
        opaque++;
        const x = i % fw;
        const y = (i / fw) | 0;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      if (opaque < N * 0.06) continue; // empty cell
      const bbArea = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
      const fill = opaque / bbArea;
      const bbFrac = bbArea / N;
      // solid green rectangle: bbox fills most of the cell and is nearly solid
      if (bbFrac > 0.85 && fill > 0.75) continue;
      // still mostly opaque sheet overall
      if (opaque / N > 0.72) continue;

      ctx.putImageData(id, 0, 0);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.premultiplyAlpha = true;
      frames.push(tex);
    }
  }
  return frames;
}

export class Civ5TileKit {
  private loader = new THREE.TextureLoader();
  private digimapCache = new Map<string, THREE.Texture>();
  private heightCache = new Map<string, HeightField | null>();
  private forestFrames: THREE.Texture[] = [];
  private jungleFrames: THREE.Texture[] = [];
  private corners = hexCornerVectors();
  ready = false;

  async init(): Promise<void> {
    const forestImg = await loadImage(ROOT + "forest_europe.png");
    const jungleImg = await loadImage(ROOT + "jungle_europe.png");
    if (forestImg) this.forestFrames = cropAtlasFrames(forestImg);
    if (jungleImg) this.jungleFrames = cropAtlasFrames(jungleImg);
    this.ready = true;
  }

  private digimap(file: string): THREE.Texture {
    let t = this.digimapCache.get(file);
    if (!t) {
      t = this.loader.load(ROOT + file);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      this.digimapCache.set(file, t);
    }
    return t;
  }

  async heightField(files: string[], hScale: number, flat: boolean): Promise<HeightField | null> {
    if (files.length === 0 || flat) return { data: new Uint8ClampedArray(4), w: 1, h: 1, hScale, flat: true };
    const file = files[0]!;
    if (this.heightCache.has(file)) return this.heightCache.get(file)!;
    const img = await loadImage(ROOT + file);
    if (!img) {
      this.heightCache.set(file, null);
      return null;
    }
    const { data, w, h } = imageToRgba(img);
    // detect constant flat sentinel
    let min = 255;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const v = data[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const isFlat = max - min < 3 || min > 180;
    const hf: HeightField = { data, w, h, hScale: isFlat ? 0.04 : hScale, flat: isFlat };
    this.heightCache.set(file, hf);
    return hf;
  }

  pickHeightFile(look: TerrainLook, key: string): string | null {
    if (look.heights.length === 0) return null;
    const i = hashKey(key) % look.heights.length;
    return look.heights[i]!;
  }

  /**
   * Build merged geometry for a group of tiles sharing the same digimap.
   * Heights are per-tile (local UV sample). Albedo uses world UV.
   * @param divs subdivision density (default TILE_DIVS; use TILE_DIVS_FULLMAP for whole boards)
   */
  async buildTerrainMesh(
    tiles: Civ5TileSpec[],
    opts: { divs?: number } = {},
  ): Promise<THREE.Group> {
    const group = new THREE.Group();
    const divs = opts.divs ?? TILE_DIVS;
    // group by digimap
    const byDigi = new Map<string, { specs: Civ5TileSpec[]; look: TerrainLook }>();
    for (const t of tiles) {
      const look = lookFor(t.baseTerrain, t.features);
      const g = byDigi.get(look.digimap) ?? { specs: [], look };
      g.specs.push(t);
      byDigi.set(look.digimap, g);
    }

    for (const [digi, { specs, look }] of byDigi) {
      // pre-load height variants used by this group
      const hfByKey = new Map<string, HeightField | null>();
      for (const s of specs) {
        const hfFile = this.pickHeightFile(look, s.key);
        const cacheKey = `${hfFile ?? "__flat__"}|${look.hScale}|${look.flat}`;
        if (!hfByKey.has(cacheKey)) {
          hfByKey.set(
            cacheKey,
            await this.heightField(hfFile ? [hfFile] : [], look.hScale, look.flat || !hfFile),
          );
        }
      }
      const tPer = 6 * divs * divs;
      const positions = new Float32Array(specs.length * tPer * 9);
      const uvs = new Float32Array(specs.length * tPer * 6);
      let p = 0;
      let u = 0;

      for (const s of specs) {
        const hfFile = this.pickHeightFile(look, s.key);
        const cacheKey = `${hfFile ?? "__flat__"}|${look.hScale}|${look.flat}`;
        const hf = hfByKey.get(cacheKey) ?? null;
        const cx = s.world.x;
        const cy = s.world.y;

        for (let sec = 0; sec < 6; sec++) {
          const a = this.corners[sec]!;
          const b = this.corners[(sec + 1) % 6]!;
          const point = (i: number, j: number): [number, number, number] => {
            const lx = ((i * a.x + j * b.x) / divs) * OVERLAP;
            const ly = ((i * a.y + j * b.y) / divs) * OVERLAP;
            // sample height in unscaled local space so seams stay soft
            const z = sampleHeight(hf, lx / OVERLAP, ly / OVERLAP);
            return [cx + lx, cy + ly, z];
          };
          for (let i = 0; i < divs; i++) {
            for (let j = 0; j < divs - i; j++) {
              const emit = (i0: number, j0: number, i1: number, j1: number, i2: number, j2: number) => {
                for (const [ii, jj] of [
                  [i0, j0],
                  [i1, j1],
                  [i2, j2],
                ] as const) {
                  const [x, y, z] = point(ii, jj);
                  positions[p++] = x;
                  positions[p++] = y;
                  positions[p++] = z;
                  uvs[u++] = x * DIGIMAP_UV;
                  uvs[u++] = y * DIGIMAP_UV;
                }
              };
              emit(i, j, i, j + 1, i + 1, j);
              if (j < divs - i - 1) emit(i + 1, j, i, j + 1, i + 1, j + 1);
            }
          }
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      geo.computeVertexNormals();

      const mat = look.water
        ? new THREE.MeshLambertMaterial({
            map: this.digimap(digi),
            color: new THREE.Color(look.digimap.includes("shallow") ? 0x4a8ab0 : 0x2a5a88),
            transparent: true,
            opacity: 0.88,
          })
        : new THREE.MeshLambertMaterial({ map: this.digimap(digi) });

      group.add(new THREE.Mesh(geo, mat));
    }

    // canopy overlays + tree billboards
    await this.addFeatureLayers(group, tiles);
    return group;
  }

  private async addFeatureLayers(group: THREE.Group, tiles: Civ5TileSpec[]): Promise<void> {
    const forestTiles = tiles.filter((t) => t.features.includes("Forest"));
    const jungleTiles = tiles.filter((t) => t.features.includes("Jungle"));

    // ground canopy stamps (Civ5 forest_overlay style)
    if (forestTiles.length) {
      group.add(
        await this.buildCanopyOverlay(forestTiles, "forest_overlay_europe.png", 0.004),
      );
    }
    if (jungleTiles.length) {
      group.add(
        await this.buildCanopyOverlay(jungleTiles, "jungle_overlay_europe.png", 0.005),
      );
    }

    // NOTE: vertical tree billboards from the atlas are disabled for now —
    // imperfect sheet cutouts produced floating green rectangles. Canopy is
    // the hex-draped overlay above; 3D .gr2 trees or hand-cut sprites later.
    void this.forestFrames;
    void this.jungleFrames;
  }

  /** Alpha canopy stamp draped on each feature tile (local UV 0–1). */
  private async buildCanopyOverlay(
    tiles: Civ5TileSpec[],
    file: string,
    zLift: number,
  ): Promise<THREE.Mesh> {
    const img = await loadImage(ROOT + file);
    const tex = this.digimap(file);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    // force reload path if digimap assumed repeat
    if (img) {
      const t = new THREE.Texture(img);
      t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      return this.buildLocalUvHexMesh(tiles, t, zLift, 0.85);
    }
    return this.buildLocalUvHexMesh(tiles, tex, zLift, 0.85);
  }

  private buildLocalUvHexMesh(
    tiles: Civ5TileSpec[],
    map: THREE.Texture,
    zLift: number,
    opacity: number,
  ): THREE.Mesh {
    const divs = 8;
    const tPer = 6 * divs * divs;
    const positions = new Float32Array(tiles.length * tPer * 9);
    const uvs = new Float32Array(tiles.length * tPer * 6);
    let p = 0;
    let u = 0;
    for (const s of tiles) {
      const look = lookFor(s.baseTerrain, s.features);
      const hfFile = this.pickHeightFile(look, s.key);
      const hf = hfFile ? this.heightCache.get(hfFile) ?? null : null;
      const cx = s.world.x;
      const cy = s.world.y;
      for (let sec = 0; sec < 6; sec++) {
        const a = this.corners[sec]!;
        const b = this.corners[(sec + 1) % 6]!;
        const point = (i: number, j: number) => {
          const lx = (i * a.x + j * b.x) / divs;
          const ly = (i * a.y + j * b.y) / divs;
          const z = sampleHeight(hf, lx, ly) + zLift;
          const [uu, vv] = localToUV(lx, ly);
          return { x: cx + lx, y: cy + ly, z, uu, vv };
        };
        for (let i = 0; i < divs; i++) {
          for (let j = 0; j < divs - i; j++) {
            const emit = (A: ReturnType<typeof point>, B: ReturnType<typeof point>, C: ReturnType<typeof point>) => {
              for (const q of [A, B, C]) {
                positions[p++] = q.x;
                positions[p++] = q.y;
                positions[p++] = q.z;
                uvs[u++] = q.uu;
                uvs[u++] = q.vv;
              }
            };
            emit(point(i, j), point(i, j + 1), point(i + 1, j));
            if (j < divs - i - 1) emit(point(i + 1, j), point(i, j + 1), point(i + 1, j + 1));
          }
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    return new THREE.Mesh(
      geo,
      new THREE.MeshLambertMaterial({
        map,
        transparent: true,
        opacity,
        depthWrite: false,
      }),
    );
  }
}
