/**
 * three.js scene construction from a BoardModel + asset map.
 *
 * Draw strategy (9919 tiles must be cheap):
 *  - Base terrain: ONE merged BufferGeometry per texture group, with
 *    world-space UVs so same-terrain neighbours read as continuous painted
 *    ground (the single biggest "Civ5 not spreadsheet" trick).
 *  - Feature overlays: merged alpha-textured geometry per feature, z-stacked.
 *  - Rivers/roads/borders: merged quad-strip geometries.
 *  - Cities/units: THREE.Sprite billboards with canvas-drawn textures.
 */

import * as THREE from "three";
import { hexCornerVectors, type Vec2 } from "../hex/hex-math";
import type { BoardModel, CivColors, EdgeSegment } from "./board-model";
import assetMap from "./asset-map.json";

const WORLD_UV_SCALE = 0.18; // world units -> texture repeats

interface AssetEntry {
  texture?: string;
  z?: number;
}

function rgb(c: [number, number, number]): THREE.Color {
  return new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255);
}

// ——————————————————— geometry helpers ———————————————————

/**
 * Merged hex-fan geometry for a set of tile centers, world-space UVs.
 * `overlap` scales the hexes slightly past their true edges so adjacent
 * texture groups seal against antialiasing cracks (pair with a per-group
 * z-epsilon to avoid z-fighting).
 */
function hexFanGeometry(
  centers: Vec2[],
  corners: Vec2[],
  z: number,
  overlap = 1,
): THREE.BufferGeometry {
  const positions = new Float32Array(centers.length * 18 * 3);
  const uvs = new Float32Array(centers.length * 18 * 2);
  let p = 0;
  let u = 0;
  const push = (x: number, y: number) => {
    positions[p++] = x;
    positions[p++] = y;
    positions[p++] = z;
    uvs[u++] = x * WORLD_UV_SCALE;
    uvs[u++] = y * WORLD_UV_SCALE;
  };
  for (const c of centers) {
    for (let i = 0; i < 6; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % 6]!;
      // corners run clockwise on screen; emit center→b→a so triangles wind
      // counter-clockwise (front-facing) when viewed from +Z
      push(c.x, c.y);
      push(c.x + b.x * overlap, c.y + b.y * overlap);
      push(c.x + a.x * overlap, c.y + a.y * overlap);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  return geo;
}

/** Merged quads along edge segments (rivers, borders). */
function segmentQuadGeometry(
  segments: EdgeSegment[],
  width: number,
  z: number,
  /** pull the quad toward this point (per segment), e.g. tile center for borders */
  insetToward?: Vec2[],
): THREE.BufferGeometry {
  const positions = new Float32Array(segments.length * 6 * 3);
  let p = 0;
  segments.forEach((s, idx) => {
    const dx = s.b.x - s.a.x;
    const dy = s.b.y - s.a.y;
    const len = Math.hypot(dx, dy) || 1;
    // normal pointing toward the inset target (or arbitrary side)
    let nx = -dy / len;
    let ny = dx / len;
    if (insetToward) {
      const t = insetToward[idx]!;
      const mx = (s.a.x + s.b.x) / 2;
      const my = (s.a.y + s.b.y) / 2;
      if (nx * (t.x - mx) + ny * (t.y - my) < 0) {
        nx = -nx;
        ny = -ny;
      }
    }
    const ax = s.a.x;
    const ay = s.a.y;
    const bx = s.b.x;
    const by = s.b.y;
    const a2x = ax + nx * width;
    const a2y = ay + ny * width;
    const b2x = bx + nx * width;
    const b2y = by + ny * width;
    const quad = [ax, ay, bx, by, b2x, b2y, ax, ay, b2x, b2y, a2x, a2y];
    for (let i = 0; i < quad.length; i += 2) {
      positions[p++] = quad[i]!;
      positions[p++] = quad[i + 1]!;
      positions[p++] = z;
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geo;
}

/** Winding of segment quads depends on segment direction — render both sides. */
function flatMaterial(params: THREE.MeshBasicMaterialParameters): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ ...params, side: THREE.DoubleSide });
}

/** Merged quads along center-to-center paths (roads). */
function pathQuadGeometry(
  paths: { from: Vec2; to: Vec2 }[],
  width: number,
  z: number,
): THREE.BufferGeometry {
  return segmentQuadGeometry(
    paths.map((r) => ({ a: r.from, b: r.to })),
    width,
    z,
  );
}

// ——————————————————— billboards ———————————————————

function canvasSprite(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, w: number, h: number): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

function cssColor(c: [number, number, number], alpha = 1): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

function cityBannerTexture(name: string, pop: number, colors: CivColors): THREE.Texture {
  const w = 512;
  const h = 160;
  return canvasSprite(
    (ctx) => {
      ctx.font = "bold 56px Georgia, serif";
      const label = `${name}`;
      const textW = Math.min(w - 120, ctx.measureText(label).width);
      const bw = textW + 110;
      const bx = (w - bw) / 2;
      // banner
      ctx.fillStyle = cssColor(colors.outer, 0.92);
      ctx.strokeStyle = cssColor(colors.inner, 0.9);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.roundRect(bx, 30, bw, 76, 14);
      ctx.fill();
      ctx.stroke();
      // pop medallion
      ctx.beginPath();
      ctx.arc(bx + 40, 68, 30, 0, Math.PI * 2);
      ctx.fillStyle = cssColor(colors.inner);
      ctx.fill();
      ctx.fillStyle = cssColor(colors.outer);
      ctx.font = "bold 40px Georgia, serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(pop), bx + 40, 70);
      // name
      ctx.fillStyle = cssColor(colors.inner);
      ctx.font = "bold 56px Georgia, serif";
      ctx.textAlign = "left";
      ctx.fillText(name, bx + 84, 70, w - 160);
    },
    w,
    h,
  );
}

function unitTexture(initial: string, colors: CivColors, military: boolean): THREE.Texture {
  const s = 128;
  return canvasSprite(
    (ctx) => {
      ctx.translate(s / 2, s / 2);
      if (military) {
        // shield
        ctx.beginPath();
        ctx.moveTo(0, -44);
        ctx.quadraticCurveTo(40, -36, 38, 0);
        ctx.quadraticCurveTo(36, 36, 0, 50);
        ctx.quadraticCurveTo(-36, 36, -38, 0);
        ctx.quadraticCurveTo(-40, -36, 0, -44);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, 42, 0, Math.PI * 2);
      }
      ctx.fillStyle = cssColor(colors.outer);
      ctx.fill();
      ctx.lineWidth = 6;
      ctx.strokeStyle = cssColor(colors.inner);
      ctx.stroke();
      ctx.fillStyle = cssColor(colors.inner);
      ctx.font = "bold 52px Georgia, serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(initial, 0, 4);
    },
    s,
    s,
  );
}

