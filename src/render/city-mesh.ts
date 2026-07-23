/**
 * Procedural 3D cities: a cluster of simple era-styled buildings on the city
 * tile — Civ5's city look scales with era and population, so ours does too:
 *   ancient/classical  sand-stone + terracotta, low, city wall ring
 *   medieval           timber + plaster, slate roofs, wall ring
 *   renaissance        dressed stone, blue-gray slate
 *   industrial         brick, smokestacks
 *   modern             concrete + glass towers
 * World wonders add tall white-and-gold landmark buildings.
 *
 * layoutCity() is pure (bun-testable); buildCityMeshes() turns layouts into
 * ONE merged vertex-colored mesh for all cities (cheap at 266 cities).
 */

import * as THREE from "three";
import type { Vec2 } from "../hex/hex-math";
import type { CityMarker } from "./board-model";

export type EraStyle =
  | "ancient"
  | "classical"
  | "medieval"
  | "renaissance"
  | "industrial"
  | "modern";

const ERA_NAME_STYLE: Record<string, EraStyle> = {
  "Ancient era": "ancient",
  "Classical era": "classical",
  "Medieval era": "medieval",
  "Renaissance era": "renaissance",
  "Industrial era": "industrial",
  "Modern era": "modern",
  "Atomic era": "modern",
  "Information era": "modern",
  "Future era": "modern",
};

export function eraStyleOf(era: string | undefined, eraT: number): EraStyle {
  if (era && ERA_NAME_STYLE[era]) return ERA_NAME_STYLE[era];
  // unknown era name (mods): fall back to position in the era order
  if (eraT < 0.15) return "ancient";
  if (eraT < 0.3) return "classical";
  if (eraT < 0.45) return "medieval";
  if (eraT < 0.6) return "renaissance";
  if (eraT < 0.75) return "industrial";
  return "modern";
}

export interface CityBuilding {
  /** offset from city center, world units */
  x: number;
  y: number;
  /** footprint half-extents */
  w: number;
  d: number;
  /** wall height */
  h: number;
  rot: number;
  roof: "pitched" | "flat";
  /** palette slot: 0 wall, 1 alt wall, 2 wonder */
  tone: 0 | 1 | 2;
  /** chimney/smokestack (industrial) */
  stack?: boolean;
  wonder?: boolean;
}

export interface CityLayout {
  buildings: CityBuilding[];
  /** wall ring radius (0 = no wall) */
  wallRadius: number;
}

