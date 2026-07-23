/**
 * Firaxis-style tile rendering kit.
 *
 * Each base terrain maps to a digimap (world-UV) + optional piece heightmap
 * (local-UV displacement). When board-model heights are supplied, welded
 * low-freq relief is the base and piece heightmaps add hill/mountain detail.
 *
 * Forests follow extracted forests.xml (TerrainModels.fpk):
 *   num_tiles=4, random_trees_per_tile=360, space_between=1.33, overlay_alpha=0.60
 * Placement is mask-driven (forest_tile1..4) + Poisson spacing; density is
 * LOD-scaled for full-map performance.
 *
 * Assets live in public/textures/civ5/ (extracted, gitignored).
 */

import * as THREE from "three";
import { hexCornerVectors, type Vec2 } from "../hex/hex-math";
import { heightAtLocal, SEABED_DEPTH } from "./board-model";

const ROOT = "textures/civ5/";
const H_BASE = 60;
/**
 * World digimap repeat scale (world units → UV).
 * ~0.16 → one digimap period spans ~6 world units ≈ 3.5 hex spacings —
 * closer to Civ5's continuous ground paint than the old 0.22 (too busy/muddy).
 */
export const DIGIMAP_UV = 0.16;
/** Default subdivisions per hex sector (chunk/hero). Full map uses a lower value. */
export const TILE_DIVS = 20;
/** Full-map density: 8 → ~384 tris/tile × 10k ≈ 4M tris, fine for WebGL. */
export const TILE_DIVS_FULLMAP = 8;
/** Slight overlap seals AA cracks between digimap groups (keep tiny — big values misalign). */
const OVERLAP = 1.004;
/** Flat land rests here so piece-height rims meet neighbours. */
const FLAT_Z = 0.02;

/**
 * From docs/civ5-forests.xml (TerrainModels.fpk).
 * space_between is for a tree of size 1 in Firaxis units; we rescale to our
 * hex (circumradius 1) so ~hundreds of trees can pack the mask.
 */
const FOREST_CFG = {
  numTiles: 4,
  /** full Civ5 density — hero approaches this; full map uses a fraction */
  randomTreesPerTile: 360,
  overlayAlpha: 0.6,
  /** Firaxis space_between for size-1 tree */
  spaceBetween: 1.33,
} as const;

/** Convert Firaxis size-1 spacing into our world units for a given tree scale. */
function forestMinDist(treeScale: number): number {
  // forests.xml space_between=1.33 for size-1. Their hex world units are larger
  // than ours (circumradius 1); keep packs dense enough to hit ~360/tile.
  // Smaller trees pack tighter (Firaxis comment).
  const unit = 0.28 * FOREST_CFG.spaceBetween * treeScale;
  return Math.max(0.035, unit);
}

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
  /** board-model center height (welded low-freq relief) */
  height?: number;
  /** board-model corner heights — when set, terrain uses welded base + piece detail */
  cornerHeights?: [number, number, number, number, number, number];
}

/** full = whole map (lighter); detail = chunk; hero = single-tile showcase density */
export type FoliageQuality = "full" | "detail" | "hero";

export interface TerrainLook {
  digimap: string;
  /** piece height PNGs; empty → flat */
  heights: string[];
  /** scale for (byte - H_BASE) → world z */
  hScale: number;
  /** if true, treat constant-196 flat pieces as zero relief */
  flat: boolean;
  water?: boolean;
  /**
   * Seabed z for standalone tiles (no welded board heights — chunk/gallery
   * demos). With board heights the welded base already carries SEABED_DEPTH.
   */
  seabedDepth?: number;
  /**
   * Linear-space RGB gain applied as material color. Calibrated so the
   * rendered ground ≈ source digimap × 0.75 with channel ratios preserved —
   * matching how flat open ground reads in the real Civ5 frame capture
   * (plains ≈ RGB(150,140,75)). Compensates the warm sun + ACES blue drain.
   */
  gain?: [number, number, number];
  /**
   * Land-land blend order: at a terrain boundary the HIGHER priority paints
   * an alpha-fading skirt over the lower one (grass washes into plains, not
   * the reverse) — how Civ5's continuous ground paint reads at hex borders.
   */
  blendPriority?: number;
  /**
   * How far this terrain's blend skirt reaches into a lower-priority
   * neighbour, in world units (default 0.62). Mountains keep a short rocky
   * fringe — a full-depth grey wash reads as fog rolling off the massif.
   */
  blendDepth?: number;
  /**
   * Sample the digimap triplanar (projected from x/y/z by surface normal)
   * instead of flat world-plane UV. Planar UV smears into long vertical
   * streaks on steep faces — mountains need side projection.
   */
  triplanar?: boolean;
  /**
   * Altitude-blended cap texture (triplanar only): washes over the digimap
   * near the top of the relief — Civ5 mountains read as rock with snow caps.
   */
  capDigimap?: string;
}

/**
 * Material gain for the underwater floor (seabed tiles AND the submerged rim
 * of land tiles — both must multiply to identical pixels at the hex edge).
 * Cool blue lift so the wet floor reads submerged, not dusty.
 */
const WATER_GAIN: [number, number, number] = [1.3, 1.35, 1.5];

const LOOKS: Record<string, TerrainLook> = {
  Grassland: {
    digimap: "euro_grassland_d.png",
    heights: ["grass_flat_h.png"],
    hScale: 0.06,
    flat: true,
    blendPriority: 7,
    gain: [1.03, 1.14, 1.2],
  },
  Plains: {
    digimap: "euro_plain_d.png",
    heights: ["plains_flat_h.png"],
    hScale: 0.06,
    flat: true,
    blendPriority: 5,
    gain: [1.42, 1.45, 1.34],
  },
  Desert: {
    digimap: "euro_desert_d.png",
    heights: ["desert_flat_h.png"],
    hScale: 0.07,
    flat: true,
    blendPriority: 2,
    gain: [1.1, 1.1, 1.12],
  },
  Tundra: {
    digimap: "euro_tundra_d.png",
    heights: ["tundra_flat_h.png"],
    hScale: 0.07,
    flat: true,
    blendPriority: 4,
    gain: [1.05, 1.05, 1.12],
  },
  Snow: {
    digimap: "generic_snow_d.png",
    heights: ["generic_snow_h.png"],
    hScale: 0.09,
    flat: true,
    blendPriority: 3,
    gain: [1.0, 1.0, 1.08],
  },
  Mountain: {
    digimap: "euro_mountain_base_d.png",
    heights: ["mountain_11_h.png", "mountain_12_h.png"],
    hScale: 0.88,
    flat: false,
    blendPriority: 8,
    blendDepth: 0.34,
    triplanar: true,
    capDigimap: "euro_mountain_top_d.png",
  },
  // All water shares ONE seabed material (sand digimap, reef blended in by
  // depth in-shader) — a single group means no digimap seams underwater; the
  // coast/ocean difference is real geometry depth + the depth-LUT water tint.
  Coast: {
    digimap: "euro_coast_d.png",
    heights: [],
    hScale: 0,
    flat: true,
    water: true,
    seabedDepth: SEABED_DEPTH.Coast,
    gain: WATER_GAIN,
  },
  Ocean: {
    digimap: "euro_coast_d.png",
    heights: [],
    hScale: 0,
    flat: true,
    water: true,
    seabedDepth: SEABED_DEPTH.Ocean,
    gain: WATER_GAIN,
  },
  Lakes: {
    digimap: "euro_coast_d.png",
    heights: [],
    hScale: 0,
    flat: true,
    water: true,
    seabedDepth: SEABED_DEPTH.Lakes,
    gain: WATER_GAIN,
  },
  Marsh: {
    digimap: "marsh_d.png",
    heights: [],
    hScale: 0.05,
    flat: true,
    blendPriority: 6,
  },
  "Flood plains": {
    digimap: "euro_plain_d.png",
    heights: [],
    hScale: 0.05,
    flat: true,
    blendPriority: 5,
  },
  Ice: {
    digimap: "generic_snow_d.png",
    heights: [],
    hScale: 0.04,
    flat: true,
    blendPriority: 3,
  },
  Atoll: {
    digimap: "euro_coast_d.png",
    heights: [],
    hScale: 0,
    flat: true,
    water: true,
    seabedDepth: -0.05,
    gain: WATER_GAIN,
  },
};

// Firaxis ships exactly two single-hex hill height shapes, reused by every
// terrain (the *_2_x/3_x pieces are multi-hex clusters we can't place per-tile).
const HILL_HEIGHTS: Record<string, string[]> = {
  Grassland: ["grass_hill_01_h.png", "grass_hill_02_h.png"],
  Plains: ["plains_hill_01_h.png", "plains_hill_02_h.png"],
  Desert: ["desert_hill_01_h.png", "desert_hill_12_h.png"],
  Tundra: ["tundra_hill_01_h.png", "tundra_hill_12_h.png"],
  Snow: ["tundra_hill_01_h.png", "tundra_hill_12_h.png"],
};