// ——————————————————— scene build ———————————————————

export interface BuiltScene {
  scene: THREE.Scene;
  center: Vec2;
  radius: number;
}

export function buildScene(model: BoardModel): BuiltScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1626); // deep sea void beyond map edge
  const corners = hexCornerVectors();
  const loader = new THREE.TextureLoader();
  const pack = assetMap.pack.textureRoot;

  const loadTex = (file: string): THREE.Texture => {
    const tex = loader.load(pack + file);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };

  // ——— base terrain groups ———
  const baseMap = assetMap.baseTerrain as Record<string, AssetEntry>;
  const groups = new Map<string, { centers: Vec2[]; tint?: [number, number, number] }>();
  for (const tile of model.tiles) {
    const entry = baseMap[tile.baseTerrain] ?? baseMap["*"]!;
    const key = entry.texture!;
    const g = groups.get(key) ?? { centers: [] };
    g.centers.push(tile.world);
    if (!baseMap[tile.baseTerrain]) g.tint = tile.terrainRGB; // unknown terrain: tint fallback texture
    groups.set(key, g);
  }
  let groupIndex = 0;
  for (const [texFile, group] of groups) {
    // slight overlap + per-group z-epsilon: seals AA cracks between groups
    const geo = hexFanGeometry(group.centers, corners, groupIndex * 0.0004, 1.04);
    const mat = new THREE.MeshBasicMaterial({ map: loadTex(texFile) });
    if (group.tint) mat.color = rgb(group.tint);
    scene.add(new THREE.Mesh(geo, mat));
    groupIndex++;
  }

  // ——— feature overlays ———
  const featMap = assetMap.features as Record<string, AssetEntry>;
  const featGroups = new Map<string, Vec2[]>();
  for (const tile of model.tiles) {
    for (const f of tile.features) {
      const entry = featMap[f];
      if (!entry?.texture) continue;
      const arr = featGroups.get(f) ?? [];
      arr.push(tile.world);
      featGroups.set(f, arr);
    }
  }
  for (const [feature, centers] of featGroups) {
    const entry = featMap[feature]!;
    const z = 0.01 + (entry.z ?? 1) * 0.004;
    const geo = hexFanGeometry(centers, corners, z);
    const mat = new THREE.MeshBasicMaterial({
      map: loadTex(entry.texture!),
      transparent: true,
      depthWrite: false,
    });
    scene.add(new THREE.Mesh(geo, mat));
  }

  // ——— rivers ———
  if (model.rivers.length > 0) {
    const geo = segmentQuadGeometry(model.rivers, assetMap.rivers.width, 0.05);
    scene.add(
      new THREE.Mesh(
        geo,
        flatMaterial({ color: new THREE.Color(assetMap.rivers.color) }),
      ),
    );
  }

  // ——— roads ———
  for (const kind of ["Road", "Railroad"] as const) {
    const segs = model.roads.filter((r) => r.kind === kind);
    if (segs.length === 0) continue;
    const spec = assetMap.roads[kind];
    const geo = pathQuadGeometry(segs, spec.width, 0.055);
    scene.add(new THREE.Mesh(geo, flatMaterial({ color: new THREE.Color(spec.color) })));
  }

  // ——— territory fill + borders ———
  const byCiv = new Map<string, Vec2[]>();
  for (const tile of model.tiles) {
    if (!tile.owner) continue;
    const arr = byCiv.get(tile.owner) ?? [];
    arr.push(tile.world);
    byCiv.set(tile.owner, arr);
  }
  for (const [civ, centers] of byCiv) {
    const colors = model.civColors.get(civ)!;
    const geo = hexFanGeometry(centers, corners, 0.06);
    scene.add(
      new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: rgb(colors.outer),
          transparent: true,
          opacity: 0.14,
          depthWrite: false,
        }),
      ),
    );
  }
  const borderByCiv = new Map<string, { segs: EdgeSegment[]; centers: Vec2[] }>();
  for (const b of model.borders) {
    const e = borderByCiv.get(b.civ) ?? { segs: [], centers: [] };
    e.segs.push(b);
    e.centers.push(b.center);
    borderByCiv.set(b.civ, e);
  }
  for (const [civ, { segs, centers }] of borderByCiv) {
    const colors = model.civColors.get(civ)!;
    const geo = segmentQuadGeometry(segs, assetMap.borders.width, 0.065, centers);
    scene.add(new THREE.Mesh(geo, flatMaterial({ color: rgb(colors.outer) })));
  }

  // ——— natural wonder markers ———
  const wonderTiles = model.tiles.filter((t) => t.naturalWonder);
  for (const t of wonderTiles) {
    const tex = canvasSprite(
      (ctx, w, h) => {
        ctx.translate(w / 2, h / 2);
        ctx.fillStyle = assetMap.naturalWonder.markerColor;
        ctx.strokeStyle = "#6b5300";
        ctx.lineWidth = 4;
        // 5-point star
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const r = i % 2 === 0 ? 46 : 20;
          const a = (i * Math.PI) / 5 - Math.PI / 2;
          ctx[i === 0 ? "moveTo" : "lineTo"](r * Math.cos(a), r * Math.sin(a));
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      },
      128,
      128,
    );
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sprite.position.set(t.world.x, t.world.y, 0.4);
    sprite.scale.set(0.9, 0.9, 1);
    scene.add(sprite);
  }

  // ——— resource / improvement markers (small, subtle) ———
  const resSpecs = assetMap.resources as Record<string, { markerColor: string }>;
  const resGroups = new Map<string, Vec2[]>();
  for (const t of model.tiles) {
    if (!t.resource) continue;
    const kind = t.resourceType ?? "Bonus";
    const arr = resGroups.get(kind) ?? [];
    // offset marker to top-left of tile so it doesn't collide with units
    arr.push({ x: t.world.x - 0.45, y: t.world.y + 0.45 });
    resGroups.set(kind, arr);
  }
  for (const [kind, centers] of resGroups) {
    const color = new THREE.Color(resSpecs[kind]?.markerColor ?? "#cccccc");
    const geo = new THREE.CircleGeometry(0.16, 12);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color }), centers.length);
    const m = new THREE.Matrix4();
    centers.forEach((c, i) => mesh.setMatrixAt(i, m.makeTranslation(c.x, c.y, 0.07)));
    scene.add(mesh);
  }

  // ——— units ———
  const unitTexCache = new Map<string, THREE.Texture>();
  for (const u of model.units) {
    const colors = model.civColors.get(u.civ)!;
    const cacheKey = `${u.civ}|${u.name}|${u.military}`;
    let tex = unitTexCache.get(cacheKey);
    if (!tex) {
      tex = unitTexture(u.name.slice(0, 1).toUpperCase(), colors, u.military);
      unitTexCache.set(cacheKey, tex);
    }
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, depthTest: false }),
    );
    sprite.position.set(u.world.x + (u.military ? -0.25 : 0.3), u.world.y - 0.15, 0.5);
    sprite.scale.set(0.85, 0.85, 1);
    scene.add(sprite);
  }

  // ——— cities (drawn last, on top) ———
  for (const c of model.cities) {
    const colors = model.civColors.get(c.civ)!;
    const tex = cityBannerTexture(c.name, c.population, colors);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sprite.position.set(c.world.x, c.world.y + 0.55, 0.6);
    sprite.scale.set(4.6, 1.44, 1);
    scene.add(sprite);
  }

  const center = {
    x: (model.bounds.minX + model.bounds.maxX) / 2,
    y: (model.bounds.minY + model.bounds.maxY) / 2,
  };
  const radius = Math.max(
    model.bounds.maxX - model.bounds.minX,
    model.bounds.maxY - model.bounds.minY,
  ) / 2;
  return { scene, center, radius };
}
