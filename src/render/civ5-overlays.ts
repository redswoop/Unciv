/**
 * On-map Civ5 art overlays: resource bubbles, improvement decals/bubbles,
 * natural wonder art, city sprites.
 *
 * All art is real Firaxis strategic-view sprites + ground decals extracted by
 * cli/extract-civ5-assets.py (gitignored). Every Unciv-id → file choice lives
 * in asset-map.json ("civ5" section) — asset choices are data, not code.
 *
 * Draw strategy (thousands of markers must stay cheap):
 *  - bubbles/decals are MERGED flat quads draped on the terrain, one draw
 *    call per texture — no per-frame cost, zoom scales naturally with the map
 *  - only natural wonders (a handful) are THREE.Sprite billboards
 */

import * as THREE from "three";
import type { Vec2 } from "../hex/hex-math";
import { BUBBLE_LOCAL } from "./civ5-tiles";
import assetMap from "./asset-map.json";

/** Minimal tile info the overlay builders need (render-model agnostic). */
export interface OverlayTile {
  world: Vec2;
  key: string;
  baseTerrain: string;
  features: string[];
  resource?: string;
  improvement?: string;
  naturalWonder?: string;
}

/** Rendered ground height at a local offset inside the tile. */
export type GroundZ = (tile: OverlayTile, lx: number, ly: number) => number;

interface Civ5Assets {
  svRoot: string;
  decalRoot: string;
  resourceBubbles: Record<string, string>;
  improvementBubbles: Record<string, string>;
  improvementDecals: Record<string, { crops?: boolean; file?: string; scale?: number }>;
  naturalWonders: Record<string, { file: string; mode: "billboard" | "decal"; scale: number }>;
  citySprites: Record<string, string>;
}

const CIV5 = assetMap.civ5 as unknown as Civ5Assets;

/** Position of the resource bubble inside its tile (Civ5 puts icons up-left). */
const BUBBLE_OFFSET: Vec2 = BUBBLE_LOCAL;
/** Icon size in screen pixels (Civ5's map icons are constant screen size). */
const BUBBLE_PX = 32;
/** World-size clamp: constant screen size, but never dwarf a tile close up. */
const BUBBLE_WORLD_MIN = 0.02;
const BUBBLE_WORLD_MAX = 0.5;

const texCache = new Map<string, THREE.Texture>();

