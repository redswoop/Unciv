/**
 * three.js scene construction from a BoardModel + asset map.
 *
 * Draw strategy (9919 tiles must be cheap):
 *  - Base terrain: ONE merged BufferGeometry per texture group, with
 *    world-space UVs so same-terrain neighbours read as continuous painted
 *    ground (the single biggest "Civ5 not spreadsheet" trick).
 *  - Relief: each hex is a subdivided dome (RINGS rings) sampled from the
 *    board-model heightfield (welded corners + nonlinear center falloff) so
 *    hills roll and massifs merge instead of reading as 6-tri tents.
 *  - Feature overlays: same subdivided mesh, draped with a small z lift.
 *  - Rivers/roads/borders: merged quad-strips draped on the relief.
 *  - Cities/units: THREE.Sprite billboards with canvas-drawn textures.
 */

import * as THREE from "three";
import { hexCornerVectors, type Vec2 } from "../hex/hex-math";
import {
  heightAtLocal,
  type BoardModel,
  type CivColors,
  type EdgeSegment,
  type RenderTile,
} from "./board-model";
import {
  civ5AssetsAvailable,
  Civ5TileKit,
  TILE_DIVS_FULLMAP,
  type Civ5TileSpec,
} from "./civ5-tiles";
import assetMap from "./asset-map.json";

/**
 * World units → texture repeats. ~0.42 ≈ one Artful digimap across ~2.4 hexes
 * (hex diameter ~2); old 0.18 stretched a whole texture over ~5.5 units and
 * read muddy/wrong at close zoom.
 */
const WORLD_UV_SCALE = 0.42;
const LIFT = 0.02; // z offset between stacked layers on the same tile
/** Subdivision rings per hex (3 → 1+6+12+18 = 37 verts, ~54 tris). */
const HEX_RINGS = 3;
/** Snow tint begins above this world-z on land. */
const SNOW_LINE = 0.5;

interface AssetEntry {
  texture?: string;
  z?: number;
}

function rgb(c: [number, number, number]): THREE.Color {
  return new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255);
}

// ——————————————————— geometry helpers ———————————————————

/**
 * Merged subdivided-hex geometry over tiles, displaced by the smooth
 * heightfield. Each of the 6 center→corner→corner sectors is a triangular
 * grid of `divs` subdivisions (divs=3 → 9 tris/sector → 54 tris/tile).
 * `overlap` scales past true edges to seal AA cracks between texture groups.
 * World-space UVs. Optional vertex colors add snowcaps above SNOW_LINE.
 */