function hashKey(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Deterministic [0,1) from key + salt. */
function hash01(key: string, salt: number): number {
  return (hashKey(`${key}|${salt}`) >>> 0) / 0x100000000;
}

/** Known base terrains — exported so tests can assert save coverage. */
export function knownTerrains(): string[] {
  return Object.keys(LOOKS);
}

export function lookFor(base: string, features: string[]): TerrainLook {
  const baseLook = LOOKS[base] ?? LOOKS.Plains!;
  const hasHill = features.includes("Hill");
  if (hasHill && base !== "Mountain") {
    const heights = HILL_HEIGHTS[base] ?? HILL_HEIGHTS.Grassland!;
    return {
      digimap: baseLook.digimap,
      heights,
      // broad rolling hill, not a tent spike
      hScale: 0.48,
      flat: false,
      gain: baseLook.gain,
      blendPriority: baseLook.blendPriority,
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

function hashLattice(ix: number, iy: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

/** Smooth 2D value noise in [0,1) on an integer lattice. */
function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hashLattice(x0, y0);
  const b = hashLattice(x0 + 1, y0);
  const c = hashLattice(x0, y0 + 1);
  const d = hashLattice(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/**
 * World-space shoreline wobble: the coastline is the z=0 contour of the
 * welded height field, which is piecewise per hex sector — without noise its
 * contours run parallel to hex edges and turn at corner angles. Two octaves
 * (long meanders + chop) displace the field vertically near the waterline so
 * the contour wanders organically, Civ5-style. Zero-mean, aperiodic,
 * continuous across tiles.
 */
export function shoreWobble(wx: number, wy: number): number {
  const n1 = valueNoise(wx * 0.55 + 7.3, wy * 0.55 - 3.1) - 0.5;
  const n2 = valueNoise(wx * 2.2 - 11.9, wy * 2.2 + 5.7) - 0.5;
  // Sized so TYPICAL displacement (value noise clusters near its midpoint —
  // RMS ≈ a quarter of the max) wanders the waterline a visible fraction of
  // a hex. Water tiles clamp the wobbled crest below the surface, so the
  // occasional big positive swing can't beach the seabed.
  return n1 * 0.1 + n2 * 0.03;
}

/**
 * Tiny deterministic micro-relief so flat digimap land isn't a plastic sheet.
 * Takes WORLD coordinates: sine waves in tile-local space stamped the same
 * interference pattern on every tile, which the baked hillshade turned into a
 * regular ripple marching across whole plains. World-space value noise is
 * aperiodic and continuous across tile borders.
 */
function microRelief(wx: number, wy: number): number {
  const n =
    valueNoise(wx * 1.7, wy * 1.7) * 0.65 +
    valueNoise(wx * 4.3 + 31.7, wy * 4.3 - 17.3) * 0.35;
  return (n - 0.5) * 0.022;
}

/**
 * Sample piece heightmap in local hex space. Rim soft-falls to FLAT_Z so
 * adjacent tiles meet without cliffs. Flat pieces get subtle micro-relief.
 * wx/wy are world coordinates for the micro-relief noise (default to local
 * for standalone use).
 */
export function sampleHeight(
  hf: HeightField | null,
  lx: number,
  ly: number,
  wx: number = lx,
  wy: number = ly,
): number {
  if (!hf || hf.flat) return FLAT_Z + microRelief(wx, wy);
  const [u, v] = localToUV(lx, ly);
  const raw = sampleR8(hf.data, hf.w, hf.h, u, v);
  // NO per-texel flat-sentinel check here: constant-196 flat pieces are
  // detected at load (heightField → flat:true). Mountain peaks legitimately
  // reach 245 — truncating >180 carved craters into every summit.
  let z = (Math.max(0, raw - H_BASE) / (255 - H_BASE)) * hf.hScale;
  const r = Math.hypot(lx, ly);
  // start falloff earlier so hills blend into neighbours instead of mesa edges
  if (r > 0.58) {
    const t = Math.min(1, (r - 0.58) / 0.42);
    const s = t * t * (3 - 2 * t);
    z = z * (1 - s) + (FLAT_Z + microRelief(wx, wy) * 0.3) * s;
  }
  return z;
}

/**
 * Final terrain Z for a local offset inside a tile.
 * Prefer welded board-model base when present; piece height adds hill/mountain form.
 */
export function terrainHeightAt(
  s: Civ5TileSpec,
  look: TerrainLook,
  hf: HeightField | null,
  corners: readonly Vec2[],
  lx: number,
  ly: number,
): number {
  const piece = sampleHeight(hf, lx, ly, s.world.x + lx, s.world.y + ly);
  if (s.cornerHeights && s.height !== undefined) {
    const base = heightAtLocal(s.height, s.cornerHeights, corners, { x: lx, y: ly });
    // shoreline wobble at FULL strength at and below the waterline (this is
    // what bends the z=0 contour off the hex geometry), fading out a little
    // above it so inland ground is untouched. The SAME term applies to land
    // and water, so hex edges stay crack-free. Underwater it doubles as
    // grain that breaks up per-tile depth plateaus.
    const wobbleW = 1 - Math.min(1, Math.max(0, (base - 0.015) / 0.045));
    const grain = wobbleW > 0 ? shoreWobble(s.world.x + lx, s.world.y + ly) * wobbleW : 0;
    // water: welded seabed, exactly like flat land — the waterline is the
    // z=0 contour of this shared heightfield (Civ5's organic coastline).
    // Water stays strictly submerged: a big positive wobble swing must not
    // beach the floor (land has no clamp — its dips become lagoons).
    if (look.water) return Math.min(base + grain, -0.008);
    if (look.flat) return base + grain;
    // Firaxis hill/mountain shape as high-freq detail on welded base
    const detail = piece - FLAT_Z;
    return base + detail * 0.8 + grain;
  }
  return look.water ? (look.seabedDepth ?? SEABED_DEPTH.Coast!) : piece;
}

/**
 * Height of the RENDERED piecewise-linear terrain mesh at a local offset —
 * terrainHeightAt evaluated on the same triangulated sector grid that
 * buildTerrainMesh emits (including the OVERLAP xy scale). Blend skirts must
 * sit on the mesh, not the analytic surface: on curved hill pieces the chord
 * error of a divs-8 full-map mesh is ~10× the skirt lift, which z-fought as
 * banded moiré at every height transition.
 */
export function meshHeightAt(
  s: Civ5TileSpec,
  look: TerrainLook,
  hf: HeightField | null,
  corners: readonly Vec2[],
  divs: number,
  lx: number,
  ly: number,
): number {
  // mesh vertices sit at param*OVERLAP with z sampled at param
  const px = lx / OVERLAP;
  const py = ly / OVERLAP;
  for (let i = 0; i < 6; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 6]!;
    const denom = a.x * b.y - a.y * b.x;
    if (Math.abs(denom) < 1e-12) continue;
    let fi = ((px * b.y - py * b.x) / denom) * divs;
    let fj = ((a.x * py - a.y * px) / denom) * divs;
    if (fi < -1e-7 || fj < -1e-7) continue; // wrong sector wedge
    const sum = fi + fj;
    if (sum > divs) {
      // outside the hex (corner spill): clamp to the rim
      fi *= divs / sum;
      fj *= divs / sum;
    }
    const i0 = Math.max(0, Math.min(divs - 1, Math.floor(fi)));
    const j0 = Math.max(0, Math.min(divs - 1 - i0, Math.floor(fj)));
    const ffi = fi - i0;
    const ffj = fj - j0;
    const zAt = (gi: number, gj: number) =>
      terrainHeightAt(
        s,
        look,
        hf,
        corners,
        (gi * a.x + gj * b.x) / divs,
        (gi * a.y + gj * b.y) / divs,
      );
    if (ffi + ffj <= 1) {
      return zAt(i0, j0) * (1 - ffi - ffj) + zAt(i0 + 1, j0) * ffi + zAt(i0, j0 + 1) * ffj;
    }
    return (
      zAt(i0 + 1, j0 + 1) * (ffi + ffj - 1) +
      zAt(i0, j0 + 1) * (1 - ffi) +
      zAt(i0 + 1, j0) * (1 - ffj)
    );
  }
  return terrainHeightAt(s, look, hf, corners, lx, ly);
}

export type AtlasCropMode = "forest" | "jungle";

/**
 * Crop forest/jungle atlas cells into round-ish canopy cards.
 * Forest sheet is olive (~57,71,41); jungle sheet is near-black. Jungle
 * foliage is also dark green — must NOT use the olive sheet key on jungle
 * or we flood-delete the palms into black sticks.
 */
export function cropAtlasFrames(
  img: HTMLImageElement,
  mode: AtlasCropMode = "forest",
): THREE.Texture[] {
  const cols = 4;
  const rows = 4;
  const fw = Math.floor(img.width / cols);
  const fh = Math.floor(img.height / rows);
  const frames: THREE.Texture[] = [];

  const isSheetRgb = (r: number, g: number, b: number) => {
    if (mode === "jungle") {
      // jungle sheet ≈ (16,14,16); foliage is darker greens with more chroma
      const maxc = Math.max(r, g, b);
      const minc = Math.min(r, g, b);
      if (maxc < 28) return true; // near-black sheet
      // flat near-grey dark fill
      return maxc < 40 && maxc - minc < 8;
    }
    const dr = r - 57;
    const dg = g - 71;
    const db = b - 41;
    if (dr * dr + dg * dg + db * db < 400) return true;
    const maxc = Math.max(r, g, b);
    const minc = Math.min(r, g, b);
    if (maxc < 22) return true;
    return g > 52 && g < 88 && Math.abs(g - 71) < 14 && maxc - minc < 22 && r < 75 && b < 55;
  };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const src = document.createElement("canvas");
      src.width = fw;
      src.height = fh;
      const sctx = src.getContext("2d")!;
      sctx.clearRect(0, 0, fw, fh);
      sctx.drawImage(img, col * fw, row * fh, fw, fh, 0, 0, fw, fh);
      const id = sctx.getImageData(0, 0, fw, fh);
      const d = id.data;
      const N = fw * fh;

      // Pass 1: low alpha → clear (keep semi-opaque foliage — no shredding)
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        if (d[o + 3]! < 12) {
          d[o] = d[o + 1] = d[o + 2] = d[o + 3] = 0;
        }
      }

      // Pass 2: flood sheet from borders only
      const seen = new Uint8Array(N);
      const q: number[] = [];
      const tryPush = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= fw || y >= fh) return;
        const i = y * fw + x;
        if (seen[i]) return;
        const o = i * 4;
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
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = d[i * 4 + 3] = 0;
        const x = i % fw;
        const y = (i / fw) | 0;
        tryPush(x + 1, y);
        tryPush(x - 1, y);
        tryPush(x, y + 1);
        tryPush(x, y - 1);
      }

      // Mild alpha boost on midtones so crowns read solid (less “broken”)
      // Jungle: heavy fill so palm fronds melt into canopy blobs
      const alphaBoost = mode === "jungle" ? 90 : 40;
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        const a = d[o + 3]!;
        if (a > 0 && a < 230) d[o + 3] = Math.min(255, a + alphaBoost);
      }

      // Dilate: jungle 2 passes (frondy palms → soft canopy discs),
      // forest 1 pass (rounds the ragged crown silhouette — the dark
      // calibrated tint made frayed card edges read as spiky cutouts)
      {
        const passes = mode === "jungle" ? 2 : 1;
        for (let pass = 0; pass < passes; pass++) {
          const copy = new Uint8ClampedArray(d);
          for (let y = 1; y < fh - 1; y++) {
            for (let x = 1; x < fw - 1; x++) {
              const i = y * fw + x;
              if (copy[i * 4 + 3]! >= 50) continue;
              let best = -1;
              let bestA = 0;
              for (const [dx, dy] of [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1],
                [1, 1],
                [-1, -1],
                [1, -1],
                [-1, 1],
              ] as const) {
                const j = (y + dy) * fw + (x + dx);
                const a = copy[j * 4 + 3]!;
                if (a > bestA) {
                  bestA = a;
                  best = j;
                }
              }
              if (best >= 0 && bestA > 60) {
                const o = i * 4;
                d[o] = copy[best * 4]!;
                d[o + 1] = copy[best * 4 + 1]!;
                d[o + 2] = copy[best * 4 + 2]!;
                d[o + 3] = Math.min(220, bestA - 10);
              }
            }
          }
        }
      }

      let opaque = 0;
      let minX = fw;
      let minY = fh;
      let maxX = 0;
      let maxY = 0;
      for (let i = 0; i < N; i++) {
        if (d[i * 4 + 3]! < 16) continue;
        opaque++;
        const x = i % fw;
        const y = (i / fw) | 0;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      // Jungle atlas mixes dense bushes with sparse palms/grass —
      // keep only the bushiest clumps (same visual class as forest crowns).
      const minOpaque = mode === "jungle" ? N * 0.28 : N * 0.05;
      if (opaque < minOpaque) continue;
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const aspect = bw / Math.max(1, bh);
      // Jungle: prefer round-ish bushes, not tall palm sticks
      if (mode === "jungle") {
        if (aspect < 0.75 || aspect > 1.55) continue;
      } else if (aspect < 0.55 || aspect > 1.85) {
        continue;
      }
      const bbArea = Math.max(1, bw * bh);
      const fill = opaque / bbArea;
      if (bbArea / N > 0.9 && fill > 0.82) continue; // solid sheet remnant
      if (opaque / N > 0.8) continue;
      // Jungle: only fat canopy discs
      if (mode === "jungle" && fill < 0.45) continue;

      sctx.putImageData(id, 0, 0);

      // Pad into a square so the sprite is round, not tall empty canvas
      const pad = Math.max(2, Math.floor(Math.max(bw, bh) * 0.08));
      const side = Math.max(bw, bh) + pad * 2;
      const out = document.createElement("canvas");
      out.width = side;
      out.height = side;
      const octx = out.getContext("2d")!;
      octx.clearRect(0, 0, side, side);
      // bias slightly upward so trunks sit lower in the card (canopy fills view)
      const dx = Math.floor((side - bw) / 2);
      const dy = Math.floor((side - bh) / 2) - Math.floor(pad * 0.2);
      octx.drawImage(src, minX, minY, bw, bh, dx, Math.max(0, dy), bw, bh);

      // Bake sun-lit-top shading into the card (sprites are unlit): real Civ5
      // crowns read *round* because of a strong top→bottom luminance rolloff.
      // Gradient averages ~1.0 over the card so the calibrated mean tint holds.
      // Jungle gets a gentler rolloff — its mass stays dark in the real game.
      {
        const [top, span] = mode === "jungle" ? [1.25, 0.55] : [1.45, 0.9];
        const od = octx.getImageData(0, 0, side, side);
        const p = od.data;
        for (let y = 0; y < side; y++) {
          const t = y / Math.max(1, side - 1); // 0 top → 1 bottom
          const f = top - span * t;
          // Feather the card's bottom ~28% to nothing: raw atlas trunk pixels
          // end in hard rectangular chunks against bright ground otherwise.
          // (Content sits above ~8% padding, so a short fade never bites.)
          const fade = t > 0.72 ? Math.max(0, (1 - t) / 0.28) : 1;
          for (let x = 0; x < side; x++) {
            const o = (y * side + x) * 4;
            if (p[o + 3]! === 0) continue;
            p[o] = Math.min(255, p[o]! * f);
            p[o + 1] = Math.min(255, p[o + 1]! * f);
            p[o + 2] = Math.min(255, p[o + 2]! * f);
            if (fade < 1) p[o + 3] = p[o + 3]! * fade;
          }
        }
        octx.putImageData(od, 0, 0);
      }

      const tex = new THREE.CanvasTexture(out);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.premultiplyAlpha = false;
      tex.anisotropy = 4;
      // Linear = soft round crowns; nearest made them look shattered/spindly
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      frames.push(tex);
    }
  }
  return frames;
}