async function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function toTexture(img: HTMLImageElement, srgb: boolean): THREE.Texture {
  const t = new THREE.Texture(img);
  // srgb=false → raw passthrough: our billboard ShaderMaterial writes
  // gl_FragColor without three's tonemapping/encoding chunks, so hardware
  // sRGB decode would double-darken the icons.
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

async function loadTex(url: string, srgb = true): Promise<THREE.Texture | null> {
  const key = `${url}|${srgb}`;
  const cached = texCache.get(key);
  if (cached) return cached;
  const img = await loadImage(url);
  if (!img) return null;
  const t = toTexture(img, srgb);
  texCache.set(key, t);
  return t;
}

/** True when the extracted SV art exists (probe one file). */
export async function civ5OverlayArtAvailable(): Promise<boolean> {
  try {
    const r = await fetch(CIV5.svRoot + "sv_cow.png", { method: "HEAD" });
    return r.ok;
  } catch {
    return false;
  }
}

// ——————————————————— merged flat decal quads ———————————————————

interface DecalSpot {
  tile: OverlayTile;
  /** center offset inside the tile */
  ox: number;
  oy: number;
  /** half-size of the quad */
  r: number;
  /** rotation in radians (0 = upright) */
  rot: number;
}

/**
 * One merged mesh of ground-hugging quads for a shared texture.
 * Each quad is subdivided 3x3 so it drapes over relief without stabbing
 * through hillsides. Lift + polygonOffset keep it above the digimap.
 */
function buildDecalMesh(
  spots: DecalSpot[],
  tex: THREE.Texture,
  groundZ: GroundZ,
  opts: { lift?: number; opacity?: number; renderOrder?: number } = {},
): THREE.Mesh {
  const divs = 3;
  const lift = opts.lift ?? 0.012;
  const quadVerts = divs * divs * 6;
  const positions = new Float32Array(spots.length * quadVerts * 3);
  const uvs = new Float32Array(spots.length * quadVerts * 2);
  let p = 0;
  let u = 0;
  for (const s of spots) {
    const cos = Math.cos(s.rot);
    const sin = Math.sin(s.rot);
    const corner = (i: number, j: number): [number, number, number, number, number] => {
      // unrotated local quad coords in [-r, r]
      const qx = (i / divs) * 2 * s.r - s.r;
      const qy = (j / divs) * 2 * s.r - s.r;
      const lx = s.ox + qx * cos - qy * sin;
      const ly = s.oy + qx * sin + qy * cos;
      const z = groundZ(s.tile, lx, ly) + lift;
      return [s.tile.world.x + lx, s.tile.world.y + ly, z, i / divs, j / divs];
    };
    for (let i = 0; i < divs; i++) {
      for (let j = 0; j < divs; j++) {
        const quad = [
          corner(i, j),
          corner(i + 1, j),
          corner(i + 1, j + 1),
          corner(i, j),
          corner(i + 1, j + 1),
          corner(i, j + 1),
        ];
        for (const [x, y, z, uu, vv] of quad) {
          positions[p++] = x;
          positions[p++] = y;
          positions[p++] = z;
          uvs[u++] = uu;
          uvs[u++] = vv;
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: opts.opacity ?? 1,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = opts.renderOrder ?? 3;
  return mesh;
}

function hashKey(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function hash01(key: string, salt: number): number {
  return (hashKey(`${key}|${salt}`) >>> 0) / 0x100000000;
}

// ——————————————————— icon-bubble billboards ———————————————————

/**
 * Merged screen-facing billboard quads sharing one texture: one draw call for
 * ALL tiles carrying the same resource. The vertex shader billboards each
 * quad around its anchor and keeps it a constant SCREEN size (Civ5 map icons
 * are UI, not terrain paint), clamped so icons neither dwarf tiles up close
 * nor vanish at map zoom.
 */
function buildBillboardMesh(
  anchors: { x: number; y: number; z: number }[],
  tex: THREE.Texture,
  pxSize: number,
): THREE.Mesh {
  const n = anchors.length;
  const centers = new Float32Array(n * 4 * 3);
  const corners = new Float32Array(n * 4 * 2);
  const uvs = new Float32Array(n * 4 * 2);
  const index: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = anchors[i]!;
    const quadCorners = [
      [-0.5, -0.5, 0, 0],
      [0.5, -0.5, 1, 0],
      [0.5, 0.5, 1, 1],
      [-0.5, 0.5, 0, 1],
    ] as const;
    for (let c = 0; c < 4; c++) {
      centers[(i * 4 + c) * 3] = a.x;
      centers[(i * 4 + c) * 3 + 1] = a.y;
      centers[(i * 4 + c) * 3 + 2] = a.z;
      corners[(i * 4 + c) * 2] = quadCorners[c]![0];
      corners[(i * 4 + c) * 2 + 1] = quadCorners[c]![1];
      uvs[(i * 4 + c) * 2] = quadCorners[c]![2];
      uvs[(i * 4 + c) * 2 + 1] = quadCorners[c]![3];
    }
    const b = i * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(centers, 3));
  geo.setAttribute("aCorner", new THREE.BufferAttribute(corners, 2));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(index);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: tex },
      // world units per pixel at view-depth 1 — set per frame by the caller
      uScalePerZ: { value: 0.001 },
      uPx: { value: pxSize },
      uMinW: { value: BUBBLE_WORLD_MIN },
      uMaxW: { value: BUBBLE_WORLD_MAX },
    },
    vertexShader: `
      attribute vec2 aCorner;
      uniform float uScalePerZ;
      uniform float uPx;
      uniform float uMinW;
      uniform float uMaxW;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float size = clamp(uPx * uScalePerZ * -mv.z, uMinW, uMaxW);
        mv.xy += aCorner * size;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(map, vUv);
        if (c.a < 0.04) discard;
        gl_FragColor = c;
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  return mesh;
}

export interface BubbleLayer {
  group: THREE.Group;
  /** call once per frame so icons keep constant screen size */
  update(camera: THREE.PerspectiveCamera, viewportHeightPx: number): void;
}

function makeBubbleLayer(meshes: THREE.Mesh[]): BubbleLayer {
  const group = new THREE.Group();
  for (const m of meshes) group.add(m);
  return {
    group,
    update(camera, viewportHeightPx) {
      const perZ = (2 * Math.tan((camera.fov * Math.PI) / 360)) / viewportHeightPx;
      for (const m of meshes) {
        (m.material as THREE.ShaderMaterial).uniforms.uScalePerZ!.value = perZ;
      }
    },
  };
}

/**
 * Icon layer: one billboard per resource tile (Civ5's resource icons).
 * Purely informational — the on-terrain look of the resource itself comes
 * from buildResourceTerrainArt.
 */
export async function buildResourceBubbles(
  tiles: OverlayTile[],
  groundZ: GroundZ,
): Promise<{ layer: BubbleLayer; unmapped: OverlayTile[] }> {
  const unmapped: OverlayTile[] = [];
  const byFile = new Map<string, { x: number; y: number; z: number }[]>();
  for (const t of tiles) {
    if (!t.resource) continue;
    const file = CIV5.resourceBubbles[t.resource];
    if (!file) {
      unmapped.push(t);
      continue;
    }
    const arr = byFile.get(file) ?? [];
    const z = Math.max(groundZ(t, BUBBLE_OFFSET.x, BUBBLE_OFFSET.y), 0.01);
    arr.push({
      x: t.world.x + BUBBLE_OFFSET.x,
      y: t.world.y + BUBBLE_OFFSET.y,
      z: z + 0.1,
    });
    byFile.set(file, arr);
  }
  const meshes: THREE.Mesh[] = [];
  for (const [file, anchors] of byFile) {
    const tex = await loadTex(CIV5.svRoot + file, false);
    if (!tex) continue;
    meshes.push(buildBillboardMesh(anchors, tex, BUBBLE_PX));
  }
  return { layer: makeBubbleLayer(meshes), unmapped };
}

// ——————————————————— improvement ground decals ———————————————————

/**
 * Crop-field texture masked into an irregular soft-edged blob, so farms read
 * as painted farmland patches (Civ5's crops decals), not square stamps.
 */
function cropFieldTexture(cropsImg: HTMLImageElement, variant: number): THREE.Texture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(cropsImg, 0, 0, size, size);
  const id = ctx.getImageData(0, 0, size, size);
  const d = id.data;
  // radial falloff + angular noise = irregular field boundary
  const cx = size / 2;
  const cy = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / cx;
      const dy = (y - cy) / cy;
      const ang = Math.atan2(dy, dx);
      const wob =
        0.14 * Math.sin(ang * 3 + variant * 2.1) +
        0.09 * Math.sin(ang * 7 + variant * 4.7) +
        0.05 * Math.sin(ang * 13 + variant * 9.3);
      const r = Math.hypot(dx, dy) / (0.86 + wob);
      const a = r < 0.78 ? 1 : Math.max(0, 1 - (r - 0.78) / 0.22);
      d[(y * size + x) * 4 + 3] = Math.round(a * 235);
    }
  }
  ctx.putImageData(id, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * Ground decals: farms get masked crop-field blobs (8 texture variants ×
 * per-tile rotation), other mapped improvements get their Firaxis decal pad.
 */
export async function buildImprovementDecals(
  tiles: OverlayTile[],
  groundZ: GroundZ,
): Promise<THREE.Group> {
  const group = new THREE.Group();

  const cropSpots: DecalSpot[][] = [[], [], [], [], [], [], [], []];
  const padByFile = new Map<string, { spots: DecalSpot[]; scale: number }>();

  for (const t of tiles) {
    if (!t.improvement) continue;
    const spec = (CIV5.improvementDecals as Record<string, { crops?: boolean; file?: string; scale?: number } | undefined>)[
      t.improvement
    ];
    if (!spec) continue;
    if (spec.crops) {
      const v = hashKey(t.key) % 8;
      cropSpots[v]!.push({
        tile: t,
        ox: 0,
        oy: 0,
        r: 0.78,
        rot: hash01(t.key, 11) * Math.PI * 2,
      });
    } else if (spec.file) {
      const e = padByFile.get(spec.file) ?? { spots: [], scale: spec.scale ?? 0.85 };
      e.spots.push({ tile: t, ox: 0, oy: 0, r: (spec.scale ?? 0.85) * 0.5, rot: 0 });
      padByFile.set(spec.file, e);
    }
  }

  // crops: one variant texture per crops_europe file
  if (cropSpots.some((s) => s.length > 0)) {
    for (let v = 0; v < 8; v++) {
      if (cropSpots[v]!.length === 0) continue;
      const img = await loadImage(`${CIV5.decalRoot}crops_europe_0${v + 1}_d.png`);
      if (!img) continue;
      const tex = cropFieldTexture(img, v);
      group.add(
        buildDecalMesh(cropSpots[v]!, tex, groundZ, {
          renderOrder: 3,
          lift: 0.008,
          opacity: 0.92,
        }),
      );
    }
  }

  for (const [file, { spots }] of padByFile) {
    const tex = await loadTex(CIV5.decalRoot + file);
    if (!tex) continue;
    group.add(buildDecalMesh(spots, tex, groundZ, { renderOrder: 3, lift: 0.01 }));
  }
  return group;
}

// ——————————————————— natural wonders ———————————————————

/**
 * Real wonder art instead of the gold star: pictorial billboards standing on
 * the tile for mountain-type wonders (Fuji, Gibraltar, Mesa…), draped decals
 * for flat ones (Barringer Crater, Great Barrier Reef).
 */
export async function buildNaturalWonderArt(
  tiles: OverlayTile[],
  groundZ: GroundZ,
): Promise<THREE.Group> {
  const group = new THREE.Group();
  const wonders = tiles.filter((t) => t.naturalWonder);
  for (const t of wonders) {
    const spec =
      CIV5.naturalWonders[t.naturalWonder!] ?? CIV5.naturalWonders["*"]!;
    const tex = await loadTex(CIV5.svRoot + spec.file);
    if (!tex) continue;
    if (spec.mode === "decal") {
      group.add(
        buildDecalMesh(
          [{ tile: t, ox: 0, oy: 0, r: spec.scale * 0.5, rot: 0 }],
          tex,
          groundZ,
          { renderOrder: 3, lift: 0.012 },
        ),
      );
    } else {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        alphaTest: 0.05,
      });
      const sprite = new THREE.Sprite(mat);
      // feet on the ground: art is bottom-weighted, anchor low. Sample a few
      // spots so a sloping dome never buries the artwork's base.
      sprite.center.set(0.5, 0.1);
      const z = Math.max(
        groundZ(t, 0, 0),
        groundZ(t, 0.35, 0),
        groundZ(t, -0.35, 0),
        groundZ(t, 0, -0.35),
      );
      sprite.position.set(t.world.x, t.world.y, z + 0.04);
      sprite.scale.set(spec.scale, spec.scale, 1);
      sprite.renderOrder = 5;
      group.add(sprite);
    }
  }
  return group;
}
