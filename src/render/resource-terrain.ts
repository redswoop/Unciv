/**
 * On-terrain resource + improvement art — the actual STUFF on the tile
 * (cows grazing, wheat growing, boulders, fish schools), distinct from the
 * icon-bubble layer (civ5-overlays) which is informational UI.
 *
 * Civ5 proper uses GR2 models here; we approximate with:
 *  - merged world-anchored billboard sprites (animals, plants) with subtle
 *    shader animation (grazing drift, bobbing boats)
 *  - merged ground decals (mineral outcrops, crop patches, pasture fences)
 *  - animated water decals (circling fish schools, surfacing whales)
 *
 * Category → resource mapping lives HERE (species look), while which file/
 * style a resource uses stays overridable per generator. All sprites are
 * canvas-drawn at build time — zero extra downloads, works offline.
 */

import * as THREE from "three";
import type { Vec2 } from "../hex/hex-math";
import { BUBBLE_LOCAL } from "./civ5-tiles";
import type { GroundZ, OverlayTile } from "./civ5-overlays";

// ——————————————————— category tables (pure, testable) ———————————————————

export type AnimalSpecies = "cow" | "sheep" | "horse" | "deer" | "bison" | "elephant";

export const ANIMAL_RESOURCES: Record<string, AnimalSpecies> = {
  Cattle: "cow",
  Sheep: "sheep",
  Horses: "horse",
  Deer: "deer",
  Bison: "bison",
  Ivory: "elephant",
};

export type MineralKind =
  | "stone"
  | "marble"
  | "iron"
  | "coal"
  | "copper"
  | "salt"
  | "gold"
  | "silver"
  | "gems"
  | "aluminum"
  | "uranium";

export const MINERAL_RESOURCES: Record<string, MineralKind> = {
  Stone: "stone",
  Marble: "marble",
  Iron: "iron",
  Coal: "coal",
  Copper: "copper",
  Salt: "salt",
  "Gold Ore": "gold",
  Silver: "silver",
  Gems: "gems",
  Aluminum: "aluminum",
  Uranium: "uranium",
};

export type PlantKind =
  | "banana"
  | "citrus"
  | "wine"
  | "cotton"
  | "silk"
  | "spices"
  | "sugar"
  | "incense"
  | "truffles"
  | "dyes"
  | "cocoa"
  | "wheat";

export const PLANT_RESOURCES: Record<string, PlantKind> = {
  Bananas: "banana",
  Citrus: "citrus",
  Wine: "wine",
  Cotton: "cotton",
  Silk: "silk",
  Spices: "spices",
  Sugar: "sugar",
  Incense: "incense",
  Truffles: "truffles",
  Dyes: "dyes",
  Cocoa: "cocoa",
  Wheat: "wheat",
};

export type SeaKind = "fish" | "whale" | "pearls" | "crab";

export const SEA_RESOURCES: Record<string, SeaKind> = {
  Fish: "fish",
  Whales: "whale",
  Pearls: "pearls",
  Crab: "crab",
};

/** Every resource with on-terrain art (icons cover the rest, e.g. Oil at sea). */
export function terrainArtKind(
  resource: string,
): { kind: "animal" | "mineral" | "plant" | "sea" | "oil" } | null {
  if (ANIMAL_RESOURCES[resource]) return { kind: "animal" };
  if (MINERAL_RESOURCES[resource]) return { kind: "mineral" };
  if (PLANT_RESOURCES[resource]) return { kind: "plant" };
  if (SEA_RESOURCES[resource]) return { kind: "sea" };
  if (resource === "Oil") return { kind: "oil" };
  return null;
}

// ——————————————————— deterministic hashing ———————————————————

function hashKey(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function hash01(key: string, salt: number): number {
  return (hashKey(`${key}|${salt}`) >>> 0) / 0x100000000;
}

/**
 * Deterministic in-tile anchor spots: jittered ring around the center,
 * kept away from the icon-bubble corner and the hex rim.
 */
export function spotsInTile(
  key: string,
  count: number,
  radius = 0.42,
): Vec2[] {
  const out: Vec2[] = [];
  const baseAng = hash01(key, 31) * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const ang = baseAng + (i / count) * Math.PI * 2 + (hash01(key, 37 + i) - 0.5) * 1.2;
    const r = radius * (0.35 + 0.65 * hash01(key, 53 + i));
    let x = Math.cos(ang) * r;
    let y = Math.sin(ang) * r;
    // shove out of the bubble corner (icons live up-left)
    const dbx = x - BUBBLE_LOCAL.x;
    const dby = y - BUBBLE_LOCAL.y;
    if (dbx * dbx + dby * dby < 0.36 * 0.36) {
      x += 0.3;
      y -= 0.3;
    }
    out.push({ x, y });
  }
  return out;
}

// ——————————————————— canvas art helpers ———————————————————

type Ctx = CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function canvasTexture(c: HTMLCanvasElement, srgbAware = true): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  if (srgbAware) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