/**
 * Build a canopy-mass texture: RGB from the leaf overlay, alpha from the
 * forest_tile silhouette mask. Gives irregular woods-shaped puffs with real
 * leaf color instead of solid green cards.
 */
function compositeCanopyMass(
  maskImg: HTMLImageElement,
  overlayImg: HTMLImageElement | null,
  tint: [number, number, number],
): THREE.Texture {
  const w = maskImg.width;
  const h = maskImg.height;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;

  // overlay (or solid tint) as color source
  if (overlayImg) {
    ctx.drawImage(overlayImg, 0, 0, w, h);
  } else {
    ctx.fillStyle = `rgb(${tint[0]},${tint[1]},${tint[2]})`;
    ctx.fillRect(0, 0, w, h);
  }
  const color = ctx.getImageData(0, 0, w, h);
  const cd = color.data;

  // mask silhouette
  const mc = document.createElement("canvas");
  mc.width = w;
  mc.height = h;
  const mctx = mc.getContext("2d")!;
  mctx.drawImage(maskImg, 0, 0, w, h);
  const mask = mctx.getImageData(0, 0, w, h).data;

  for (let i = 0; i < cd.length; i += 4) {
    const lum = mask[i]!; // grayscale mask
    // soft edge: feather near zero
    let a = (lum - 12) / 200;
    if (a <= 0) {
      cd[i + 3] = 0;
      continue;
    }
    a = Math.min(1, a);
    // darken slightly toward mask edge for volume cue
    const edge = Math.min(1, lum / 180);
    const k = 0.55 + 0.5 * edge;
    cd[i] = Math.min(255, cd[i]! * k);
    cd[i + 1] = Math.min(255, cd[i + 1]! * k);
    cd[i + 2] = Math.min(255, cd[i + 2]! * k);
    // Pull the litter toward dark forest-floor olive: the overlay alone is a
    // pale wash, and tree-card bottoms need shadowed ground to sit on
    // (real Civ5's understory is much darker than open terrain).
    cd[i] = cd[i]! * 0.4 + 38 * 0.6;
    cd[i + 1] = cd[i + 1]! * 0.4 + 42 * 0.6;
    cd[i + 2] = cd[i + 2]! * 0.4 + 22 * 0.6;
    // also respect overlay alpha if present — but keep a floor so the
    // understory reads continuous under the stand
    const oa = overlayImg ? Math.max(0.55, cd[i + 3]! / 255) : 1;
    cd[i + 3] = Math.min(255, a * oa * 230);
  }
  ctx.putImageData(color, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.premultiplyAlpha = false;
  return tex;
}

/**
 * Soft dark contact shadow in the shape of a forest_tile mask. Real Civ5
 * grounds every stand on a blurred dark blob (see zoomed frame capture) —
 * it hides trunk bottoms and makes crowns read round against bright terrain.
 */
function buildShadowStamp(maskImg: HTMLImageElement): THREE.Texture {
  const size = 128;
  // mask grayscale → alpha
  const m = document.createElement("canvas");
  m.width = m.height = size;
  const mctx = m.getContext("2d")!;
  mctx.drawImage(maskImg, 0, 0, size, size);
  const md = mctx.getImageData(0, 0, size, size);
  for (let i = 0; i < size * size; i++) {
    const lum = md.data[i * 4]!;
    md.data[i * 4] = 16;
    md.data[i * 4 + 1] = 18;
    md.data[i * 4 + 2] = 8;
    md.data[i * 4 + 3] = lum > 24 ? 255 : 0;
  }
  mctx.putImageData(md, 0, 0);
  // blur into a soft blob (slightly grown so it peeks past the tree edge)
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.filter = "blur(7px)";
  ctx.drawImage(m, -6, -6, size + 12, size + 12);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.premultiplyAlpha = false;
  return tex;
}

/**
 * Continuous world-space noise in [0,1] for blend-fringe modulation — the
 * reach of a terrain wash varies along the boundary so edges read organic,
 * never as a straight banded frame.
 */
function blendNoise01(x: number, y: number): number {
  const n =
    Math.sin(x * 2.3 + y * 1.7) +
    Math.sin(x * 5.1 - y * 3.3) * 0.5 +
    Math.sin(y * 7.7 + x * 0.9) * 0.25;
  return 0.5 + (n / 1.75) * 0.5;
}

/** Matches scene.ts sun.position (0.85,-0.7,0.55) normalized. */
const SHADE_L: [number, number, number] = [0.69, -0.568, 0.446];
/** dot(L, up) — flat ground shades to exactly 1 so calibration holds. */
const SHADE_FLAT = SHADE_L[2];

/**
 * Baked slope shading from the smooth height-field gradient. Civ5 hills read
 * mainly through strong directional shading; Lambert at our sun angle is too
 * soft, so we bake extra contrast into vertex colors. Sampled per VERTEX
 * (finite differences), not per face — face normals at low tessellation read
 * as shattered triangular shards. 1 on flat ground, brighter on sun-facing
 * slopes, darker on back slopes.
 */
function slopeShade(dzdx: number, dzdy: number, contrast = 1.5): number {
  const len = Math.hypot(dzdx, dzdy, 1);
  const dot = (-dzdx * SHADE_L[0] - dzdy * SHADE_L[1] + SHADE_L[2]) / len;
  const shade = 1 + contrast * (dot - SHADE_FLAT);
  return Math.min(1.35, Math.max(0.5, shade));
}

/**
 * Side-projection repeat scale for triplanar sampling (repeats per world unit).
 * 512px digimap → ~0.9 keeps ≥1 texel/px at play zoom; the old 0.45 stretched
 * one repeat across a whole face and read as a soft smear.
 */
const TRIPLANAR_SIDE_UV = 0.9;

/**
 * Swap the material's planar map lookup for object-space triplanar sampling
 * (meshes carry no transform, so object space is world space; z is up).
 * Steep faces sample the texture projected from the side, so mountain walls
 * get crisp rock instead of the vertical smear planar world UV produces.
 * The top (z) projection keeps DIGIMAP_UV so near-flat ground looks unchanged;
 * the side projections repeat tighter for crispness on tall faces.
 */
function applyTriplanar(mat: THREE.MeshLambertMaterial, cap: THREE.Texture | null): void {
  mat.customProgramCacheKey = () => `civ5-triplanar|${cap ? "cap" : "nocap"}`;
  mat.onBeforeCompile = (shader) => {
    if (cap) shader.uniforms.capMap = { value: cap };
    shader.vertexShader = shader.vertexShader
      .replace(
        "void main() {",
        `varying vec3 vTriPos;\nvarying vec3 vTriNormal;\n${cap ? "attribute float aRelief;\nvarying float vRelief;\n" : ""}void main() {`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\nvTriPos = position;\nvTriNormal = normal;${cap ? "\nvRelief = aRelief;" : ""}`,
      );
    // Snow cap: fade in by altitude, snowline broken up by the rock texture
    // itself; near-vertical crags shed snow (normal-z gate) like the real
    // game's dark rock faces under white ridges.
    const capGlsl = cap
      ? `
  vec4 capX = texture2D(capMap, vTriPos.yz * ${TRIPLANAR_SIDE_UV});
  vec4 capY = texture2D(capMap, vTriPos.xz * ${TRIPLANAR_SIDE_UV});
  vec4 capZ = texture2D(capMap, vTriPos.xy * ${DIGIMAP_UV});
  vec4 capC = capX * triW.x + capY * triW.y + capZ * triW.z;
  // snowline: crest-only, edge broken up hard by the rock texture so it
  // reads jagged (the old wide 0.24-0.48 band painted half the massif soft white)
  float snow = smoothstep(0.33, 0.46, vRelief + (triC.r - 0.5) * 0.28);
  snow *= smoothstep(0.12, 0.45, normalize(vTriNormal).z);
  triC = mix(triC, capC, snow);`
      : "";
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "void main() {",
        `varying vec3 vTriPos;\nvarying vec3 vTriNormal;\n${cap ? "uniform sampler2D capMap;\nvarying float vRelief;\n" : ""}void main() {`,
      )
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
  vec3 triW = abs(normalize(vTriNormal));
  triW = pow(triW, vec3(4.0));
  triW /= triW.x + triW.y + triW.z;
  vec4 triX = texture2D(map, vTriPos.yz * ${TRIPLANAR_SIDE_UV});
  vec4 triY = texture2D(map, vTriPos.xz * ${TRIPLANAR_SIDE_UV});
  vec4 triZ = texture2D(map, vTriPos.xy * ${DIGIMAP_UV});
  vec4 triC = triX * triW.x + triY * triW.y + triZ * triW.z;
  // high-freq detail octave on the SIDE projections only: crisp rock grain
  // at close zoom (the near-flat rim keeps matching the ground paint).
  float sideW = triW.x + triW.y;
  if (sideW > 0.03) {
    vec3 detX = texture2D(map, vTriPos.yz * ${TRIPLANAR_SIDE_UV * 2.7}).rgb;
    vec3 detY = texture2D(map, vTriPos.xz * ${TRIPLANAR_SIDE_UV * 2.7}).rgb;
    vec3 det = (detX * triW.x + detY * triW.y) / sideW;
    float detLum = dot(det, vec3(0.299, 0.587, 0.114));
    triC.rgb *= mix(1.0, 0.55 + 1.05 * detLum, sideW * 0.85);
  }${capGlsl}
  diffuseColor *= triC;
#endif`,
      );
  };
}

/**
 * Seabed material: the sand digimap (map) washes into the green reef floor
 * (euro_shallow_seas) as the bottom deepens — Civ5's coast look is this reef
 * texture seen through shallow water. Blend keys on world z so it follows the
 * welded seabed geometry, not hex edges.
 */
function applySeabedBlend(mat: THREE.MeshLambertMaterial, reefMap: THREE.Texture): void {
  mat.customProgramCacheKey = () => "civ5-seabed";
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.reefMap = { value: reefMap };
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "varying vec3 vSeaPos;\nvoid main() {")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSeaPos = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "void main() {",
        "uniform sampler2D reefMap;\nvarying vec3 vSeaPos;\nvoid main() {",
      )
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
  vec2 seaUv = vSeaPos.xy * ${DIGIMAP_UV};
  vec4 sandC = texture2D(map, seaUv);
  vec4 reefC = texture2D(reefMap, seaUv);
  // narrow sandy fringe at the waterline, reef floor right after. The band
  // edge is wobbled by texture noise: the welded dome's sector kinks
  // otherwise draw the sand/reef boundary as straight polygon arcs.
  // low-freq octave meanders the boundary, speckle octave roughens it
  float seaN = (texture2D(map, seaUv * 0.31).g - 0.5) * 0.035
             + (texture2D(map, seaUv * 3.7).g - 0.5) * 0.02;
  float reefW = smoothstep(0.008, 0.07, -vSeaPos.z + seaN);
  diffuseColor *= mix(sandC, reefC, reefW);
#endif`,
      );
  };
}