function hexFanGeometry(
  tiles: readonly RenderTile[],
  corners: Vec2[],
  zBase: number,
  overlap = 1,
  opts: { vertexColors?: boolean; divs?: number } = {},
): THREE.BufferGeometry {
  const divs = opts.divs ?? HEX_RINGS;
  const useColor = opts.vertexColors ?? false;
  // each sector: divs^2 small tris (standard triangle subdivision)
  const tPer = 6 * divs * divs;
  const positions = new Float32Array(tiles.length * tPer * 9);
  const uvs = new Float32Array(tiles.length * tPer * 6);
  const colors = useColor ? new Float32Array(tiles.length * tPer * 9) : null;
  let p = 0;
  let u = 0;
  let col = 0;

  const push = (x: number, y: number, z: number) => {
    positions[p++] = x;
    positions[p++] = y;
    positions[p++] = z + zBase;
    uvs[u++] = x * WORLD_UV_SCALE;
    uvs[u++] = y * WORLD_UV_SCALE;
    if (colors) {
      let cr = 1;
      let cg = 1;
      let cb = 1;
      if (z > SNOW_LINE) {
        const s = Math.min(1, (z - SNOW_LINE) / 0.22);
        cr = 1 * (1 - s) + 0.95 * s;
        cg = 1 * (1 - s) + 0.97 * s;
        cb = 1 * (1 - s) + 1.0 * s;
      } else if (z < 0.02) {
        cr = 0.96;
        cg = 0.98;
        cb = 1.0;
      }
      colors[col++] = cr;
      colors[col++] = cg;
      colors[col++] = cb;
    }
  };

  /** Local offset → world sample (undo overlap so heights stay seamless). */
  const sample = (t: RenderTile, lx: number, ly: number): number =>
    heightAtLocal(t.height, t.cornerHeights, corners, {
      x: lx / overlap,
      y: ly / overlap,
    });

  for (const t of tiles) {
    const cx = t.world.x;
    const cy = t.world.y;
    for (let s = 0; s < 6; s++) {
      const a = corners[s]!;
      const b = corners[(s + 1) % 6]!;
      // sector corners in local (overlapped) space
      const ax = a.x * overlap;
      const ay = a.y * overlap;
      const bx = b.x * overlap;
      const by = b.y * overlap;

      // Point on the subdivided triangle: (i,j) with i+j <= divs
      // barycentric: w0=(divs-i-j)/divs, wa=i/divs, wb=j/divs → local = wa*A + wb*B
      const point = (i: number, j: number): [number, number, number] => {
        const lx = (i * ax + j * bx) / divs;
        const ly = (i * ay + j * by) / divs;
        return [cx + lx, cy + ly, sample(t, lx, ly)];
      };

      for (let i = 0; i < divs; i++) {
        for (let j = 0; j < divs - i; j++) {
          // upright tri: (i,j) (i+1,j) (i,j+1) — wind CCW from +Z
          // corners clockwise → emit (i,j)→(i,j+1)→(i+1,j) = center-ish → B-dir → A-dir
          {
            const [x0, y0, z0] = point(i, j);
            const [x1, y1, z1] = point(i, j + 1);
            const [x2, y2, z2] = point(i + 1, j);
            push(x0, y0, z0);
            push(x1, y1, z1);
            push(x2, y2, z2);
          }
          // inverted tri when it fits: (i+1,j) (i,j+1) (i+1,j+1)
          if (j + 1 <= divs - i - 1) {
            const [x0, y0, z0] = point(i + 1, j);
            const [x1, y1, z1] = point(i, j + 1);
            const [x2, y2, z2] = point(i + 1, j + 1);
            push(x0, y0, z0);
            push(x1, y1, z1);
            push(x2, y2, z2);
          }
        }
      }
    }
  }

  // trim to actual fill (inverted-tri condition means we may have over-allocated)
  // Count: per sector, upright = divs*(divs+1)/2, inverted = divs*(divs-1)/2, total = divs^2
  // Our loops emit exactly divs^2 per sector — allocation is exact.

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  if (colors) geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Merged quads along edge segments (rivers, borders), draped on relief. */
function segmentQuadGeometry(
  segments: EdgeSegment[],
  width: number,
  zBase: number,
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
    const za = s.za + zBase;
    const zb = s.zb + zBase;
    const quad: [number, number, number][] = [
      [s.a.x, s.a.y, za],
      [s.b.x, s.b.y, zb],
      [s.b.x + nx * width, s.b.y + ny * width, zb],
      [s.a.x, s.a.y, za],
      [s.b.x + nx * width, s.b.y + ny * width, zb],
      [s.a.x + nx * width, s.a.y + ny * width, za],
    ];
    for (const [x, y, z] of quad) {
      positions[p++] = x;
      positions[p++] = y;
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
  /** true when Firaxis digimaps + piece heights were used for terrain */
  civ5Terrain: boolean;
}

export async function buildScene(
  model: BoardModel,
  /** Embedded builds map texture file names to data URIs; default fetches from public/. */
  resolveTexture: (file: string) => string = (file) => assetMap.pack.textureRoot + file,
): Promise<BuiltScene> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1626); // deep sea void beyond map edge
  const corners = hexCornerVectors();
  const loader = new THREE.TextureLoader();

  // ——— lighting: Civ5-ish warm key + cool sky fill (low ambient so relief sculpts) ———
  scene.add(new THREE.AmbientLight(0xc8d4e4, 0.22));
  const hemi = new THREE.HemisphereLight(0xb8ccea, 0x5c4e32, 0.45);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe8c8, 1.75);
  sun.position.set(0.85, -0.7, 0.55).normalize();
  scene.add(sun);

  const loadTex = (file: string): THREE.Texture => {
    const tex = loader.load(resolveTexture(file));
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  };

  // ——— terrain: prefer Firaxis digimaps + piece heightmaps when extracted ———
  const useCiv5 = await civ5AssetsAvailable();
  if (useCiv5) {
    const kit = new Civ5TileKit();
    await kit.init();
    const specs: Civ5TileSpec[] = model.tiles.map((t) => ({
      world: t.world,
      baseTerrain: t.baseTerrain,
      features: t.features,
      key: t.key,
      // welded low-freq relief so hills/mountains merge; piece heights add detail
      height: t.height,
      cornerHeights: t.cornerHeights,
    }));
    const terrain = await kit.buildTerrainMesh(specs, {
      divs: TILE_DIVS_FULLMAP,
      foliage: "full",
    });
    scene.add(terrain);
  } else {
    // Artful / procedural fallback (embedded build, or pre-extract)
    const baseMap = assetMap.baseTerrain as Record<string, AssetEntry>;
    const groups = new Map<string, { tiles: RenderTile[]; tint?: [number, number, number] }>();
    for (const tile of model.tiles) {
      const entry = baseMap[tile.baseTerrain] ?? baseMap["*"]!;
      const key = entry.texture!;
      const g = groups.get(key) ?? { tiles: [] };
      g.tiles.push(tile);
      if (!baseMap[tile.baseTerrain]) g.tint = tile.terrainRGB;
      groups.set(key, g);
    }
    let groupIndex = 0;
    for (const [texFile, group] of groups) {
      const geo = hexFanGeometry(group.tiles, corners, groupIndex * 0.0004, 1.03, {
        vertexColors: true,
      });
      const mat = new THREE.MeshLambertMaterial({
        map: loadTex(texFile),
        vertexColors: true,
      });
      if (group.tint) mat.color = rgb(group.tint);
      scene.add(new THREE.Mesh(geo, mat));
      groupIndex++;
    }

    // Artful feature blobs (skip when Civ5 kit owns forest/jungle/hill look)
    const featMap = assetMap.features as Record<string, AssetEntry>;
    const featGroups = new Map<string, RenderTile[]>();
    for (const tile of model.tiles) {
      for (const f of tile.features) {
        const entry = featMap[f];
        if (!entry?.texture) continue;
        const arr = featGroups.get(f) ?? [];
        arr.push(tile);
        featGroups.set(f, arr);
      }
    }
    for (const [feature, tiles] of featGroups) {
      const entry = featMap[feature]!;
      const z = LIFT + (entry.z ?? 1) * 0.004;
      const geo = hexFanGeometry(tiles, corners, z, 1, { vertexColors: false });
      const mat = new THREE.MeshLambertMaterial({
        map: loadTex(entry.texture!),
        transparent: true,
        depthWrite: false,
      });
      scene.add(new THREE.Mesh(geo, mat));
    }
  }

  // ——— rivers ———
  if (model.rivers.length > 0) {
    const geo = segmentQuadGeometry(model.rivers, assetMap.rivers.width, LIFT * 2.4);
    scene.add(
      new THREE.Mesh(geo, flatMaterial({ color: new THREE.Color(assetMap.rivers.color) })),
    );
  }

  // ——— roads ———
  for (const kind of ["Road", "Railroad"] as const) {
    const segs = model.roads.filter((r) => r.kind === kind);
    if (segs.length === 0) continue;
    const spec = assetMap.roads[kind];
    const geo = segmentQuadGeometry(
      segs.map((r) => ({ a: r.from, b: r.to, za: r.zFrom, zb: r.zTo })),
      spec.width,
      LIFT * 2.6,
    );
    scene.add(new THREE.Mesh(geo, flatMaterial({ color: new THREE.Color(spec.color) })));
  }

  // ——— territory fill + borders ———
  const byCiv = new Map<string, RenderTile[]>();
  for (const tile of model.tiles) {
    if (!tile.owner) continue;
    const arr = byCiv.get(tile.owner) ?? [];
    arr.push(tile);
    byCiv.set(tile.owner, arr);
  }
  for (const [civ, tiles] of byCiv) {
    const colors = model.civColors.get(civ)!;
    // low-div territory wash — cheap translucent tint (quieter over digimaps)
    const geo = hexFanGeometry(tiles, corners, LIFT * 3, 1, { divs: 1, vertexColors: false });
    scene.add(
      new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: rgb(colors.outer),
          transparent: true,
          opacity: useCiv5 ? 0.08 : 0.12,
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
    const geo = segmentQuadGeometry(segs, assetMap.borders.width, LIFT * 3.2, centers);
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
    sprite.position.set(t.world.x, t.world.y, t.height + 0.4);
    sprite.scale.set(0.9, 0.9, 1);
    scene.add(sprite);
  }

  // ——— resource / improvement markers (small, subtle) ———
  const resSpecs = assetMap.resources as Record<string, { markerColor: string }>;
  const resGroups = new Map<string, { x: number; y: number; z: number }[]>();
  for (const t of model.tiles) {
    if (!t.resource) continue;
    const kind = t.resourceType ?? "Bonus";
    const arr = resGroups.get(kind) ?? [];
    // offset marker to top-left of tile so it doesn't collide with units
    arr.push({ x: t.world.x - 0.45, y: t.world.y + 0.45, z: t.height + LIFT * 3 });
    resGroups.set(kind, arr);
  }
  for (const [kind, centers] of resGroups) {
    const color = new THREE.Color(resSpecs[kind]?.markerColor ?? "#cccccc");
    const geo = new THREE.CircleGeometry(0.16, 12);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color }), centers.length);
    const m = new THREE.Matrix4();
    centers.forEach((c, i) => mesh.setMatrixAt(i, m.makeTranslation(c.x, c.y, c.z)));
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
    sprite.position.set(u.world.x + (u.military ? -0.25 : 0.3), u.world.y - 0.15, u.z + 0.5);
    sprite.scale.set(0.85, 0.85, 1);
    scene.add(sprite);
  }

  // ——— cities (drawn last, on top) ———
  for (const c of model.cities) {
    const colors = model.civColors.get(c.civ)!;
    const tex = cityBannerTexture(c.name, c.population, colors);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sprite.position.set(c.world.x, c.world.y + 0.55, c.z + 0.6);
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
  return { scene, center, radius, civ5Terrain: useCiv5 };
}