/** soft elliptical contact shadow under a sprite subject */
function contactShadow(ctx: Ctx, cx: number, cy: number, rx: number, ry: number): void {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
  g.addColorStop(0, "rgba(10,14,6,0.42)");
  g.addColorStop(1, "rgba(10,14,6,0)");
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  ctx.translate(-cx, -cy);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ——————————————————— animal sprites ———————————————————

interface SpeciesLook {
  body: string;
  belly: string;
  dark: string;
  /** overall sprite width in world units */
  scale: number;
  count: number;
}

const SPECIES: Record<AnimalSpecies, SpeciesLook> = {
  cow: { body: "#6b4a33", belly: "#e8ded0", dark: "#3c2a1c", scale: 0.30, count: 3 },
  sheep: { body: "#ddd6c4", belly: "#efe9dc", dark: "#4a4238", scale: 0.24, count: 4 },
  horse: { body: "#7a4f2e", belly: "#8f6440", dark: "#42280f", scale: 0.32, count: 3 },
  deer: { body: "#96703f", belly: "#c4a878", dark: "#5c3f22", scale: 0.28, count: 3 },
  bison: { body: "#4f3620", belly: "#6b4c30", dark: "#2c1c0e", scale: 0.32, count: 3 },
  elephant: { body: "#8e8a84", belly: "#a5a19a", dark: "#5c5954", scale: 0.42, count: 2 },
};

/**
 * Side-view animal card (faces left). Tiny on screen (~15-40px) — clean
 * silhouette + simple two-tone shading carry the read. A shared quadruped
 * rig, with per-species proportions and dressing.
 */
export function drawAnimal(ctx: Ctx, species: AnimalSpecies, w: number, h: number, grazing: boolean): void {
  const look = SPECIES[species];
  ctx.clearRect(0, 0, w, h);
  const groundY = h * 0.84;
  const cx = w * 0.52;
  contactShadow(ctx, cx - w * 0.02, groundY, w * 0.3, h * 0.06);

  // per-species rig
  type Rig = {
    bodyRx: number; // half body length
    bodyRy: number;
    legH: number;
    legW: number;
    neckW: number;
    headR: number;
    slim?: boolean;
  };
  const rigs: Record<AnimalSpecies, Rig> = {
    cow: { bodyRx: 0.24, bodyRy: 0.105, legH: 0.14, legW: 0.028, neckW: 0.075, headR: 0.062 },
    sheep: { bodyRx: 0.2, bodyRy: 0.105, legH: 0.1, legW: 0.02, neckW: 0.05, headR: 0.05 },
    horse: { bodyRx: 0.23, bodyRy: 0.09, legH: 0.19, legW: 0.022, neckW: 0.06, headR: 0.052, slim: true },
    deer: { bodyRx: 0.19, bodyRy: 0.075, legH: 0.17, legW: 0.016, neckW: 0.045, headR: 0.045, slim: true },
    bison: { bodyRx: 0.24, bodyRy: 0.115, legH: 0.12, legW: 0.028, neckW: 0.1, headR: 0.06 },
    elephant: { bodyRx: 0.26, bodyRy: 0.14, legH: 0.15, legW: 0.045, neckW: 0.14, headR: 0.085 },
  };
  const rig = rigs[species];
  const bodyRx = rig.bodyRx * w;
  const bodyRy = rig.bodyRy * h;
  const legH = rig.legH * h;
  const bodyCy = groundY - legH - bodyRy * 0.75;

  const legColor = species === "sheep" ? look.dark : shade(look.body, -28);

  // hind + front legs (two pairs, far pair darker for depth)
  const legPairs: [number, string][] = [
    [-0.62, shade(legColor, -18)],
    [0.5, shade(legColor, -18)],
    [-0.72, legColor],
    [0.62, legColor],
  ];
  for (const [fx, color] of legPairs) {
    ctx.fillStyle = color;
    const lx = cx + fx * bodyRx;
    ctx.fillRect(lx - rig.legW * w * 0.5, bodyCy, rig.legW * w, groundY - bodyCy);
  }

  // body
  ctx.fillStyle = look.body;
  ctx.beginPath();
  ctx.ellipse(cx, bodyCy, bodyRx, bodyRy, 0, 0, Math.PI * 2);
  ctx.fill();
  // top light + belly shade (clipped crescents)
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, bodyCy, bodyRx, bodyRy, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = look.belly;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.ellipse(cx, bodyCy - bodyRy * 0.55, bodyRx * 0.92, bodyRy * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = shade(look.body, -40);
  ctx.beginPath();
  ctx.ellipse(cx, bodyCy + bodyRy * 0.75, bodyRx * 0.95, bodyRy * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // species body dressing
  if (species === "sheep") {
    // wool bumps along the top silhouette
    ctx.fillStyle = look.body;
    for (let i = 0; i < 6; i++) {
      const a = Math.PI * (0.15 + (i / 5) * 0.7);
      ctx.beginPath();
      ctx.arc(cx - Math.cos(a) * bodyRx * 0.85, bodyCy - Math.sin(a) * bodyRy * 0.9, bodyRy * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (species === "bison") {
    // shaggy dark forequarter hump
    ctx.fillStyle = shade(look.body, -22);
    ctx.beginPath();
    ctx.ellipse(cx - bodyRx * 0.45, bodyCy - bodyRy * 0.55, bodyRx * 0.5, bodyRy * 1.05, -0.15, 0, Math.PI * 2);
    ctx.fill();
  }
  if (species === "cow") {
    // hide patches
    ctx.fillStyle = look.belly;
    ctx.beginPath();
    ctx.ellipse(cx + bodyRx * 0.35, bodyCy + bodyRy * 0.1, bodyRx * 0.28, bodyRy * 0.55, 0.3, 0, Math.PI * 2);
    ctx.ellipse(cx - bodyRx * 0.25, bodyCy - bodyRy * 0.35, bodyRx * 0.2, bodyRy * 0.4, -0.2, 0, Math.PI * 2);
    ctx.fill();
  }
  if (species === "deer") {
    // white rump patch
    ctx.fillStyle = "#e8ddc4";
    ctx.beginPath();
    ctx.ellipse(cx + bodyRx * 0.85, bodyCy, bodyRx * 0.18, bodyRy * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // neck + head
  const shoulderX = cx - bodyRx * 0.72;
  const shoulderY = bodyCy - bodyRy * 0.35;
  let headX: number;
  let headY: number;
  if (species === "elephant") {
    headX = cx - bodyRx * 1.02;
    headY = bodyCy - bodyRy * 0.15;
  } else if (grazing) {
    headX = cx - bodyRx * 1.18;
    headY = groundY - rig.headR * w * 0.95;
  } else {
    headX = cx - bodyRx * 1.12;
    headY = bodyCy - bodyRy * (rig.slim ? 1.9 : 1.5);
  }
  ctx.strokeStyle = look.body;
  ctx.lineWidth = rig.neckW * w;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(shoulderX, shoulderY);
  ctx.lineTo(headX + (shoulderX - headX) * 0.05, headY + (shoulderY - headY) * 0.05);
  ctx.stroke();
  if (species === "horse" && !grazing) {
    // mane along the neck's back edge
    ctx.strokeStyle = look.dark;
    ctx.lineWidth = w * 0.02;
    ctx.beginPath();
    ctx.moveTo(shoulderX + w * 0.028, shoulderY - h * 0.005);
    ctx.lineTo(headX + w * 0.035, headY + h * 0.02);
    ctx.stroke();
  }
  // head: small ellipse angled with the muzzle
  const headAng = grazing ? 0.95 : species === "elephant" ? 0.15 : 0.18;
  ctx.fillStyle = species === "sheep" ? look.dark : look.body;
  ctx.beginPath();
  ctx.ellipse(headX, headY, rig.headR * w * 1.25, rig.headR * w * 0.85, headAng, 0, Math.PI * 2);
  ctx.fill();
  // ear
  if (species !== "elephant") {
    ctx.fillStyle = species === "sheep" ? look.dark : shade(look.body, -18);
    ctx.beginPath();
    ctx.ellipse(
      headX + rig.headR * w * 0.7,
      headY - rig.headR * w * 0.7,
      rig.headR * w * 0.45,
      rig.headR * w * 0.28,
      -0.6,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  // tails
  ctx.strokeStyle = species === "horse" ? look.dark : shade(look.body, -20);
  ctx.lineCap = "round";
  if (species === "horse") {
    ctx.lineWidth = w * 0.035;
    ctx.beginPath();
    ctx.moveTo(cx + bodyRx * 0.95, bodyCy - bodyRy * 0.2);
    ctx.quadraticCurveTo(cx + bodyRx * 1.25, bodyCy + bodyRy * 1.6, cx + bodyRx * 1.1, groundY - h * 0.04);
    ctx.stroke();
  } else if (species !== "sheep") {
    ctx.lineWidth = w * 0.012;
    ctx.beginPath();
    ctx.moveTo(cx + bodyRx * 0.98, bodyCy - bodyRy * 0.3);
    ctx.quadraticCurveTo(cx + bodyRx * 1.12, bodyCy + bodyRy * 0.8, cx + bodyRx * 1.05, bodyCy + bodyRy * 1.6);
    ctx.stroke();
  }

  // species head dressing
  if (species === "cow" || species === "bison") {
    ctx.strokeStyle = "#e6ddc6";
    ctx.lineWidth = w * 0.016;
    ctx.beginPath();
    ctx.moveTo(headX - w * 0.005, headY - rig.headR * w * 0.9);
    ctx.quadraticCurveTo(headX + w * 0.02, headY - rig.headR * w * 1.6, headX + w * 0.045, headY - rig.headR * w * 1.0);
    ctx.stroke();
  }
  if (species === "deer" && !grazing) {
    ctx.strokeStyle = "#d9c49a";
    ctx.lineWidth = w * 0.014;
    for (const s of [-0.4, 1] as const) {
      ctx.beginPath();
      ctx.moveTo(headX + s * w * 0.012, headY - rig.headR * w * 0.8);
      ctx.quadraticCurveTo(
        headX + s * w * 0.03,
        headY - rig.headR * w * 2.2,
        headX + s * w * 0.07,
        headY - rig.headR * w * 2.6,
      );
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(headX + s * w * 0.02, headY - rig.headR * w * 1.6);
      ctx.lineTo(headX + s * w * 0.06, headY - rig.headR * w * 1.7);
      ctx.stroke();
    }
  }
  if (species === "elephant") {
    // trunk down to ground, big ear, tusk
    ctx.strokeStyle = look.body;
    ctx.lineWidth = w * 0.04;
    ctx.beginPath();
    ctx.moveTo(headX - rig.headR * w * 0.5, headY + rig.headR * w * 0.3);
    ctx.quadraticCurveTo(
      headX - rig.headR * w * 1.4,
      headY + (groundY - headY) * 0.6,
      headX - rig.headR * w * (grazing ? 1.7 : 1.0),
      groundY - h * 0.02,
    );
    ctx.stroke();
    ctx.strokeStyle = "#ece6d4";
    ctx.lineWidth = w * 0.018;
    ctx.beginPath();
    ctx.moveTo(headX - rig.headR * w * 0.6, headY + rig.headR * w * 0.55);
    ctx.quadraticCurveTo(
      headX - rig.headR * w * 1.3,
      headY + rig.headR * w * 1.15,
      headX - rig.headR * w * 1.6,
      headY + rig.headR * w * 0.9,
    );
    ctx.stroke();
    ctx.fillStyle = shade(look.body, -16);
    ctx.beginPath();
    ctx.ellipse(
      headX + rig.headR * w * 0.75,
      headY - rig.headR * w * 0.1,
      rig.headR * w * 0.75,
      rig.headR * w * 0.95,
      -0.2,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
}

/** Lighten/darken a #rrggbb color by delta per channel. */
function shade(hex: string, delta: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, v + delta));
  const r = c((n >> 16) & 255);
  const g = c((n >> 8) & 255);
  const b = c(n & 255);
  return `rgb(${r},${g},${b})`;
}

// ——————————————————— merged world billboards ———————————————————

export interface BillboardAnchor {
  x: number;
  y: number;
  z: number;
  scale: number;
  /** animation phase 0..2π */
  phase: number;
  /** mirror horizontally */
  flip: boolean;
}

export interface AnimatedLayer {
  object: THREE.Object3D;
  /** materials owning a uTime uniform (driven once per frame) */
  timeUniforms: { value: number }[];
}

/**
 * Merged camera-facing quads at fixed WORLD size (like tree sprites), with a
 * per-instance phase for subtle idle animation (grazing drift / bobbing).
 */
export function buildWorldBillboards(
  anchors: BillboardAnchor[],
  tex: THREE.Texture,
  opts: { anim?: "graze" | "bob" | "none"; centerY?: number; renderOrder?: number } = {},
): AnimatedLayer {
  // raw passthrough: this ShaderMaterial skips three's tonemapping/encoding
  // chunks, so an sRGB-decoded texture would be double-darkened on output
  tex.colorSpace = THREE.NoColorSpace;
  const n = anchors.length;
  const centers = new Float32Array(n * 4 * 3);
  const corners = new Float32Array(n * 4 * 2);
  const uvs = new Float32Array(n * 4 * 2);
  const params = new Float32Array(n * 4 * 2); // scale, phase
  const index: number[] = [];
  const cy = opts.centerY ?? 0.5; // fraction of the quad BELOW the anchor (0.08 = feet on anchor)
  for (let i = 0; i < n; i++) {
    const a = anchors[i]!;
    const sx = a.flip ? -1 : 1;
    const quad = [
      [-0.5 * sx, -cy, 0, 0],
      [0.5 * sx, -cy, 1, 0],
      [0.5 * sx, 1 - cy, 1, 1],
      [-0.5 * sx, 1 - cy, 0, 1],
    ] as const;
    for (let c = 0; c < 4; c++) {
      const o = i * 4 + c;
      centers[o * 3] = a.x;
      centers[o * 3 + 1] = a.y;
      centers[o * 3 + 2] = a.z;
      corners[o * 2] = quad[c]![0];
      corners[o * 2 + 1] = quad[c]![1];
      uvs[o * 2] = quad[c]![2];
      uvs[o * 2 + 1] = quad[c]![3];
      params[o * 2] = a.scale;
      params[o * 2 + 1] = a.phase;
    }
    const b = i * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(centers, 3));
  geo.setAttribute("aCorner", new THREE.BufferAttribute(corners, 2));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute("aParam", new THREE.BufferAttribute(params, 2));
  geo.setIndex(index);

  const uTime = { value: 0 };
  const anim = opts.anim ?? "none";
  const animGlsl =
    anim === "graze"
      ? `
        // slow grazing wander: individuals drift a little, out of phase
        mv.x += 0.018 * sin(uTime * 0.35 + phase);
        mv.y += 0.012 * sin(uTime * 0.22 + phase * 1.7);`
      : anim === "bob"
        ? `
        // gentle bobbing (boats / floats)
        mv.y += 0.010 * sin(uTime * 1.1 + phase);`
        : "";

  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, uTime },
    vertexShader: `
      attribute vec2 aCorner;
      attribute vec2 aParam;
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        float scale = aParam.x;
        float phase = aParam.y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        mv.xy += aCorner * scale;
        ${animGlsl}
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(map, vUv);
        if (c.a < 0.25) discard;
        gl_FragColor = c;
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = opts.renderOrder ?? 2.5;
  return { object: mesh, timeUniforms: [uTime] };
}

// ——————————————————— mineral / ground decal art ———————————————————

interface MineralLook {
  base: string;
  dark: string;
  light: string;
  accent?: string;
  glint?: string;
  crystals?: boolean;
  blocks?: boolean;
}

const MINERALS: Record<MineralKind, MineralLook> = {
  stone: { base: "#8d8a80", dark: "#5c5952", light: "#b3b0a6" },
  marble: { base: "#cfccc2", dark: "#8f8d86", light: "#f0eee6", blocks: true },
  iron: { base: "#6e5548", dark: "#43332b", light: "#94766a", accent: "#a3502e" },
  coal: { base: "#3a3a3c", dark: "#1c1c1e", light: "#58585c" },
  copper: { base: "#7a6a52", dark: "#4c4234", light: "#a08c70", accent: "#3e8f7a" },
  salt: { base: "#d8d4c8", dark: "#a8a498", light: "#f4f2ea", accent: "#e8c8c0" },
  gold: { base: "#7d6a4a", dark: "#4c402c", light: "#a58d64", glint: "#ffd75e" },
  silver: { base: "#7e7f84", dark: "#4e4f54", light: "#a8aab2", glint: "#e8f2ff" },
  gems: { base: "#6f6660", dark: "#443e3a", light: "#948a82", crystals: true },
  aluminum: { base: "#8f9297", dark: "#5e6165", light: "#c0c4ca" },
  uranium: { base: "#5e6152", dark: "#383a30", light: "#84887a", glint: "#b8e83e" },
};

/**
 * Side-view mineral outcrop sprite (billboard): a boulder cluster with the
 * ore GROWING OUT of it — glinting veins, embedded lumps, crystal shards —
 * matching how Civ5's resource models read (shiny rocks on boulders).
 */
export function drawMineralSprite(ctx: Ctx, kind: MineralKind, w: number, h: number, seed: number): void {
  const look = MINERALS[kind];
  ctx.clearRect(0, 0, w, h);
  const groundY = h * 0.85;
  const cx = w * 0.5;
  const rnd = (i: number) => hash01(`ms${kind}${seed}`, i);
  contactShadow(ctx, cx, groundY, w * 0.34, h * 0.07);

  /** upright irregular boulder with sun-lit top-left facet */
  const boulder = (bx: number, baseY: number, bw: number, bh: number, salt: number) => {
    const pts: [number, number][] = [];
    const n = 7;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const ang = Math.PI * (1 - t); // left → right over the top
      const rr = 1 + (rnd(salt + i) - 0.5) * 0.35;
      pts.push([bx + Math.cos(ang) * bw * rr, baseY - Math.sin(ang) * bh * rr]);
    }
    ctx.fillStyle = look.dark;
    ctx.beginPath();
    ctx.moveTo(bx - bw, baseY);
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(bx + bw, baseY);
    ctx.closePath();
    ctx.fill();
    // mid tone (inset, biased up-left)
    ctx.fillStyle = look.base;
    ctx.beginPath();
    ctx.moveTo(bx - bw * 0.85, baseY);
    for (const [x, y] of pts) ctx.lineTo(bx + (x - bx) * 0.82 - bw * 0.06, baseY + (y - baseY) * 0.88 - bh * 0.05);
    ctx.lineTo(bx + bw * 0.62, baseY);
    ctx.closePath();
    ctx.fill();
    // lit top-left facet
    ctx.fillStyle = look.light;
    ctx.beginPath();
    ctx.moveTo(bx - bw * 0.62, baseY - bh * 0.28);
    ctx.lineTo(bx - bw * 0.25, baseY - bh * 1.02);
    ctx.lineTo(bx + bw * 0.18, baseY - bh * 0.9);
    ctx.lineTo(bx - bw * 0.12, baseY - bh * 0.38);
    ctx.closePath();
    ctx.fill();
  };

  // cluster: one large + one small boulder
  boulder(cx - w * 0.06, groundY, w * 0.26, h * 0.34, 0);
  boulder(cx + w * 0.24, groundY, w * 0.14, h * 0.17, 20);

  const sparkle = (x: number, y: number, r: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.2, r * 0.3);
    ctx.beginPath();
    ctx.moveTo(x - r, y);
    ctx.lineTo(x + r, y);
    ctx.moveTo(x, y - r);
    ctx.lineTo(x, y + r);
    ctx.stroke();
  };

  const veins = (color: string, glow = false) => {
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    for (let i = 0; i < 4; i++) {
      const sx = cx - w * 0.22 + rnd(i + 40) * w * 0.34;
      const sy = groundY - h * 0.1 - rnd(i + 50) * h * 0.26;
      ctx.lineWidth = w * (0.012 + rnd(i + 60) * 0.012);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(
        sx + (rnd(i + 70) - 0.5) * w * 0.12,
        sy - h * 0.08,
        sx + (rnd(i + 80) - 0.5) * w * 0.2,
        sy - h * (0.12 + rnd(i + 90) * 0.1),
      );
      ctx.stroke();
    }
    if (glow) {
      for (let i = 0; i < 5; i++) {
        sparkle(
          cx - w * 0.2 + rnd(i + 100) * w * 0.42,
          groundY - h * 0.12 - rnd(i + 110) * h * 0.3,
          w * (0.02 + rnd(i + 120) * 0.018),
          color,
        );
      }
    }
  };

  switch (kind) {
    case "gold":
      veins("#ffd75e", true);
      break;
    case "silver":
      veins("#e8f2ff", true);
      break;
    case "copper":
      veins("#4ecfa8", false);
      veins("#3e8f7a", false);
      break;
    case "iron": {
      // embedded metallic lumps with specular dashes
      for (let i = 0; i < 5; i++) {
        const x = cx - w * 0.18 + rnd(i + 40) * w * 0.32;
        const y = groundY - h * 0.12 - rnd(i + 50) * h * 0.24;
        const r = w * (0.028 + rnd(i + 60) * 0.02);
        ctx.fillStyle = "#4a3f47";
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.85, rnd(i + 70) * Math.PI, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#c9c2d4";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x - r * 0.5, y - r * 0.4);
        ctx.lineTo(x + r * 0.2, y - r * 0.55);
        ctx.stroke();
      }
      break;
    }
    case "coal": {
      // glossy black seam bands
      ctx.fillStyle = "#141416";
      for (let i = 0; i < 3; i++) {
        const y = groundY - h * (0.1 + i * 0.09);
        ctx.beginPath();
        ctx.ellipse(cx - w * 0.04, y, w * 0.2 - i * w * 0.03, h * 0.032, -0.12, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i = 0; i < 4; i++) {
        sparkle(cx - w * 0.14 + rnd(i + 40) * w * 0.26, groundY - h * 0.1 - rnd(i + 50) * h * 0.22, w * 0.012, "#9aa2b8");
      }
      break;
    }
    case "salt": {
      // white crystalline crust cap
      ctx.fillStyle = "#f4f2ea";
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.28, groundY - h * 0.3);
      ctx.lineTo(cx - w * 0.1, groundY - h * 0.44);
      ctx.lineTo(cx + w * 0.12, groundY - h * 0.4);
      ctx.lineTo(cx + w * 0.16, groundY - h * 0.26);
      ctx.closePath();
      ctx.fill();
      for (let i = 0; i < 4; i++) {
        sparkle(cx - w * 0.18 + rnd(i + 40) * w * 0.3, groundY - h * 0.26 - rnd(i + 50) * h * 0.12, w * 0.014, "#ffffff");
      }
      break;
    }
    case "gems": {
      // crystal shards growing out of the boulder top
      const tones: [string, string][] = [
        ["#d543b8", "#f4a3e2"],
        ["#7a5ce8", "#b8a3f4"],
        ["#3fbf74", "#9de8bd"],
      ];
      for (let i = 0; i < 3; i++) {
        const [base, lite] = tones[i]!;
        const x = cx - w * 0.14 + i * w * 0.13 + (rnd(i + 40) - 0.5) * w * 0.05;
        const baseY = groundY - h * (0.3 + rnd(i + 50) * 0.1);
        const ht = h * (0.16 + rnd(i + 60) * 0.1);
        const wd = w * 0.045;
        const lean = (rnd(i + 70) - 0.5) * 0.8;
        ctx.save();
        ctx.translate(x, baseY);
        ctx.rotate(lean);
        ctx.fillStyle = base;
        ctx.beginPath();
        ctx.moveTo(0, -ht);
        ctx.lineTo(wd, -ht * 0.25);
        ctx.lineTo(wd * 0.7, 0);
        ctx.lineTo(-wd * 0.7, 0);
        ctx.lineTo(-wd, -ht * 0.25);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = lite;
        ctx.beginPath();
        ctx.moveTo(0, -ht);
        ctx.lineTo(-wd, -ht * 0.25);
        ctx.lineTo(-wd * 0.3, -ht * 0.2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        sparkle(x + wd, baseY - ht, w * 0.02, "#ffffff");
      }
      break;
    }
    case "uranium": {
      veins("#b8e83e", true);
      break;
    }
    case "marble": {
      // gray veining over pale rock
      ctx.strokeStyle = "#8f8d86";
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 4; i++) {
        const y = groundY - h * (0.08 + rnd(i + 40) * 0.3);
        ctx.beginPath();
        ctx.moveTo(cx - w * 0.24, y);
        ctx.bezierCurveTo(cx - w * 0.1, y - h * 0.03, cx + w * 0.05, y + h * 0.03, cx + w * 0.2, y - h * 0.02);
        ctx.stroke();
      }
      break;
    }
    default:
      break; // stone / aluminum: bare boulders read fine
  }
}

/** Top-down rock outcrop / deposit patch with per-mineral accents. */
export function drawMineralDecal(ctx: Ctx, kind: MineralKind, size: number, seed: number): void {
  const look = MINERALS[kind];
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  contactShadow(ctx, cx, cy + size * 0.04, size * 0.34, size * 0.26);

  const rnd = (i: number) => hash01(`m${kind}${seed}`, i);

  /** irregular faceted rock: polygon base, light top facet, mid facet */
  const rock = (bx: number, by: number, r: number, rot: number, salt: number) => {
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(rot);
    const n = 6;
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (0.72 + 0.4 * rnd(salt + i));
      pts.push([Math.cos(a) * rr, Math.sin(a) * rr * 0.8]);
    }
    // base silhouette (darkest)
    ctx.fillStyle = look.dark;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.fill();
    // mid facet: same poly shrunk toward up-left
    ctx.fillStyle = look.base;
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const fx = x * 0.82 - r * 0.1;
      const fy = y * 0.78 - r * 0.12;
      if (i === 0) ctx.moveTo(fx, fy);
      else ctx.lineTo(fx, fy);
    });
    ctx.closePath();
    ctx.fill();
    // top facet triangle catching the sun
    ctx.fillStyle = look.light;
    ctx.beginPath();
    ctx.moveTo(pts[4]![0] * 0.6 - r * 0.12, pts[4]![1] * 0.6 - r * 0.16);
    ctx.lineTo(pts[5]![0] * 0.62 - r * 0.1, pts[5]![1] * 0.62 - r * 0.14);
    ctx.lineTo(pts[0]![0] * 0.5 - r * 0.14, pts[0]![1] * 0.5 - r * 0.12);
    ctx.lineTo(-r * 0.15, -r * 0.05);
    ctx.closePath();
    ctx.fill();
    if (look.accent) {
      ctx.fillStyle = look.accent;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.ellipse(r * 0.12, r * 0.12, r * 0.3, r * 0.16, 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  };

  /** cut block (marble): rect slab with lit top */
  const block = (bx: number, by: number, r: number, rot: number) => {
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(rot);
    ctx.fillStyle = look.dark;
    ctx.fillRect(-r, -r * 0.55, r * 2, r * 1.2);
    ctx.fillStyle = look.base;
    ctx.fillRect(-r, -r * 0.55, r * 2, r * 0.85);
    ctx.fillStyle = look.light;
    ctx.fillRect(-r, -r * 0.55, r * 1.5, r * 0.4);
    ctx.restore();
  };

  // tight triangular cluster of 3 + one outlier pebble
  const spots: [number, number, number][] = [
    [cx - size * 0.1, cy - size * 0.05, size * 0.11],
    [cx + size * 0.1, cy - size * 0.02, size * 0.095],
    [cx - size * 0.005, cy + size * 0.1, size * 0.085],
    [cx + size * 0.19, cy + size * 0.13, size * 0.045],
  ];
  spots.forEach(([bx, by, r], i) => {
    if (look.blocks) block(bx, by, r, (rnd(i + 40) - 0.5) * 0.6);
    else rock(bx, by, r, rnd(i + 40) * Math.PI, i * 11);
  });

  if (look.crystals) {
    // gem crystals: angular shards in jewel tones
    const tones = ["#e055c8", "#7a5ce8", "#4ecf7a", "#e8554f"];
    for (let i = 0; i < 6; i++) {
      const bx = cx + (rnd(i + 50) - 0.5) * size * 0.5;
      const by = cy + (rnd(i + 60) - 0.5) * size * 0.42;
      const r = size * (0.035 + 0.05 * rnd(i + 70));
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(rnd(i + 80) * Math.PI);
      ctx.fillStyle = tones[i % tones.length]!;
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.6);
      ctx.lineTo(r * 0.8, -r * 0.2);
      ctx.lineTo(r * 0.5, r);
      ctx.lineTo(-r * 0.5, r);
      ctx.lineTo(-r * 0.8, -r * 0.2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.6);
      ctx.lineTo(r * 0.35, -r * 0.3);
      ctx.lineTo(-r * 0.25, -r * 0.25);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  if (look.glint) {
    for (let i = 0; i < 7; i++) {
      const bx = cx + (rnd(i + 90) - 0.5) * size * 0.55;
      const by = cy + (rnd(i + 100) - 0.5) * size * 0.45;
      const r = size * (0.012 + 0.02 * rnd(i + 110));
      ctx.fillStyle = look.glint;
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ——————————————————— plant art ———————————————————

/** Small plant/tree sprite (billboard) per kind. */
export function drawPlantSprite(ctx: Ctx, kind: PlantKind, w: number, h: number, seed: number): void {
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const groundY = h * 0.86;
  const rnd = (i: number) => hash01(`p${kind}${seed}`, i);
  contactShadow(ctx, cx, groundY, w * 0.3, h * 0.07);

  const crown = (x: number, y: number, r: number, base: string, light: string) => {
    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.arc(x - r * 0.25, y - r * 0.3, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
  };
  const dots = (x: number, y: number, r: number, color: string, n: number, salt: number) => {
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const a = rnd(salt + i) * Math.PI * 2;
      const rr = r * Math.sqrt(rnd(salt + 20 + i)) * 0.85;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * rr, y + Math.sin(a) * rr, w * 0.022, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  const trunk = (topY: number, width = 0.03) => {
    ctx.strokeStyle = "#6b4c2c";
    ctx.lineWidth = w * width;
    ctx.beginPath();
    ctx.moveTo(cx, groundY);
    ctx.lineTo(cx, topY);
    ctx.stroke();
  };

  switch (kind) {
    case "banana": {
      // arching fronds + hanging bunch
      trunk(h * 0.5, 0.035);
      ctx.strokeStyle = "#4f8f2e";
      ctx.lineCap = "round";
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i - 2.5) * 0.42;
        ctx.lineWidth = w * 0.05;
        ctx.beginPath();
        ctx.moveTo(cx, h * 0.5);
        ctx.quadraticCurveTo(
          cx + Math.cos(a) * w * 0.3,
          h * 0.5 + Math.sin(a) * h * 0.28 - h * 0.1,
          cx + Math.cos(a) * w * 0.44,
          h * 0.5 + Math.sin(a) * h * 0.3 + h * 0.12,
        );
        ctx.stroke();
      }
      ctx.fillStyle = "#e8d24e";
      ctx.beginPath();
      ctx.ellipse(cx + w * 0.08, h * 0.62, w * 0.05, h * 0.07, 0.3, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "citrus": {
      trunk(h * 0.55);
      crown(cx, h * 0.42, w * 0.26, "#3f7a2e", "#5c9a44");
      dots(cx, h * 0.42, w * 0.26, "#f0912e", 7, 300);
      break;
    }
    case "cocoa": {
      trunk(h * 0.5);
      crown(cx, h * 0.38, w * 0.24, "#4a7a34", "#639348");
      dots(cx, h * 0.46, w * 0.2, "#8a4f2a", 5, 320);
      break;
    }
    case "silk": {
      // mulberry: pale green airy crown
      trunk(h * 0.52);
      crown(cx, h * 0.4, w * 0.27, "#7ba05a", "#9dc07a");
      break;
    }
    case "sugar": {
      // cane tuft: dense arcing blades + pale seed plumes
      ctx.lineCap = "round";
      for (let i = 0; i < 11; i++) {
        const t = (i / 10 - 0.5) * 2; // -1..1 fan
        const sway = t * w * 0.26 + (rnd(i) - 0.5) * w * 0.08;
        const topY = h * (0.24 + rnd(i + 20) * 0.16);
        ctx.strokeStyle = i % 3 === 0 ? "#b8cf6e" : "#8fb84f";
        ctx.lineWidth = w * 0.02;
        ctx.beginPath();
        ctx.moveTo(cx + t * w * 0.05, groundY);
        ctx.quadraticCurveTo(cx + sway * 0.3, h * 0.55, cx + sway, topY);
        ctx.stroke();
        if (i % 3 === 0) {
          ctx.fillStyle = "#e2d9a8";
          ctx.beginPath();
          ctx.ellipse(cx + sway, topY, w * 0.018, h * 0.045, sway / (w * 0.4), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
    case "spices": {
      // low warm-green bush row with red berry clusters
      crown(cx - w * 0.16, h * 0.7, w * 0.13, "#5f6b34", "#7a8a46");
      crown(cx + w * 0.02, h * 0.65, w * 0.15, "#6b6f38", "#8a904a");
      crown(cx + w * 0.19, h * 0.71, w * 0.12, "#5c6632", "#788448");
      dots(cx - w * 0.14, h * 0.68, w * 0.1, "#c8452a", 4, 340);
      dots(cx + w * 0.03, h * 0.63, w * 0.11, "#d85a2e", 5, 360);
      dots(cx + w * 0.18, h * 0.7, w * 0.09, "#c8452a", 4, 380);
      break;
    }
    case "incense": {
      // scraggly shrub + smoke wisp
      ctx.strokeStyle = "#6b5a3c";
      ctx.lineWidth = w * 0.02;
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i - 2) * 0.5;
        ctx.beginPath();
        ctx.moveTo(cx, groundY);
        ctx.lineTo(cx + Math.cos(a) * w * 0.2, groundY + Math.sin(a) * h * 0.34);
        ctx.stroke();
      }
      crown(cx, h * 0.6, w * 0.13, "#5c6b3a", "#77875010");
      ctx.strokeStyle = "rgba(220,220,230,0.6)";
      ctx.lineWidth = w * 0.018;
      ctx.beginPath();
      ctx.moveTo(cx + w * 0.02, h * 0.55);
      ctx.bezierCurveTo(cx + w * 0.1, h * 0.42, cx - w * 0.06, h * 0.3, cx + w * 0.05, h * 0.16);
      ctx.stroke();
      break;
    }
    default: {
      // generic bush (fallback; field kinds use decals instead)
      trunk(h * 0.6);
      crown(cx, h * 0.5, w * 0.24, "#4a7a34", "#639348");
    }
  }
}

/** Ground field patch (decal) for row/field crops. */
export function drawFieldDecal(ctx: Ctx, kind: PlantKind, size: number, seed: number): void {
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  const rnd = (i: number) => hash01(`f${kind}${seed}`, i);

  // irregular blob mask via radial wobble — matches the crops decal treatment
  const blob = (radius: number): Path2D => {
    const p = new Path2D();
    const n = 22;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const wob = 1 + 0.16 * Math.sin(a * 3 + seed * 2.1) + 0.1 * Math.sin(a * 7 + seed * 4.7);
      const r = radius * wob;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) p.moveTo(x, y);
      else p.lineTo(x, y);
    }
    p.closePath();
    return p;
  };

  const paint = (ground: string, rowColor: string, rowLight: string, dotColor?: string, dotN = 0) => {
    const shape = blob(size * 0.36);
    ctx.save();
    ctx.clip(shape);
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, size, size);
    // planted rows
    const ang = rnd(1) * Math.PI;
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.translate(-cx, -cy);
    for (let y = -size; y < size * 2; y += size * 0.085) {
      ctx.fillStyle = rowColor;
      ctx.fillRect(-size, y, size * 3, size * 0.038);
      ctx.fillStyle = rowLight;
      ctx.fillRect(-size, y, size * 3, size * 0.014);
    }
    ctx.restore();
    if (dotColor && dotN > 0) {
      ctx.save();
      ctx.clip(shape);
      ctx.fillStyle = dotColor;
      for (let i = 0; i < dotN; i++) {
        const a = rnd(i + 40) * Math.PI * 2;
        const rr = size * 0.34 * Math.sqrt(rnd(i + 90));
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, size * 0.012, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    // soft edge: repaint rim with decreasing alpha
    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    const g = ctx.createRadialGradient(cx, cy, size * 0.2, cx, cy, size * 0.47);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(0.82, "rgba(0,0,0,0.95)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();
  };

  switch (kind) {
    case "wine":
      paint("#5f4a32", "#3d5c2a", "#557a3a");
      break;
    case "cotton":
      paint("#6a5a42", "#4f6b38", "#647f48", "#f2efe4", 26);
      break;
    case "dyes":
      paint("#54503c", "#4c3f66", "#6a5a8c", "#c8b830", 14);
      break;
    case "truffles":
      paint("#4a3b28", "#3a2d1e", "#5c4832", "#d8cba8", 10);
      break;
    default:
      paint("#5c5038", "#4c6636", "#617f44");
  }
}

// ——————————————————— sea art ———————————————————

/** Fish school (top-down ring of silhouettes) — rotated by shader for circling. */
export function drawFishSchool(ctx: Ctx, size: number): void {
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = size * (0.2 + 0.08 * Math.sin(i * 2.3));
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a + Math.PI / 2);
    const L = size * 0.065;
    ctx.fillStyle = "rgba(30,52,64,0.85)";
    ctx.beginPath();
    ctx.ellipse(0, 0, L * 0.32, L, 0, 0, Math.PI * 2);
    ctx.fill();
    // tail
    ctx.beginPath();
    ctx.moveTo(0, L * 0.9);
    ctx.lineTo(-L * 0.3, L * 1.4);
    ctx.lineTo(L * 0.3, L * 1.4);
    ctx.closePath();
    ctx.fill();
    // light back stripe
    ctx.fillStyle = "rgba(120,160,170,0.5)";
    ctx.beginPath();
    ctx.ellipse(0, -L * 0.2, L * 0.14, L * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export function drawWhale(ctx: Ctx, size: number): void {
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  // body (top view, surfacing back)
  ctx.fillStyle = "#2c3e48";
  ctx.beginPath();
  ctx.ellipse(cx, cy, size * 0.3, size * 0.13, 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#3d5460";
  ctx.beginPath();
  ctx.ellipse(cx - size * 0.05, cy - size * 0.02, size * 0.22, size * 0.08, 0.3, 0, Math.PI * 2);
  ctx.fill();
  // tail fluke
  ctx.fillStyle = "#2c3e48";
  ctx.save();
  ctx.translate(cx + size * 0.3, cy + size * 0.1);
  ctx.rotate(0.4);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(size * 0.1, -size * 0.08, size * 0.16, -size * 0.02);
  ctx.quadraticCurveTo(size * 0.1, 0.0, size * 0.16, size * 0.06);
  ctx.quadraticCurveTo(size * 0.06, size * 0.04, 0, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // broken wake arcs (not a full ring — reads as water disturbance)
  ctx.strokeStyle = "rgba(230,244,248,0.6)";
  ctx.lineWidth = size * 0.016;
  for (const [a0, a1, rr] of [
    [0.4, 1.6, 0.36],
    [2.4, 3.3, 0.33],
    [4.2, 5.3, 0.38],
  ] as const) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, size * rr, size * rr * 0.48, 0.3, a0, a1);
    ctx.stroke();
  }
  // spout
  ctx.fillStyle = "rgba(235,248,252,0.9)";
  ctx.beginPath();
  ctx.arc(cx - size * 0.26, cy - size * 0.1, size * 0.045, 0, Math.PI * 2);
  ctx.arc(cx - size * 0.3, cy - size * 0.16, size * 0.03, 0, Math.PI * 2);
  ctx.fill();
}

export function drawPearlBed(ctx: Ctx, size: number): void {
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  const rnd = (i: number) => hash01("pearl", i);
  // dark reef patch
  ctx.fillStyle = "rgba(70,102,96,0.55)";
  ctx.beginPath();
  ctx.ellipse(cx, cy, size * 0.32, size * 0.26, 0.5, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 12; i++) {
    const a = rnd(i) * Math.PI * 2;
    const r = size * 0.26 * Math.sqrt(rnd(i + 20));
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r * 0.8;
    // oyster shell
    ctx.fillStyle = i % 3 === 0 ? "#d8cca8" : "#b0a68c";
    ctx.beginPath();
    ctx.ellipse(x, y, size * 0.036, size * 0.028, rnd(i + 40) * Math.PI, 0, Math.PI * 2);
    ctx.fill();
    if (i % 3 === 0) {
      ctx.fillStyle = "#f2f0ff";
      ctx.beginPath();
      ctx.arc(x, y, size * 0.013, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function drawCrabs(ctx: Ctx, size: number): void {
  ctx.clearRect(0, 0, size, size);
  const rnd = (i: number) => hash01("crab", i);
  const crabSpots: [number, number][] = [
    [0.36, 0.4],
    [0.62, 0.5],
    [0.44, 0.66],
  ];
  for (let i = 0; i < 3; i++) {
    const x = size * (crabSpots[i]![0] + (rnd(i) - 0.5) * 0.08);
    const y = size * (crabSpots[i]![1] + (rnd(i + 10) - 0.5) * 0.08);
    const r = size * 0.08;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rnd(i + 20) * Math.PI * 2);
    ctx.fillStyle = "#b8503a";
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.75, 0, 0, Math.PI * 2);
    ctx.fill();
    // claws + legs
    ctx.strokeStyle = "#a04432";
    ctx.lineWidth = size * 0.012;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * r * 0.7, -r * 0.3);
      ctx.lineTo(s * r * 1.3, -r * 0.8);
      ctx.stroke();
      for (let l = 0; l < 3; l++) {
        ctx.beginPath();
        ctx.moveTo(s * r * 0.6, r * (0.1 + l * 0.25));
        ctx.lineTo(s * r * 1.25, r * (0.3 + l * 0.3));
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

export function drawOilSeep(ctx: Ctx, size: number): void {
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  ctx.fillStyle = "rgba(18,16,14,0.88)";
  ctx.beginPath();
  ctx.ellipse(cx, cy, size * 0.26, size * 0.19, 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(48,42,60,0.6)";
  ctx.beginPath();
  ctx.ellipse(cx - size * 0.06, cy - size * 0.04, size * 0.14, size * 0.09, 0.4, 0, Math.PI * 2);
  ctx.fill();
  // iridescent sheen
  ctx.fillStyle = "rgba(90,110,160,0.35)";
  ctx.beginPath();
  ctx.ellipse(cx + size * 0.05, cy + size * 0.03, size * 0.1, size * 0.05, 0.9, 0, Math.PI * 2);
  ctx.fill();
}

// ——————————————————— improvement terrain decals ———————————————————

export type ImprovementDecalKind = "pasture" | "mine" | "quarry" | "camp";

export const IMPROVEMENT_TERRAIN: Record<string, ImprovementDecalKind> = {
  Pasture: "pasture",
  Mine: "mine",
  Quarry: "quarry",
  Camp: "camp",
};

export function drawImprovementDecal(
  ctx: Ctx,
  kind: ImprovementDecalKind,
  size: number,
  seed: number,
): void {
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  const rnd = (i: number) => hash01(`i${kind}${seed}`, i);

  if (kind === "pasture") {
    // worn ground + irregular fence ring with posts
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.42);
    g.addColorStop(0, "rgba(150,128,88,0.35)");
    g.addColorStop(1, "rgba(150,128,88,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const n = 12;
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = size * 0.36 * (1 + 0.12 * Math.sin(a * 3 + seed));
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.85]);
    }
    ctx.strokeStyle = "#7a5c38";
    ctx.lineWidth = size * 0.014;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = "#5c4428";
    for (const [x, y] of pts) {
      ctx.fillRect(x - size * 0.012, y - size * 0.02, size * 0.024, size * 0.04);
    }
    // gate gap
    ctx.clearRect(pts[0]![0] - size * 0.03, pts[0]![1] - size * 0.03, size * 0.07, size * 0.06);
  } else if (kind === "mine") {
    // dark adit + timber frame + spoil fan
    contactShadow(ctx, cx, cy, size * 0.3, size * 0.24);
    ctx.fillStyle = "#8a7a62";
    ctx.beginPath();
    ctx.ellipse(cx + size * 0.08, cy + size * 0.1, size * 0.2, size * 0.13, 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1e1810";
    ctx.beginPath();
    ctx.ellipse(cx - size * 0.06, cy - size * 0.04, size * 0.1, size * 0.075, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#6b4c2c";
    ctx.lineWidth = size * 0.022;
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.16, cy + size * 0.04);
    ctx.lineTo(cx - size * 0.13, cy - size * 0.1);
    ctx.lineTo(cx + size * 0.02, cy - size * 0.11);
    ctx.lineTo(cx + size * 0.04, cy + size * 0.02);
    ctx.stroke();
    // cart track
    ctx.strokeStyle = "#54483a";
    ctx.lineWidth = size * 0.012;
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.05, cy);
    ctx.quadraticCurveTo(cx + size * 0.12, cy + size * 0.08, cx + size * 0.26, cy + size * 0.16);
    ctx.stroke();
  } else if (kind === "quarry") {
    // stepped cut pit + blocks
    ctx.fillStyle = "#b3a88f";
    ctx.beginPath();
    ctx.ellipse(cx, cy, size * 0.3, size * 0.22, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#94896f";
    ctx.beginPath();
    ctx.ellipse(cx, cy, size * 0.21, size * 0.15, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#78704f";
    ctx.beginPath();
    ctx.ellipse(cx, cy, size * 0.12, size * 0.08, 0.2, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 4; i++) {
      const x = cx + (rnd(i) - 0.5) * size * 0.55;
      const y = cy + size * (0.24 + rnd(i + 5) * 0.08);
      ctx.fillStyle = "#c9c0a8";
      ctx.fillRect(x, y, size * 0.05, size * 0.035);
      ctx.fillStyle = "#8f8770";
      ctx.fillRect(x, y + size * 0.028, size * 0.05, size * 0.008);
    }
  } else {
    // camp: tents + fire
    contactShadow(ctx, cx, cy + size * 0.06, size * 0.3, size * 0.22);
    const tent = (x: number, y: number, s: number, tone: string, dark: string) => {
      ctx.fillStyle = dark;
      ctx.beginPath();
      ctx.moveTo(x - s, y + s * 0.7);
      ctx.lineTo(x, y - s * 0.9);
      ctx.lineTo(x + s, y + s * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = tone;
      ctx.beginPath();
      ctx.moveTo(x - s * 0.75, y + s * 0.7);
      ctx.lineTo(x, y - s * 0.72);
      ctx.lineTo(x + s * 0.35, y + s * 0.7);
      ctx.closePath();
      ctx.fill();
    };
    tent(cx - size * 0.12, cy - size * 0.03, size * 0.12, "#c9b590", "#8f7a54");
    tent(cx + size * 0.14, cy + size * 0.06, size * 0.1, "#b9a075", "#7d6a48");
    // fire
    ctx.fillStyle = "#2c2418";
    ctx.beginPath();
    ctx.arc(cx + size * 0.0, cy + size * 0.16, size * 0.035, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e8923e";
    ctx.beginPath();
    ctx.arc(cx, cy + size * 0.155, size * 0.018, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ——————————————————— decal mesh (ground-hugging quads) ———————————————————

interface GroundSpot {
  tile: OverlayTile;
  ox: number;
  oy: number;
  r: number;
  rot: number;
}

function buildGroundDecalMesh(
  spots: GroundSpot[],
  tex: THREE.Texture,
  groundZ: GroundZ,
  opts: { lift?: number; opacity?: number; renderOrder?: number; fixedZ?: number; spin?: boolean } = {},
): THREE.Mesh {
  const divs = 3;
  const lift = opts.lift ?? 0.012;
  const quadVerts = divs * divs * 6;
  const positions = new Float32Array(spots.length * quadVerts * 3);
  const uvs = new Float32Array(spots.length * quadVerts * 2);
  const phases = opts.spin ? new Float32Array(spots.length * quadVerts) : null;
  let p = 0;
  let u = 0;
  let ph = 0;
  for (const s of spots) {
    const cos = Math.cos(s.rot);
    const sin = Math.sin(s.rot);
    const phase = hash01(s.tile.key, 77) * Math.PI * 2;
    const corner = (i: number, j: number): [number, number, number, number, number] => {
      const qx = (i / divs) * 2 * s.r - s.r;
      const qy = (j / divs) * 2 * s.r - s.r;
      const lx = s.ox + qx * cos - qy * sin;
      const ly = s.oy + qx * sin + qy * cos;
      const z = opts.fixedZ !== undefined ? opts.fixedZ : groundZ(s.tile, lx, ly) + lift;
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
          if (phases) phases[ph++] = phase;
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  if (phases) geo.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));

  if (opts.spin) {
    // fish schools: rotate UV around the center → circling swim
    tex.colorSpace = THREE.NoColorSpace; // raw shader output (see billboards)
    const uTime = { value: 0 };
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, uTime, uOpacity: { value: opts.opacity ?? 1 } },
      vertexShader: `
        attribute float aPhase;
        varying vec2 vUv;
        varying float vPhase;
        void main() {
          vUv = uv;
          vPhase = aPhase;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        uniform float uTime;
        uniform float uOpacity;
        varying vec2 vUv;
        varying float vPhase;
        void main() {
          float a = uTime * 0.22 + vPhase;
          mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
          vec2 uv = rot * (vUv - 0.5) + 0.5;
          vec4 c = texture2D(map, uv);
          if (c.a < 0.03) discard;
          gl_FragColor = vec4(c.rgb, c.a * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = opts.renderOrder ?? 3;
    mesh.userData.uTime = mat.uniforms.uTime;
    return mesh;
  }

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

// ——————————————————— top-level builder ———————————————————

/** Sea resources sit on water: art anchors at the surface, not the seabed. */
function isWaterTerrain(t: OverlayTile): boolean {
  return t.baseTerrain === "Coast" || t.baseTerrain === "Ocean" || t.baseTerrain === "Lakes";
}

export interface ResourceTerrainLayer {
  group: THREE.Group;
  timeUniforms: { value: number }[];
}

/**
 * Everything-on-the-ground for resources + the improvements without Firaxis
 * decals. One merged mesh per texture. `wheatDecalUrl` (real Civ5 wheat
 * field) is used for Wheat when available.
 */
export async function buildResourceTerrainArt(
  tiles: OverlayTile[],
  groundZ: GroundZ,
  opts: { wheatDecalUrl?: string } = {},
): Promise<ResourceTerrainLayer> {
  const group = new THREE.Group();
  const timeUniforms: { value: number }[] = [];

  // ——— collect per category ———
  const animalAnchors = new Map<string, BillboardAnchor[]>(); // "cow|graze" -> anchors
  const plantAnchors = new Map<PlantKind, BillboardAnchor[]>();
  const mineralAnchors = new Map<MineralKind, BillboardAnchor[]>();
  const fieldSpots = new Map<PlantKind, GroundSpot[]>();
  const seaSpots = new Map<SeaKind, GroundSpot[]>();
  const oilSpots: GroundSpot[] = [];
  const impSpots = new Map<ImprovementDecalKind, GroundSpot[]>();
  let wheatSpots: GroundSpot[] = [];

  const FIELD_KINDS = new Set<PlantKind>(["wine", "cotton", "dyes", "truffles"]);

  for (const t of tiles) {
    if (t.improvement) {
      const impKind = IMPROVEMENT_TERRAIN[t.improvement];
      if (impKind) {
        const arr = impSpots.get(impKind) ?? [];
        arr.push({ tile: t, ox: 0, oy: 0, r: 0.62, rot: 0 });
        impSpots.set(impKind, arr);
      }
    }
    if (!t.resource) continue;

    const animal = ANIMAL_RESOURCES[t.resource];
    if (animal) {
      const look = SPECIES[animal];
      const spots = spotsInTile(t.key, look.count, 0.4);
      spots.forEach((s, i) => {
        const grazing = hash01(t.key, 200 + i) < 0.6;
        const mkey = `${animal}|${grazing ? "g" : "s"}`;
        const arr = animalAnchors.get(mkey) ?? [];
        arr.push({
          x: t.world.x + s.x,
          y: t.world.y + s.y,
          z: groundZ(t, s.x, s.y) + 0.01,
          scale: look.scale * (0.85 + 0.3 * hash01(t.key, 300 + i)),
          phase: hash01(t.key, 400 + i) * Math.PI * 2,
          flip: hash01(t.key, 500 + i) < 0.5,
        });
        animalAnchors.set(mkey, arr);
      });
      continue;
    }

    const mineral = MINERAL_RESOURCES[t.resource];
    if (mineral) {
      // upright outcrops (Civ5 minerals are shiny rocks growing out of
      // boulders, not ground stains): one main cluster + a smaller echo
      const arr = mineralAnchors.get(mineral) ?? [];
      const ox = (hash01(t.key, 21) - 0.5) * 0.3;
      const oy = (hash01(t.key, 22) - 0.5) * 0.3;
      arr.push({
        x: t.world.x + ox,
        y: t.world.y + oy,
        z: groundZ(t, ox, oy) + 0.005,
        scale: 0.3 + 0.1 * hash01(t.key, 23),
        phase: 0,
        flip: hash01(t.key, 24) < 0.5,
      });
      if (hash01(t.key, 25) < 0.55) {
        const ox2 = ox + (hash01(t.key, 26) - 0.5) * 0.5;
        const oy2 = oy - 0.25 - hash01(t.key, 27) * 0.2;
        arr.push({
          x: t.world.x + ox2,
          y: t.world.y + oy2,
          z: groundZ(t, ox2, oy2) + 0.005,
          scale: 0.18 + 0.06 * hash01(t.key, 28),
          phase: 0,
          flip: hash01(t.key, 29) < 0.5,
        });
      }
      mineralAnchors.set(mineral, arr);
      continue;
    }

    const plant = PLANT_RESOURCES[t.resource];
    if (plant) {
      if (plant === "wheat") {
        wheatSpots.push({ tile: t, ox: 0, oy: 0, r: 0.44, rot: hash01(t.key, 24) * Math.PI * 2 });
      } else if (FIELD_KINDS.has(plant)) {
        const arr = fieldSpots.get(plant) ?? [];
        arr.push({ tile: t, ox: 0, oy: 0, r: 0.5, rot: hash01(t.key, 25) * Math.PI * 2 });
        fieldSpots.set(plant, arr);
      } else {
        const spots = spotsInTile(t.key, 3, 0.38);
        const arr = plantAnchors.get(plant) ?? [];
        spots.forEach((s, i) => {
          arr.push({
            x: t.world.x + s.x,
            y: t.world.y + s.y,
            z: groundZ(t, s.x, s.y) + 0.01,
            scale: 0.3 * (0.85 + 0.3 * hash01(t.key, 600 + i)),
            phase: 0,
            flip: hash01(t.key, 700 + i) < 0.5,
          });
        });
        plantAnchors.set(plant, arr);
      }
      continue;
    }

    const sea = SEA_RESOURCES[t.resource];
    if (sea && isWaterTerrain(t)) {
      const arr = seaSpots.get(sea) ?? [];
      arr.push({
        tile: t,
        ox: (hash01(t.key, 26) - 0.5) * 0.3,
        oy: (hash01(t.key, 27) - 0.5) * 0.3,
        r: sea === "whale" ? 0.5 : 0.45,
        rot: hash01(t.key, 28) * Math.PI * 2,
      });
      seaSpots.set(sea, arr);
      continue;
    }

    if (t.resource === "Oil" && !isWaterTerrain(t)) {
      oilSpots.push({ tile: t, ox: 0.1, oy: -0.1, r: 0.42, rot: hash01(t.key, 29) * Math.PI * 2 });
    }
  }

  // ——— build animals ———
  for (const [mkey, anchors] of animalAnchors) {
    const [species, pose] = mkey.split("|") as [AnimalSpecies, string];
    const [c, ctx] = makeCanvas(128, 128);
    drawAnimal(ctx, species, 128, 128, pose === "g");
    const layer = buildWorldBillboards(anchors, canvasTexture(c), {
      anim: "graze",
      // pivot just below the feet: sprite stands ON the anchor point
      centerY: 0.08,
      renderOrder: 2.5,
    });
    group.add(layer.object);
    timeUniforms.push(...layer.timeUniforms);
  }

  // ——— plants (billboards) ———
  for (const [kind, anchors] of plantAnchors) {
    const [c, ctx] = makeCanvas(128, 128);
    drawPlantSprite(ctx, kind, 128, 128, 1);
    const layer = buildWorldBillboards(anchors, canvasTexture(c), {
      anim: "none",
      centerY: 0.08,
      renderOrder: 2.5,
    });
    group.add(layer.object);
    timeUniforms.push(...layer.timeUniforms);
  }

  // ——— minerals (upright outcrop billboards) ———
  for (const [kind, anchors] of mineralAnchors) {
    const [c, ctx] = makeCanvas(128, 128);
    drawMineralSprite(ctx, kind, 128, 128, 3);
    const layer = buildWorldBillboards(anchors, canvasTexture(c), {
      anim: "none",
      centerY: 0.08,
      renderOrder: 2.5,
    });
    group.add(layer.object);
    timeUniforms.push(...layer.timeUniforms);
  }

  // ——— wheat (real Civ5 field art when extracted; fallback: field decal) ———
  if (wheatSpots.length > 0) {
    let tex: THREE.Texture | null = null;
    if (opts.wheatDecalUrl) {
      tex = await new Promise<THREE.Texture | null>((resolve) => {
        const img = new Image();
        img.onload = () => {
          // irregular soft-edged blob mask (like the farm crops treatment) —
          // a plain radial disc read as a fried egg on the map
          const size = 256;
          const [c, ctx] = makeCanvas(size, size);
          ctx.drawImage(img, 0, 0, size, size);
          const id = ctx.getImageData(0, 0, size, size);
          const d = id.data;
          const half = size / 2;
          for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
              const dx = (x - half) / half;
              const dy = (y - half) / half;
              const ang = Math.atan2(dy, dx);
              const wob = 0.16 * Math.sin(ang * 3 + 1.7) + 0.1 * Math.sin(ang * 7 + 4.1);
              const r = Math.hypot(dx, dy) / (0.82 + wob);
              const a = r < 0.72 ? 1 : Math.max(0, 1 - (r - 0.72) / 0.26);
              d[(y * size + x) * 4 + 3] = Math.round(a * 235);
            }
          }
          ctx.putImageData(id, 0, 0);
          resolve(canvasTexture(c));
        };
        img.onerror = () => resolve(null);
        img.src = opts.wheatDecalUrl!;
      });
    }
    if (!tex) {
      const [c, ctx] = makeCanvas(256, 256);
      drawFieldDecal(ctx, "wheat", 256, 5);
      tex = canvasTexture(c);
    }
    group.add(buildGroundDecalMesh(wheatSpots, tex, groundZ, { renderOrder: 3, opacity: 0.95 }));
  }

  // ——— field crops ———
  for (const [kind, spots] of fieldSpots) {
    const [c, ctx] = makeCanvas(256, 256);
    drawFieldDecal(ctx, kind, 256, 7);
    group.add(buildGroundDecalMesh(spots, canvasTexture(c), groundZ, { renderOrder: 3 }));
  }

  // ——— sea life ———
  for (const [kind, spots] of seaSpots) {
    const [c, ctx] = makeCanvas(256, 256);
    if (kind === "fish") drawFishSchool(ctx, 256);
    else if (kind === "whale") drawWhale(ctx, 256);
    else if (kind === "pearls") drawPearlBed(ctx, 256);
    else drawCrabs(ctx, 256);
    // fish swim UNDER the translucent surface (drawn before it, tinted by it);
    // whales/crabs break the surface
    const under = kind === "fish" || kind === "pearls";
    const mesh = buildGroundDecalMesh(spots, canvasTexture(c), groundZ, {
      renderOrder: under ? -1 : 3,
      fixedZ: under ? -0.02 : 0.006,
      spin: kind === "fish",
    });
    if (mesh.userData.uTime) timeUniforms.push(mesh.userData.uTime as { value: number });
    group.add(mesh);
  }

  // ——— oil seeps ———
  if (oilSpots.length > 0) {
    const [c, ctx] = makeCanvas(256, 256);
    drawOilSeep(ctx, 256);
    group.add(buildGroundDecalMesh(oilSpots, canvasTexture(c), groundZ, { renderOrder: 3 }));
  }

  // ——— improvement terrain decals (pasture fence, mine, quarry, camp) ———
  for (const [kind, spots] of impSpots) {
    const [c, ctx] = makeCanvas(256, 256);
    drawImprovementDecal(ctx, kind, 256, 2);
    group.add(buildGroundDecalMesh(spots, canvasTexture(c), groundZ, { renderOrder: 2.8 }));
  }

  return { group, timeUniforms };
}