/**
 * Land material shore pass, mirroring the seabed material: a narrow beach
 * strip at the waterline, and below it the SAME sand→reef floor at the SAME
 * effective gain — the submerged rim of land tiles must be pixel-identical
 * to the neighbouring water tiles' floor or the hex edge shows as a seam.
 * Inland ground never reaches the band — land centers are clamped to
 * LAND_MIN_H and shoreline corners are capped at SHORE_CORNER_Z.
 */
function applyShoreSand(
  mat: THREE.MeshLambertMaterial,
  sandMap: THREE.Texture,
  reefMap: THREE.Texture,
  gain?: [number, number, number],
): void {
  const g = gain ?? [1.05, 1.05, 1.05];
  mat.customProgramCacheKey = () => "civ5-shore-sand";
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.sandMap = { value: sandMap };
    shader.uniforms.reefMap = { value: reefMap };
    // material color (per-terrain gain) multiplies diffuse before the map;
    // scale floor samples by WATER_GAIN/gain so they land at WATER_GAIN net
    shader.uniforms.floorGain = {
      value: new THREE.Vector3(
        WATER_GAIN[0] / g[0],
        WATER_GAIN[1] / g[1],
        WATER_GAIN[2] / g[2],
      ),
    };
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "varying vec3 vShorePos;\nvoid main() {")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvShorePos = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "void main() {",
        "uniform sampler2D sandMap;\nuniform sampler2D reefMap;\nuniform vec3 floorGain;\nvarying vec3 vShorePos;\nvoid main() {",
      )
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
  vec4 shoreTexC = texture2D(map, vMapUv);
  // narrow beach strip hugging the waterline, edge wobbled by texture noise
  // so it doesn't trace the welded dome's straight sector contours
  vec2 shoreUv = vShorePos.xy * ${DIGIMAP_UV};
  // same two-octave wobble as the seabed material so the bands line up
  float shoreN = (texture2D(sandMap, shoreUv * 0.31).g - 0.5) * 0.035
               + (texture2D(sandMap, shoreUv * 3.7).g - 0.5) * 0.02;
  float sandW = 1.0 - smoothstep(0.004, 0.02, vShorePos.z + shoreN * 0.5);
  if (sandW > 0.001) {
    // same floor formula as the seabed material (sand → reef with depth)
    vec4 sandC = texture2D(sandMap, shoreUv);
    vec4 reefC = texture2D(reefMap, shoreUv);
    float reefW = smoothstep(0.008, 0.07, -vShorePos.z + shoreN);
    vec4 floorC = mix(sandC, reefC, reefW);
    floorC.rgb *= floorGain;
    shoreTexC = mix(shoreTexC, floorC, sandW);
  }
  diffuseColor *= shoreTexC;