function hashKey(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function hash01(key: string, salt: number): number {
  return (hashKey(`${key}|${salt}`) >>> 0) / 0x100000000;
}

/** Deterministic building layout for a city. */
export function layoutCity(
  key: string,
  population: number,
  style: EraStyle,
  wonderCount: number,
): CityLayout {
  const pop = Math.max(1, population);
  const count = Math.min(24, 4 + Math.round(pop * 0.9));
  const buildings: CityBuilding[] = [];

  const tall = style === "modern" ? 0.16 + Math.min(0.2, pop * 0.008) : 0;

  // central landmark
  buildings.push({
    x: 0,
    y: 0,
    w: 0.085,
    d: 0.085,
    h:
      style === "modern"
        ? tall + 0.1
        : style === "industrial"
          ? 0.1
          : 0.075 + 0.02 * hash01(key, 1),
    rot: hash01(key, 2) * Math.PI * 0.5,
    roof: style === "modern" || style === "industrial" ? "flat" : "pitched",
    tone: 0,
  });

  // rings of houses
  const rings = count <= 8 ? 1 : 2;
  let placed = 1;
  for (let ring = 1; ring <= rings && placed < count; ring++) {
    const r = 0.16 + ring * 0.16;
    const slots = ring === 1 ? 7 : 11;
    for (let s = 0; s < slots && placed < count; s++) {
      const ang = (s / slots) * Math.PI * 2 + hash01(key, 10 + ring * 31 + s) * 0.45;
      const rr = r * (0.9 + 0.25 * hash01(key, 40 + ring * 31 + s));
      const size = 0.038 + 0.028 * hash01(key, 70 + s + ring * 17);
      const isTower = style === "modern" && hash01(key, 90 + s) < 0.45;
      buildings.push({
        x: Math.cos(ang) * rr,
        y: Math.sin(ang) * rr,
        w: size,
        d: size * (0.8 + 0.5 * hash01(key, 100 + s)),
        h: isTower
          ? tall * (0.5 + 0.6 * hash01(key, 110 + s))
          : 0.035 + 0.025 * hash01(key, 120 + s) + (style === "industrial" ? 0.015 : 0),
        rot: ang + hash01(key, 130 + s) * 0.6,
        roof: isTower || style === "industrial" ? "flat" : "pitched",
        tone: hash01(key, 140 + s) < 0.35 ? 1 : 0,
        stack: style === "industrial" && hash01(key, 150 + s) < 0.4,
      });
      placed++;
    }
  }

  // wonders: tall white-gold landmarks near the center
  for (let wi = 0; wi < Math.min(4, wonderCount); wi++) {
    const ang = hash01(key, 200 + wi) * Math.PI * 2;
    const rr = 0.13 + 0.09 * hash01(key, 210 + wi);
    buildings.push({
      x: Math.cos(ang) * rr,
      y: Math.sin(ang) * rr,
      w: 0.055,
      d: 0.055,
      h: 0.13 + 0.035 * hash01(key, 220 + wi),
      rot: hash01(key, 230 + wi) * Math.PI,
      roof: "pitched",
      tone: 2,
      wonder: true,
    });
  }

  const walled = style === "ancient" || style === "classical" || style === "medieval";
  return {
    buildings,
    wallRadius: walled ? 0.52 + Math.min(0.1, pop * 0.006) : 0,
  };
}

interface Palette {
  wall: [number, number, number];
  wallAlt: [number, number, number];
  roof: [number, number, number];
  roofAlt: [number, number, number];
}

const PALETTES: Record<EraStyle, Palette> = {
  ancient: {
    wall: [0.83, 0.76, 0.6],
    wallAlt: [0.76, 0.68, 0.52],
    roof: [0.62, 0.4, 0.28],
    roofAlt: [0.56, 0.46, 0.32],
  },
  classical: {
    wall: [0.89, 0.86, 0.78],
    wallAlt: [0.8, 0.77, 0.68],
    roof: [0.66, 0.38, 0.24],
    roofAlt: [0.6, 0.35, 0.24],
  },
  medieval: {
    wall: [0.78, 0.72, 0.6],
    wallAlt: [0.5, 0.42, 0.32],
    roof: [0.36, 0.33, 0.3],
    roofAlt: [0.42, 0.31, 0.24],
  },
  renaissance: {
    wall: [0.78, 0.74, 0.64],
    wallAlt: [0.7, 0.66, 0.58],
    roof: [0.32, 0.38, 0.44],
    roofAlt: [0.55, 0.34, 0.24],
  },
  industrial: {
    wall: [0.56, 0.36, 0.28],
    wallAlt: [0.48, 0.44, 0.42],
    roof: [0.3, 0.3, 0.32],
    roofAlt: [0.26, 0.26, 0.28],
  },
  modern: {
    wall: [0.72, 0.74, 0.78],
    wallAlt: [0.48, 0.6, 0.72],
    roof: [0.38, 0.4, 0.44],
    roofAlt: [0.44, 0.46, 0.5],
  },
};

const WONDER_WALL: [number, number, number] = [0.95, 0.93, 0.85];
const WONDER_ROOF: [number, number, number] = [0.92, 0.78, 0.35];

/** simple sun factor per face normal (matches scene sun from up-left) */
function faceShade(nx: number, ny: number, nz: number): number {
  const l = [0.62, -0.5, 0.6];
  const d = nx * l[0]! + ny * l[1]! + nz * l[2]!;
  return 0.62 + 0.38 * Math.max(0, d);
}

export interface CitySite {
  marker: CityMarker;
  style: EraStyle;
  groundZ: (lx: number, ly: number) => number;
}

/**
 * One merged vertex-colored mesh for every city. Boxes + pitched roofs +
 * stacks; faces get baked directional shading (material is unlit-ish Lambert
 * with vertexColors so the merged mesh needs no per-face normals drama).
 */
export function buildCityMeshes(sites: CitySite[]): THREE.Mesh {
  const positions: number[] = [];
  const colors: number[] = [];

  const pushTri = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    col: [number, number, number],
    shadeN: [number, number, number],
  ) => {
    const s = faceShade(...shadeN);
    for (const v of [a, b, c]) positions.push(...v);
    for (let i = 0; i < 3; i++) colors.push(col[0] * s, col[1] * s, col[2] * s);
  };

  for (const site of sites) {
    const { marker, style } = site;
    const pal = PALETTES[style];
    const layout = layoutCity(marker.key, marker.population, style, marker.wonders.length);

    for (const b of layout.buildings) {
      const wall: [number, number, number] =
        b.tone === 2 ? WONDER_WALL : b.tone === 1 ? pal.wallAlt : pal.wall;
      const roofC: [number, number, number] = b.wonder
        ? WONDER_ROOF
        : b.tone === 1
          ? pal.roofAlt
          : pal.roof;
      const cos = Math.cos(b.rot);
      const sin = Math.sin(b.rot);
      const cxw = marker.world.x + b.x;
      const cyw = marker.world.y + b.y;
      const z0 = site.groundZ(b.x, b.y) - 0.01; // sink base into ground
      const z1 = z0 + 0.01 + b.h;

      // rotated footprint corners
      const corner = (sx: number, sy: number): [number, number] => [
        cxw + (sx * b.w * cos - sy * b.d * sin),
        cyw + (sx * b.w * sin + sy * b.d * cos),
      ];
      const c00 = corner(-1, -1);
      const c10 = corner(1, -1);
      const c11 = corner(1, 1);
      const c01 = corner(-1, 1);

      // 4 wall faces
      const faces: [typeof c00, typeof c00, [number, number, number]][] = [
        [c00, c10, [sin, -cos, 0]],
        [c10, c11, [cos, sin, 0]],
        [c11, c01, [-sin, cos, 0]],
        [c01, c00, [-cos, -sin, 0]],
      ];
      for (const [pA, pB, n] of faces) {
        pushTri([pA[0], pA[1], z0], [pB[0], pB[1], z0], [pB[0], pB[1], z1], wall, n);
        pushTri([pA[0], pA[1], z0], [pB[0], pB[1], z1], [pA[0], pA[1], z1], wall, n);
      }

      if (b.roof === "flat") {
        pushTri([c00[0], c00[1], z1], [c10[0], c10[1], z1], [c11[0], c11[1], z1], roofC, [0, 0, 1]);
        pushTri([c00[0], c00[1], z1], [c11[0], c11[1], z1], [c01[0], c01[1], z1], roofC, [0, 0, 1]);
      } else {
        // pitched: ridge along local x
        const ridgeH = z1 + Math.min(b.w, b.d) * 0.9;
        const r0 = corner(-1, 0);
        const r1 = corner(1, 0);
        // two slopes
        pushTri([c00[0], c00[1], z1], [c10[0], c10[1], z1], [r1[0], r1[1], ridgeH], roofC, [
          sin * 0.5,
          -cos * 0.5,
          0.85,
        ]);
        pushTri([c00[0], c00[1], z1], [r1[0], r1[1], ridgeH], [r0[0], r0[1], ridgeH], roofC, [
          sin * 0.5,
          -cos * 0.5,
          0.85,
        ]);
        pushTri([c11[0], c11[1], z1], [c01[0], c01[1], z1], [r0[0], r0[1], ridgeH], roofC, [
          -sin * 0.5,
          cos * 0.5,
          0.85,
        ]);
        pushTri([c11[0], c11[1], z1], [r0[0], r0[1], ridgeH], [r1[0], r1[1], ridgeH], roofC, [
          -sin * 0.5,
          cos * 0.5,
          0.85,
        ]);
        // gable ends
        pushTri([c10[0], c10[1], z1], [c11[0], c11[1], z1], [r1[0], r1[1], ridgeH], wall, [cos, sin, 0]);
        pushTri([c01[0], c01[1], z1], [c00[0], c00[1], z1], [r0[0], r0[1], ridgeH], wall, [-cos, -sin, 0]);
      }

      if (b.stack) {
        // smokestack: thin dark box poking above the roof
        const sw = b.w * 0.22;
        const sx = cxw + cos * b.w * 0.5;
        const sy = cyw + sin * b.w * 0.5;
        const st = z1 + b.h * 0.9 + 0.02;
        const dark: [number, number, number] = [0.24, 0.22, 0.22];
        const sc = (ax: number, ay: number): [number, number] => [sx + ax * sw, sy + ay * sw];
        const s00 = sc(-1, -1);
        const s10 = sc(1, -1);
        const s11 = sc(1, 1);
        const s01 = sc(-1, 1);
        const sFaces: [typeof s00, typeof s00, [number, number, number]][] = [
          [s00, s10, [0, -1, 0]],
          [s10, s11, [1, 0, 0]],
          [s11, s01, [0, 1, 0]],
          [s01, s00, [-1, 0, 0]],
        ];
        for (const [pA, pB, n] of sFaces) {
          pushTri([pA[0], pA[1], z0], [pB[0], pB[1], z0], [pB[0], pB[1], st], dark, n);
          pushTri([pA[0], pA[1], z0], [pB[0], pB[1], st], [pA[0], pA[1], st], dark, n);
        }
        pushTri([s00[0], s00[1], st], [s10[0], s10[1], st], [s11[0], s11[1], st], dark, [0, 0, 1]);
        pushTri([s00[0], s00[1], st], [s11[0], s11[1], st], [s01[0], s01[1], st], dark, [0, 0, 1]);
      }
    }

    // city wall ring (segmented, follows terrain)
    if (layout.wallRadius > 0) {
      const segs = 22;
      const wallH = 0.03;
      const wallW = 0.014;
      const wallC: [number, number, number] =
        style === "medieval" ? [0.42, 0.39, 0.34] : [0.6, 0.55, 0.44];
      for (let i = 0; i < segs; i++) {
        // leave a gate gap
        if (i === 3) continue;
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 0.86) / segs) * Math.PI * 2;
        // jittered radius: a perfect ellipse reads as a UI ring, not masonry
        const r = layout.wallRadius * (0.94 + 0.1 * hash01(marker.key, 300 + i));
        const p0: Vec2 = { x: Math.cos(a0) * r, y: Math.sin(a0) * r };
        const p1: Vec2 = { x: Math.cos(a1) * r, y: Math.sin(a1) * r };
        const z0 = Math.min(site.groundZ(p0.x, p0.y), site.groundZ(p1.x, p1.y)) - 0.008;
        const zt = Math.max(site.groundZ(p0.x, p0.y), site.groundZ(p1.x, p1.y)) + wallH;
        const nx = Math.cos((a0 + a1) / 2);
        const ny = Math.sin((a0 + a1) / 2);
        const ox = nx * wallW;
        const oy = ny * wallW;
        const w0o: [number, number] = [marker.world.x + p0.x + ox, marker.world.y + p0.y + oy];
        const w1o: [number, number] = [marker.world.x + p1.x + ox, marker.world.y + p1.y + oy];
        const w0i: [number, number] = [marker.world.x + p0.x - ox, marker.world.y + p0.y - oy];
        const w1i: [number, number] = [marker.world.x + p1.x - ox, marker.world.y + p1.y - oy];
        // outer face
        pushTri([w0o[0], w0o[1], z0], [w1o[0], w1o[1], z0], [w1o[0], w1o[1], zt], wallC, [nx, ny, 0]);
        pushTri([w0o[0], w0o[1], z0], [w1o[0], w1o[1], zt], [w0o[0], w0o[1], zt], wallC, [nx, ny, 0]);
        // inner face
        pushTri([w1i[0], w1i[1], z0], [w0i[0], w0i[1], z0], [w0i[0], w0i[1], zt], wallC, [-nx, -ny, 0]);
        pushTri([w1i[0], w1i[1], z0], [w0i[0], w0i[1], zt], [w1i[0], w1i[1], zt], wallC, [-nx, -ny, 0]);
        // top
        pushTri([w0o[0], w0o[1], zt], [w1o[0], w1o[1], zt], [w1i[0], w1i[1], zt], wallC, [0, 0, 1]);
        pushTri([w0o[0], w0o[1], zt], [w1i[0], w1i[1], zt], [w0i[0], w0i[1], zt], wallC, [0, 0, 1]);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1.2;
  return mesh;
}