#endif`,
      );
  };
}

/**
 * Tiles the translucent water surface must cover: every water tile, plus any
 * land tile whose welded rim dips to (or below) the waterline — the organic
 * shoreline contour crosses INSIDE those tiles, so the surface has to reach in
 * to meet it.
 */
export function needsWaterSurface(s: Civ5TileSpec): boolean {
  const look = lookFor(s.baseTerrain, s.features);
  if (look.water) return true;
  if (!s.cornerHeights) return false;
  // 0.07 margin: shoreWobble (±0.04) can pull near-shore land below the
  // waterline between its corners — those lagoon dips need surface cover
  return Math.min(...s.cornerHeights) < 0.07;
}

export class Civ5TileKit {
  private digimapCache = new Map<string, THREE.Texture>();
  private heightCache = new Map<string, HeightField | null>();
  private forestFrames: THREE.Texture[] = [];
  private jungleFrames: THREE.Texture[] = [];
  /** forest_tile1..4 placement masks (R channel = canopy validity) */
  private forestMasks: HeightField[] = [];
  /** mask × leaf-litter textures for ground (alpha = mask) */
  private forestGroundTex: THREE.Texture[] = [];
  /** blurred dark contact-shadow stamps (one per forest_tile mask) */
  private forestShadowTex: THREE.Texture[] = [];
  private jungleOverlayTex: THREE.Texture | null = null;
  private corners = hexCornerVectors();
  ready = false;

  async init(): Promise<void> {
    const [forestImg, jungleImg, overlayImg, jungleOverlayImg, ...tileImgs] = await Promise.all([
      loadImage(ROOT + "forest_europe.png"),
      loadImage(ROOT + "jungle_europe.png"),
      loadImage(ROOT + "forest_overlay_europe.png"),
      loadImage(ROOT + "jungle_overlay_europe.png"),
      loadImage(ROOT + "forest_tile1.png"),
      loadImage(ROOT + "forest_tile2.png"),
      loadImage(ROOT + "forest_tile3.png"),
      loadImage(ROOT + "forest_tile4.png"),
    ]);
    if (forestImg) this.forestFrames = cropAtlasFrames(forestImg, "forest");
    if (jungleImg) this.jungleFrames = cropAtlasFrames(jungleImg, "jungle");
    if (jungleOverlayImg) {
      this.jungleOverlayTex = new THREE.Texture(jungleOverlayImg);
      this.jungleOverlayTex.colorSpace = THREE.SRGBColorSpace;
      this.jungleOverlayTex.wrapS = this.jungleOverlayTex.wrapT = THREE.ClampToEdgeWrapping;
      this.jungleOverlayTex.needsUpdate = true;
    }
    for (const img of tileImgs) {
      if (!img) continue;
      const { data, w, h } = imageToRgba(img);
      this.forestMasks.push({ data, w, h, hScale: 1, flat: false });
      // ground stamp: overlay color × mask alpha (no full-hex dark plate)
      this.forestGroundTex.push(
        compositeCanopyMass(img, overlayImg, [42, 78, 32]),
      );
      this.forestShadowTex.push(buildShadowStamp(img));
    }
    this.ready = true;
  }

  /**
   * Load digimap albedo. Civ5 digimaps store non-color data in alpha (~60–90);
   * that channel is NOT opacity — treating it as such muddies grass. Bake
   * A=255; color stays untouched (per-terrain calibration lives in look.gain).
   */
  private async digimap(file: string): Promise<THREE.Texture> {
    const cached = this.digimapCache.get(file);
    if (cached) return cached;

    const img = await loadImage(ROOT + file);
    if (!img) {
      // solid fallback so missing assets don't black-out the map
      const t = new THREE.Texture();
      t.colorSpace = THREE.SRGBColorSpace;
      this.digimapCache.set(file, t);
      return t;
    }
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, c.width, c.height);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    this.digimapCache.set(file, t);
    return t;
  }

  async heightField(files: string[], hScale: number, flat: boolean): Promise<HeightField | null> {
    if (files.length === 0 || flat) {
      return { data: new Uint8ClampedArray(4), w: 1, h: 1, hScale, flat: true };
    }
    const file = files[0]!;
    const cacheKey = `${file}|${hScale}`;
    if (this.heightCache.has(cacheKey)) return this.heightCache.get(cacheKey)!;
    const img = await loadImage(ROOT + file);
    if (!img) {
      this.heightCache.set(cacheKey, null);
      return null;
    }
    const { data, w, h } = imageToRgba(img);
    let min = 255;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const v = data[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const isFlat = max - min < 3 || min > 180;
    const hf: HeightField = {
      data,
      w,
      h,
      hScale: isFlat ? 0.04 : hScale,
      flat: isFlat,
    };
    this.heightCache.set(cacheKey, hf);
    return hf;
  }

  pickHeightFile(look: TerrainLook, key: string): string | null {
    if (look.heights.length === 0) return null;
    const i = hashKey(key) % look.heights.length;
    return look.heights[i]!;
  }

  private async resolveHf(look: TerrainLook, key: string): Promise<HeightField | null> {
    const hfFile = this.pickHeightFile(look, key);
    return this.heightField(hfFile ? [hfFile] : [], look.hScale, look.flat || !hfFile);
  }

  /**
   * Build merged geometry for a group of tiles sharing the same digimap.
   * Heights: welded board base when present, else piece heightmap.
   * Albedo uses world UV.
   */
  async buildTerrainMesh(
    tiles: Civ5TileSpec[],
    opts: { divs?: number; foliage?: FoliageQuality } = {},
  ): Promise<THREE.Group> {
    const group = new THREE.Group();
    const divs = opts.divs ?? TILE_DIVS;
    const foliage = opts.foliage ?? (divs >= 14 ? "detail" : "full");

    // Group by material identity (digimap + gain + water) so one mesh/material
    // serves the group — but every tile keeps its OWN look: flat and hill
    // variants of a terrain share the digimap, and collapsing them to the
    // group's look gave hills to flats (or flattened hills) by iteration order.
    const byMat = new Map<
      string,
      { specs: Civ5TileSpec[]; looks: TerrainLook[]; look: TerrainLook }
    >();
    for (const t of tiles) {
      const look = lookFor(t.baseTerrain, t.features);
      const matKey = `${look.digimap}|${look.water ? "w" : ""}|${(look.gain ?? []).join(",")}`;
      const g = byMat.get(matKey) ?? { specs: [], looks: [], look };
      g.specs.push(t);
      g.looks.push(look);
      byMat.set(matKey, g);
    }

    for (const { specs, looks, look: matLook } of byMat.values()) {
      const hfByKey = new Map<string, HeightField | null>();
      for (let si = 0; si < specs.length; si++) {
        const s = specs[si]!;
        if (!hfByKey.has(s.key)) {
          hfByKey.set(s.key, await this.resolveHf(looks[si]!, s.key));
        }
      }
      // mountains: double tessellation — the peak spike in the 128px piece
      // heightmap aliases into zigzag "teeth" at base tessellation. Floor at
      // chunk quality (TILE_DIVS*2): at full-map divs (8→16) the peaks melt,
      // and mountains are rare enough that full tessellation stays cheap.
      // Safe vs blend skirts: they only drape over LOWER-priority neighbours,
      // and mountains are top priority, so nothing samples this mesh at `divs`.
      const d = matLook.triplanar ? Math.max(divs, TILE_DIVS) * 2 : divs;
      const tPer = 6 * d * d;
      const positions = new Float32Array(specs.length * tPer * 9);
      const uvs = new Float32Array(specs.length * tPer * 6);
      const colors = new Float32Array(specs.length * tPer * 9);
      const normals = new Float32Array(specs.length * tPer * 9);
      // relief above the tile's own base — snow-cap altitude must not read
      // absolute z (the welded board base lifts whole mountain tiles, which
      // painted them solid white on the full map)
      const reliefs = matLook.triplanar ? new Float32Array(specs.length * tPer * 3) : null;
      let p = 0;
      let u = 0;
      let cw = 0;
      let nw = 0;
      let rw = 0;

      for (let si = 0; si < specs.length; si++) {
        const s = specs[si]!;
        const look = looks[si]!;
        const hf = hfByKey.get(s.key) ?? null;
        const cx = s.world.x;
        const cy = s.world.y;

        for (let sec = 0; sec < 6; sec++) {
          const a = this.corners[sec]!;
          const b = this.corners[(sec + 1) % 6]!;
          const point = (
            i: number,
            j: number,
          ): [number, number, number, number, number, number, number, number] => {
            const lx = ((i * a.x + j * b.x) / d) * OVERLAP;
            const ly = ((i * a.y + j * b.y) / d) * OVERLAP;
            const hAt = (x: number, y: number) =>
              terrainHeightAt(s, look, hf, this.corners, x, y);
            const z = hAt(lx / OVERLAP, ly / OVERLAP);
            // piece relief above this tile's base (hf=null → base surface)
            const relief = reliefs
              ? z - terrainHeightAt(s, look, null, this.corners, lx / OVERLAP, ly / OVERLAP)
              : 0;
            // smooth hillshade + analytic normal from the height gradient.
            // The merged mesh is unindexed triangle soup, so
            // computeVertexNormals() would give per-FACE normals — flat
            // shaded facets that read as chiseled shards on mountains.
            // mountains: finer step (128px piece ≈ 0.016/texel — 0.06
            // averaged 4 texels and melted the crags) + harder contrast.
            // Water gets it too: the seabed is real sloped geometry now.
            const e = look.triplanar ? 0.02 : 0.06;
            const dzdx = (hAt(lx / OVERLAP + e, ly / OVERLAP) - z) / e;
            const dzdy = (hAt(lx / OVERLAP, ly / OVERLAP + e) - z) / e;
            let shade = slopeShade(dzdx, dzdy, look.triplanar ? 2.1 : 1.5);
            // the shore drop is the steepest slope on the map — full hillshade
            // painted a charcoal band along every waterline. Flatten shading
            // progressively below the surface; light underwater diffuses.
            if (z < 0.02) {
              const soften = Math.min(1, (0.02 - z) / 0.1);
              shade += (1 - shade) * soften * 0.5;
            }
            const inv = 1 / Math.hypot(dzdx, dzdy, 1);
            const nx = -dzdx * inv;
            const ny = -dzdy * inv;
            const nz = inv;
            return [cx + lx, cy + ly, z, shade, nx, ny, nz, relief];
          };
          for (let i = 0; i < d; i++) {
            for (let j = 0; j < d - i; j++) {
              const emit = (i0: number, j0: number, i1: number, j1: number, i2: number, j2: number) => {
                for (const [ii, jj] of [
                  [i0, j0],
                  [i1, j1],
                  [i2, j2],
                ] as const) {
                  const [x, y, z, shade, nx, ny, nz, relief] = point(ii, jj);
                  positions[p++] = x;
                  positions[p++] = y;
                  positions[p++] = z;
                  uvs[u++] = x * DIGIMAP_UV;
                  uvs[u++] = y * DIGIMAP_UV;
                  colors[cw++] = shade;
                  colors[cw++] = shade;
                  colors[cw++] = shade;
                  normals[nw++] = nx;
                  normals[nw++] = ny;
                  normals[nw++] = nz;
                  if (reliefs) reliefs[rw++] = relief;
                }
              };
              emit(i, j, i, j + 1, i + 1, j);
              if (j < d - i - 1) emit(i + 1, j, i, j + 1, i + 1, j + 1);
            }
          }
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
      if (reliefs) geo.setAttribute("aRelief", new THREE.BufferAttribute(reliefs, 1));

      const map = await this.digimap(matLook.digimap);
      const mat = new THREE.MeshLambertMaterial({
        map,
        // calibrated per-terrain gain (see TerrainLook.gain)
        color: new THREE.Color(...(matLook.gain ?? [1.05, 1.05, 1.05])),
        // baked hillshade lives in vertex colors
        vertexColors: true,
      });
      if (matLook.water) {
        // opaque seabed: sand at the shore, reef floor as it deepens.
        // The water itself is a separate translucent surface at z=0.
        applySeabedBlend(mat, await this.digimap("euro_shallow_seas_d.png"));
      } else if (matLook.triplanar) {
        const cap = matLook.capDigimap ? await this.digimap(matLook.capDigimap) : null;
        applyTriplanar(mat, cap);
      } else if (specs.some((s) => s.cornerHeights)) {
        // land near the waterline gets the same beach + underwater floor as
        // the seabed material. Welded boards only: standalone tiles
        // (chunk/gallery) all rest at FLAT_Z ≈ the sand band, which bleached
        // the whole demo beige.
        applyShoreSand(
          mat,
          await this.digimap("euro_coast_d.png"),
          await this.digimap("euro_shallow_seas_d.png"),
          matLook.gain,
        );
      }

      group.add(new THREE.Mesh(geo, mat));
    }

    // translucent depth-tinted water surface over everything below z=0
    const water = await this.buildWaterSurface(tiles, divs);
    if (water) group.add(water);

    // land-land terrain blending (Civ5-style continuous ground wash)
    group.add(await this.buildBlendSkirts(tiles, divs));

    await this.addFeatureLayers(group, tiles, foliage);
    return group;
  }

  /** Texture loaded verbatim (digimap() bakes A=255 — the depth LUT NEEDS its alpha ramp). */
  private async rawTexture(file: string, srgb: boolean, clamp: boolean): Promise<THREE.Texture | null> {
    const img = await loadImage(ROOT + file);
    if (!img) return null;
    const t = new THREE.Texture(img);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  }

  /**
   * Translucent water surface at z=0, Civ5-style: per-vertex seabed depth
   * drives Firaxis' waterdepthcolor LUT — its RGB is the shallow-teal → deep-
   * navy tint and its ALPHA is the baked opacity ramp (transparent over the
   * sandy shallows, solid over the ocean floor). Fragments where the terrain
   * rises above the waterline are discarded, so the water's edge is the
   * seabed's z=0 contour, with animated lapping foam hugging it. waterbumps
   * scrolls as a normal map for sun shimmer.
   */
  private async buildWaterSurface(
    tiles: Civ5TileSpec[],
    divs: number,
  ): Promise<THREE.Mesh | null> {
    const wet = tiles.filter(needsWaterSurface);
    if (wet.length === 0) return null;
    // LUT stays NON-sRGB on purpose: skipping the decode while the renderer
    // still encodes output ≈ a gamma lift that lands Firaxis' navy at Civ5's
    // rendered water tones — with hardware decode, ACES crushed it to black.
    const lut = await this.rawTexture("waterdepthcolor.png", false, true);
    const bumps = await this.rawTexture("waterbumps.png", false, false);
    if (!lut) return null;

    const tPer = 6 * divs * divs;
    const positions = new Float32Array(wet.length * tPer * 9);
    const uvs = new Float32Array(wet.length * tPer * 6);
    const normals = new Float32Array(wet.length * tPer * 9);
    const depths = new Float32Array(wet.length * tPer * 3);
    let p = 0;
    let u = 0;
    let nw = 0;
    let dw = 0;

    for (const s of wet) {
      const look = lookFor(s.baseTerrain, s.features);
      for (let sec = 0; sec < 6; sec++) {
        const a = this.corners[sec]!;
        const b = this.corners[(sec + 1) % 6]!;
        const emit = (i: number, j: number) => {
          const lx = ((i * a.x + j * b.x) / divs) * OVERLAP;
          const ly = ((i * a.y + j * b.y) / divs) * OVERLAP;
          const x = s.world.x + lx;
          const y = s.world.y + ly;
          // piece hf omitted: near the waterline flat land and seabed follow
          // the welded base exactly; hill detail only matters far above it
          const depth = -terrainHeightAt(s, look, null, this.corners, lx / OVERLAP, ly / OVERLAP);
          positions[p++] = x;
          positions[p++] = y;
          positions[p++] = 0;
          uvs[u++] = x * DIGIMAP_UV;
          uvs[u++] = y * DIGIMAP_UV;
          normals[nw++] = 0;
          normals[nw++] = 0;
          normals[nw++] = 1;
          depths[dw++] = depth;
        };
        for (let i = 0; i < divs; i++) {
          for (let j = 0; j < divs - i; j++) {
            emit(i, j);
            emit(i, j + 1);
            emit(i + 1, j);
            if (j < divs - i - 1) {
              emit(i + 1, j);
              emit(i, j + 1);
              emit(i + 1, j + 1);
            }
          }
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geo.setAttribute("aDepth", new THREE.BufferAttribute(depths, 1));

    // NO normal map: at map zoom its minified high-freq field aliases into
    // hard binary speckle across the whole ocean (diffuse AND specular) — a
    // flat surface gives a clean broad sun sheen instead. waterbumps is only
    // sampled as plain noise to animate the foam fringe.
    const mat = new THREE.MeshPhongMaterial({
      transparent: true,
      specular: new THREE.Color(0x3a4c58),
      shininess: 60,
    });
    const uTime = { value: 0 };
    mat.customProgramCacheKey = () => `civ5-water|${bumps ? "b" : ""}`;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.depthLut = { value: lut };
      shader.uniforms.uTime = uTime;
      if (bumps) shader.uniforms.bumpsTex = { value: bumps };
      shader.vertexShader = shader.vertexShader
        .replace(
          "void main() {",
          "attribute float aDepth;\nvarying float vDepth;\nvarying vec2 vWaterUv;\nvoid main() {",
        )
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvDepth = aDepth;\nvWaterUv = uv;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "void main() {",
          `uniform sampler2D depthLut;\nuniform float uTime;\n${bumps ? "uniform sampler2D bumpsTex;\n" : ""}varying float vDepth;\nvarying vec2 vWaterUv;\nvoid main() {`,
        )
        .replace(
          "#include <map_fragment>",
          `
  if (vDepth <= 0.0) discard;
  float relD = clamp(vDepth / 0.33, 0.0, 1.0);
  // LUT u: seabed depth vs full-ocean reference; pow widens the shallow band
  float dT = pow(relD, 0.7);
  vec4 lutC = texture2D(depthLut, vec2(mix(0.02, 0.98, dT), 0.5));
  // opacity: Firaxis' baked alpha ramp, but pushed deeper — Civ5 coast water
  // is glassy enough to read the reef floor through it. Fully opaque over the
  // deep ocean: the output gamma lift turns even a 4% seabed leak into
  // visible speckle.
  float aU = mix(0.02, 0.98, pow(relD, 1.3));
  float waterA = max(texture2D(depthLut, vec2(aU, 0.5)).a, 0.3);
  waterA = mix(waterA, 1.0, smoothstep(0.6, 0.95, relD));
${
  bumps
    ? `  // lapping foam: waterline band, broken and animated by the bump texture
  float foamN1 = texture2D(bumpsTex, vWaterUv * 1.7 + vec2(uTime * 0.010, uTime * 0.006)).g;
  float foamN2 = texture2D(bumpsTex, vWaterUv * 3.1 - vec2(uTime * 0.007, uTime * 0.011)).g;
  float foamEdge = 1.0 - smoothstep(0.0, 0.035, vDepth);
  float foam = foamEdge * smoothstep(0.35, 0.7, 0.5 * (foamN1 + foamN2) + foamEdge * 0.5);`
    : "  float foam = 0.0;"
}
  diffuseColor = vec4(mix(lutC.rgb, vec3(0.94, 0.97, 0.98), foam), max(waterA, foam * 0.9));`,
        );
    };

    const mesh = new THREE.Mesh(geo, mat);
    mesh.onBeforeRender = () => {
      uTime.value = (performance.now() % 3600000) / 1000;
    };
    return mesh;
  }

  /**
   * Where two land digimaps meet, the higher blendPriority terrain paints an
   * alpha-fading skirt over its neighbour in continuous world UV — grass
   * washes into plains over ~half a hex instead of stopping at the hex edge.
   * Reach is noise-modulated so the fringe reads organic, and heights/shade
   * are sampled from the NEIGHBOUR's surface so the wash lies on its ground.
   */
  private async buildBlendSkirts(tiles: Civ5TileSpec[], divs: number): Promise<THREE.Group> {
    const group = new THREE.Group();
    const posKey = (x: number, y: number) => `${Math.round(x * 100)}|${Math.round(y * 100)}`;
    const byPos = new Map<string, Civ5TileSpec>();
    for (const t of tiles) byPos.set(posKey(t.world.x, t.world.y), t);

    interface Batch {
      positions: number[];
      uvs: number[];
      colors: number[];
      look: TerrainLook;
    }
    const batches = new Map<string, Batch>();

    const E = 12; // segments along the edge
    const R = 6; // rows across the blend band
    const DEPTH = 0.62; // how far the wash reaches into the neighbour
    const EXT = 0.1; // spill past edge ends so 3-way corners are covered
    const LIFT = 0.004;

    for (const s of tiles) {
      const lookS = lookFor(s.baseTerrain, s.features);
      if (lookS.water || lookS.blendPriority === undefined) continue;
      for (let i = 0; i < 6; i++) {
        const c1 = this.corners[i]!;
        const c2 = this.corners[(i + 1) % 6]!;
        // corner[i]..corner[i+1] bound the edge facing neighbour i;
        // twice the edge midpoint is that neighbour's center offset
        const midx = (c1.x + c2.x) / 2;
        const midy = (c1.y + c2.y) / 2;
        const n = byPos.get(posKey(s.world.x + midx * 2, s.world.y + midy * 2));
        if (!n) continue;
        const lookN = lookFor(n.baseTerrain, n.features);
        if (lookN.water || lookN.digimap === lookS.digimap) continue;
        if ((lookS.blendPriority ?? 0) <= (lookN.blendPriority ?? 0)) continue;

        const hfN = await this.resolveHf(lookN, n.key);
        const depthS = lookS.blendDepth ?? DEPTH;
        const dlen = Math.hypot(midx, midy);
        const ox = midx / dlen;
        const oy = midy / dlen;

        let batch = batches.get(lookS.digimap);
        if (!batch) {
          batch = { positions: [], uvs: [], colors: [], look: lookS };
          batches.set(lookS.digimap, batch);
        }

        type Pt = { x: number; y: number; z: number; shade: number; a: number };
        const grid: Pt[][] = [];
        for (let r = 0; r <= R; r++) {
          const row: Pt[] = [];
          for (let e = 0; e <= E; e++) {
            const t = -EXT + (e / E) * (1 + 2 * EXT);
            const bx = c1.x + (c2.x - c1.x) * t;
            const by = c1.y + (c2.y - c1.y) * t;
            const d = (r / R) * depthS;
            const wx = s.world.x + bx + ox * d;
            const wy = s.world.y + by + oy * d;
            const lx = wx - n.world.x;
            const ly = wy - n.world.y;
            const hAt = (x: number, y: number) =>
              terrainHeightAt(n, lookN, hfN, this.corners, x, y);
            const h0 = hAt(lx, ly);
            const eps = 0.06;
            const shade = slopeShade((hAt(lx + eps, ly) - h0) / eps, (hAt(lx, ly + eps) - h0) / eps);
            // organic reach: noise SHRINKS the wash along the edge. It must
            // never stretch it (old cap 1.35): any m>1 left alpha>0 on the
            // outer row, ending the fringe in a visible hard line.
            const m = 0.55 + 0.45 * blendNoise01(wx, wy);
            const f = Math.min(1, r / R / m);
            // steeper falloff + dappled breakup: the old 1.4 curve held a wide
            // half-transparent zone that read as a milky film on bright desert
            let a = Math.pow(1 - f, 1.9) * (0.78 + 0.44 * blendNoise01(wx * 3.7 + 11.3, wy * 3.7 - 5.1));
            // feather the strip ends across the EXT spill so 3-way corners
            // never expose a hard side cut of the band
            a *= Math.min(1, (t + EXT) / (EXT + 0.06)) * Math.min(1, (1 + EXT - t) / (EXT + 0.06));
            a = Math.min(1, Math.max(0, a));
            // sit on the tessellated mesh surface, not the analytic one
            const zMesh = meshHeightAt(n, lookN, hfN, this.corners, divs, lx, ly);
            row.push({ x: wx, y: wy, z: zMesh + LIFT, shade, a });
          }
          grid.push(row);
        }
        for (let r = 0; r < R; r++) {
          for (let e = 0; e < E; e++) {
            const q = [grid[r]![e]!, grid[r]![e + 1]!, grid[r + 1]![e]!, grid[r + 1]![e + 1]!];
            for (const idx of [0, 1, 2, 2, 1, 3] as const) {
              const v = q[idx]!;
              batch.positions.push(v.x, v.y, v.z);
              // triplanar terrains (mountain rock) wash at the tight side-
              // projection scale: the flat 0.16 world UV stretched the rock
              // into a blurry grey film over crisp neighbour ground
              const uvScale = lookS.triplanar ? TRIPLANAR_SIDE_UV : DIGIMAP_UV;
              batch.uvs.push(v.x * uvScale, v.y * uvScale);
              batch.colors.push(v.shade, v.shade, v.shade, v.a);
            }
          }
        }
      }
    }

    for (const [digi, b] of batches) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(b.positions), 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(b.uvs), 2));
      geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(b.colors), 4));
      geo.computeVertexNormals();
      const map = await this.digimap(digi);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshLambertMaterial({
          map,
          color: new THREE.Color(...(b.look.gain ?? [1.05, 1.05, 1.05])),
          transparent: true,
          vertexColors: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        }),
      );
      mesh.renderOrder = 0.5;
      group.add(mesh);
    }
    return group;
  }

  private async addFeatureLayers(
    group: THREE.Group,
    tiles: Civ5TileSpec[],
    quality: FoliageQuality,
  ): Promise<void> {
    const forestTiles = tiles.filter((t) => t.features.includes("Forest"));
    const jungleTiles = tiles.filter((t) => t.features.includes("Jungle"));

    // LOD: hero approaches forests.xml (360); full map keeps a sparse stand.
    const targetTrees =
      quality === "hero"
        ? FOREST_CFG.randomTreesPerTile
        : quality === "detail"
          ? Math.round(FOREST_CFG.randomTreesPerTile * 0.4)
          : Math.round(FOREST_CFG.randomTreesPerTile * 0.12);
    // Slightly larger round cards; density still high via tight poisson spacing
    const scaleRange: [number, number] =
      quality === "hero" ? [0.18, 0.3] : quality === "detail" ? [0.2, 0.32] : [0.22, 0.36];

    // Layering (renderOrder + polygonOffset): digimap terrain is 0.
    // 1) Contact shadow (blurred dark mask stamp — grounds the stand, real
    //    Civ5 does this under every forest/jungle; hides trunk bottoms)
    // 2) Masked ground leaf-litter (never a full-hex dark wash)
    // 3) Tree / jungle sprites
    if (this.forestShadowTex.length) {
      if (forestTiles.length) {
        const shadow = this.buildMaskedGroundOverlay(forestTiles, 0.65, this.forestShadowTex, 0.003);
        group.add(shadow);
      }
      if (jungleTiles.length) {
        // jungle mass is darker → heavier shadow
        const shadow = this.buildMaskedGroundOverlay(jungleTiles, 0.75, this.forestShadowTex, 0.003);
        group.add(shadow);
      }
    }
    if (forestTiles.length && this.forestGroundTex.length) {
      const litter = this.buildMaskedGroundOverlay(forestTiles, FOREST_CFG.overlayAlpha);
      litter.renderOrder = 1;
      group.add(litter);
    }
    if (jungleTiles.length) {
      // Dark understory so jungle reads continuous even between crowns
      if (this.jungleOverlayTex) {
        const litter = this.buildLocalUvHexMesh(
          jungleTiles,
          this.jungleOverlayTex,
          0.0035,
          0.5,
          true,
        );
        litter.renderOrder = 1;
        group.add(litter);
      }
    }

    if (forestTiles.length && this.forestFrames.length) {
      const trees = this.buildForestStand(forestTiles, this.forestFrames, targetTrees, scaleRange, {
        useMask: true,
        // Matched against a real Civ5 frame capture: canopy mean RGB ≈ (70,76,39),
        // warm olive with B/G ≈ 0.52 — the old pale-sage tint read cold/washed.
        tint: 0x9d9152,
      });
      trees.renderOrder = 2;
      group.add(trees);
    }
    if (jungleTiles.length && this.jungleFrames.length) {
      // Jungle: a bit *less* dense than forest (was overpacked), still bushy cards.
      // forest_tile masks keep an organic edge.
      const trees = this.buildForestStand(
        jungleTiles,
        this.jungleFrames,
        Math.round(targetTrees * 0.75),
        [scaleRange[0] * 1.05, scaleRange[1] * 1.15],
        {
          useMask: this.forestMasks.length > 0,
          // Real-game jungle canopy mean RGB ≈ (58,67,42): darker than forest, warm
          tint: 0x687146,
          wider: true,
          pack: 1.05, // slightly looser than forest
        },
      );
      trees.renderOrder = 2;
      group.add(trees);
    }
  }

  /** Rendered surface height at a local offset — foliage placement AND hover picking. */
  groundZ(s: Civ5TileSpec, lx: number, ly: number): number {
    const look = lookFor(s.baseTerrain, s.features);
    const hfFile = this.pickHeightFile(look, s.key);
    const cacheKey = `${hfFile ?? ""}|${look.hScale}`;
    const hf =
      look.flat || !hfFile
        ? ({ data: new Uint8ClampedArray(4), w: 1, h: 1, hScale: look.hScale, flat: true } as HeightField)
        : (this.heightCache.get(cacheKey) ?? null);
    return terrainHeightAt(s, look, hf, this.corners, lx, ly);
  }

  /** Point inside flat-top hex of circumradius 1 (half-plane test). */
  private inHex(lx: number, ly: number, pad = 0.02): boolean {
    for (let i = 0; i < 6; i++) {
      const a = this.corners[i]!;
      const b = this.corners[(i + 1) % 6]!;
      // edge a→b, inward normal points toward center (0,0)
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      // cross (b-a) x (p-a); for CCW corners, inside is cross >= 0
      const cross = ex * (ly - a.y) - ey * (lx - a.x);
      // corners are clockwise in our kit (clock hours) → inside is cross <= 0
      if (cross > pad) return false;
    }
    return true;
  }

  /** Sample forest_tile mask at local offset; 0..1 canopy validity. */
  private sampleMask(mask: HeightField, lx: number, ly: number): number {
    const [u, v] = localToUV(lx, ly);
    return sampleR8(mask.data, mask.w, mask.h, u, v) / 255;
  }

  private maskForTile(key: string): HeightField | null {
    if (this.forestMasks.length === 0) return null;
    return this.forestMasks[hashKey(key) % this.forestMasks.length]!;
  }

  /**
   * Ground leaf litter using mask×overlay textures (organic footprint, not full hex).
   * polygonOffset sits it on digimap without z-fighting.
   */
  private buildMaskedGroundOverlay(
    tiles: Civ5TileSpec[],
    opacity: number,
    texs: THREE.Texture[] = this.forestGroundTex,
    zLift = 0.0035,
  ): THREE.Group {
    const group = new THREE.Group();
    if (texs.length === 0) return group;

    // group tiles by mask variant so we can batch
    const byVar = new Map<number, Civ5TileSpec[]>();
    for (const t of tiles) {
      const vi = hashKey(t.key) % texs.length;
      const arr = byVar.get(vi) ?? [];
      arr.push(t);
      byVar.set(vi, arr);
    }
    for (const [vi, specs] of byVar) {
      const tex = texs[vi]!;
      const mesh = this.buildLocalUvHexMesh(specs, tex, zLift, opacity, false);
      mesh.renderOrder = 1;
      group.add(mesh);
    }
    return group;
  }

  private buildLocalUvHexMesh(
    tiles: Civ5TileSpec[],
    map: THREE.Texture,
    zLift: number,
    opacity: number,
    rotatePerTile: boolean,
  ): THREE.Mesh {
    const divs = 6;
    const tPer = 6 * divs * divs;
    const positions = new Float32Array(tiles.length * tPer * 9);
    const uvs = new Float32Array(tiles.length * tPer * 6);
    let p = 0;
    let u = 0;
    for (const s of tiles) {
      const cx = s.world.x;
      const cy = s.world.y;
      const ang = rotatePerTile ? hash01(s.key, 3) * Math.PI * 2 : 0;
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      for (let sec = 0; sec < 6; sec++) {
        const a = this.corners[sec]!;
        const b = this.corners[(sec + 1) % 6]!;
        const point = (i: number, j: number) => {
          const lx = (i * a.x + j * b.x) / divs;
          const ly = (i * a.y + j * b.y) / divs;
          const z = this.groundZ(s, lx, ly) + zLift;
          const rx = lx * cos - ly * sin;
          const ry = lx * sin + ly * cos;
          const [uu, vv] = localToUV(rx * 0.92, ry * 0.92);
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
      new THREE.MeshBasicMaterial({
        map,
        transparent: true,
        opacity,
        depthWrite: false,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
  }

  /**
   * Firaxis-style forest/jungle stand (forests.xml recipe):
   *   random + min spacing (Poisson rejection), optional forest_tile mask.
   * Camera-facing sprites; density approaches 360/tile on hero.
   */
  private buildForestStand(
    tiles: Civ5TileSpec[],
    frames: THREE.Texture[],
    targetPerTile: number,
    scaleRange: [number, number],
    opts: { useMask?: boolean; tint?: number; wider?: boolean; pack?: number } = {},
  ): THREE.Group {
    const group = new THREE.Group();
    if (frames.length === 0) return group;
    const useMask = opts.useMask ?? true;
    const tint = opts.tint ?? 0xd4e0c4;
    const wider = opts.wider ?? false;
    const pack = opts.pack ?? 1;

    const matByFrame = new Map<THREE.Texture, THREE.SpriteMaterial>();
    for (const tex of frames) {
      matByFrame.set(
        tex,
        new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          depthTest: true,
          depthWrite: false,
          // lower for jungle-soft edges after dilate
          alphaTest: wider ? 0.08 : 0.12,
          sizeAttenuation: true,
          color: new THREE.Color(tint),
        }),
      );
    }

    const maxAttempts = targetPerTile * 55;

    for (const tile of tiles) {
      const mask = useMask ? this.maskForTile(tile.key) : null;
      const placed: { lx: number; ly: number; scale: number }[] = [];
      let attempts = 0;
      let n = 0;

      while (placed.length < targetPerTile && attempts < maxAttempts) {
        attempts++;
        const lx = (hash01(tile.key, 7000 + attempts * 3) * 2 - 1) * 1.05;
        const ly = (hash01(tile.key, 8000 + attempts * 3) * 2 - 1) * 0.95;
        if (!this.inHex(lx, ly, 0.05)) continue;

        if (mask) {
          const m = this.sampleMask(mask, lx, ly);
          // jungle: slightly softer mask threshold so the blob fills
          if (m < (wider ? 0.16 : 0.22)) continue;
        }

        const scale =
          scaleRange[0] + hash01(tile.key, 9000 + n) * (scaleRange[1] - scaleRange[0]);
        const minD = forestMinDist(scale) * pack;

        let ok = true;
        for (const p of placed) {
          const dx = p.lx - lx;
          const dy = p.ly - ly;
          const need = (minD + forestMinDist(p.scale) * pack) * 0.5;
          if (dx * dx + dy * dy < need * need) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;

        placed.push({ lx, ly, scale });
        const gz = this.groundZ(tile, lx, ly);
        const tex = frames[hashKey(tile.key + "|t|" + n) % frames.length]!;
        const mat = matByFrame.get(tex)!;
        const sprite = new THREE.Sprite(mat);
        // Mid-canopy pivot → round bush mass (not poles)
        sprite.center.set(0.5, 0.3);
        sprite.position.set(tile.world.x + lx, tile.world.y + ly, gz + scale * 0.2);
        // Broader than tall for continuous canopy look
        sprite.scale.set(scale * (wider ? 1.2 : 1.08), scale * (wider ? 1.05 : 0.95), 1);
        sprite.renderOrder = 2;
        group.add(sprite);
        n++;
      }
    }
    return group;
  }
}
