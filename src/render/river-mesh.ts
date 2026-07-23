/**
 * River ribbons: smoothed polylines (river-paths.ts) → draped triangle
 * strips with an animated water shader. Two layers per river:
 *   1. bank ribbon — wider, dark wet earth, soft alpha edges (the carved bed)
 *   2. water ribbon — narrower, animated flow + sparkle + edge foam
 * Both sample the rendered terrain height along the path so they lie on the
 * ground like Civ5's carved channels, not float as flat blue elbows.
 */

import * as THREE from "three";
import type { EdgeSegment } from "./board-model";
import { chainRiverPaths, riverWidthAt, smoothRiverPath, type RiverPoint } from "./river-paths";

export type WorldZ = (x: number, y: number) => number;

export interface RiverLayer {
  group: THREE.Group;
  timeUniforms: { value: number }[];
}

interface StripVertex {
  x: number;
  y: number;
  z: number;
  /** u: distance along river (world units), v: 0..1 across width */
  u: number;
  v: number;
}

/**
 * Build strip vertices for one smoothed path.
 * Direction via central differences; joins stay watertight because
 * consecutive quads share the exact same edge vertices.
 */
function stripVertices(
  pts: RiverPoint[],
  halfWidthAt: (u01: number) => number,
  zAt: WorldZ,
  lift: number,
  widthScale: number,
): StripVertex[][] {
  // cumulative arc length for u
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  }
  const total = cum[cum.length - 1]! || 1;

  const rows: StripVertex[][] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const prev = pts[Math.max(0, i - 1)]!;
    const next = pts[Math.min(pts.length - 1, i + 1)]!;
    let dx = next.x - prev.x;
    let dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const nx = -dy;
    const ny = dx;
    const hw = halfWidthAt(cum[i]! / total) * widthScale;
    const mk = (side: number, v: number): StripVertex => {
      const x = p.x + nx * hw * side;
      const y = p.y + ny * hw * side;
      return { x, y, z: zAt(x, y) + lift, u: cum[i]!, v };
    };
    rows.push([mk(-1, 0), mk(0, 0.5), mk(1, 1)]);
  }
  return rows;
}

function stripGeometry(rowsList: StripVertex[][][]): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  for (const rows of rowsList) {
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i]!;
      const b = rows[i + 1]!;
      // two quads per segment (left half, right half) → smooth center crease
      for (let s = 0; s < 2; s++) {
        const quad = [a[s]!, b[s]!, b[s + 1]!, a[s]!, b[s + 1]!, a[s + 1]!];
        for (const q of quad) {
          positions.push(q.x, q.y, q.z);
          uvs.push(q.u, q.v);
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  return geo;
}

/** Base river half-width in world units (hex circumradius = 1). */
const RIVER_HALF_WIDTH = 0.075;

/**
 * Roads / railroads as smoothed draped ribbons (same strip machinery as
 * rivers — road segments chain tile-center to tile-center). Roads read as
 * rutted dirt; railroads as dark gravel with tie dashes along the length.
 */
export function buildRoadLayer(
  segments: EdgeSegment[],
  kind: "Road" | "Railroad",
  zAt: WorldZ,
): THREE.Group {
  const group = new THREE.Group();
  if (segments.length === 0) return group;
  const paths = chainRiverPaths(segments);
  const rows: StripVertex[][][] = [];
  const half = kind === "Railroad" ? 0.055 : 0.06;
  for (const path of paths) {
    const pts = smoothRiverPath(path, 4);
    rows.push(stripVertices(pts, () => half, zAt, 0.016, 1));
  }
  const geo = stripGeometry(rows);
  const mat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader:
      kind === "Railroad"
        ? `
      varying vec2 vUv;
      void main() {
        float edge = 1.0 - abs(vUv.y - 0.5) * 2.0;
        float a = smoothstep(0.0, 0.4, edge) * 0.92;
        // gravel bed
        vec3 c = vec3(0.32, 0.30, 0.27);
        // ties: dashes across the width
        float tie = step(0.62, fract(vUv.x * 9.0)) * step(0.18, edge);
        c = mix(c, vec3(0.23, 0.17, 0.11), tie * 0.9);
        // twin rails: two bright lines along the length
        float railBand = smoothstep(0.04, 0.0, abs(abs(vUv.y - 0.5) - 0.2));
        c = mix(c, vec3(0.62, 0.63, 0.66), railBand * 0.85);
        gl_FragColor = vec4(c, a);
      }
    `
        : `
      varying vec2 vUv;
      void main() {
        float edge = 1.0 - abs(vUv.y - 0.5) * 2.0;
        float a = smoothstep(0.0, 0.5, edge) * 0.82;
        // packed dirt, wheel ruts darker
        vec3 c = vec3(0.52, 0.42, 0.30);
        float rut = smoothstep(0.05, 0.0, abs(abs(vUv.y - 0.5) - 0.16));
        c = mix(c, vec3(0.38, 0.30, 0.21), rut * 0.7);
        // subtle length variation so long roads aren't a flat band
        c *= 0.94 + 0.10 * fract(sin(floor(vUv.x * 3.0) * 12.99) * 43758.55);
        gl_FragColor = vec4(c, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1.4;
  group.add(mesh);
  return group;
}

export function buildRiverLayer(
  rivers: EdgeSegment[],
  zAt: WorldZ,
  bumpsTex: THREE.Texture | null,
): RiverLayer {
  const group = new THREE.Group();
  const timeUniforms: { value: number }[] = [];
  if (rivers.length === 0) return { group, timeUniforms };

  const paths = chainRiverPaths(rivers);
  const bankRows: StripVertex[][][] = [];
  const waterRows: StripVertex[][][] = [];
  paths.forEach((path, idx) => {
    const pts = smoothRiverPath(path, 5);
    const hw = (u01: number) => riverWidthAt(u01, RIVER_HALF_WIDTH, idx * 1.7);
    bankRows.push(stripVertices(pts, hw, zAt, 0.012, 2.0));
    waterRows.push(stripVertices(pts, hw, zAt, 0.02, 1.0));
  });

  // ——— banks: dark wet earth fading out at the edges ———
  {
    const geo = stripGeometry(bankRows);
    const mat = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        void main() {
          float edge = 1.0 - abs(vUv.y - 0.5) * 2.0;   // 1 center → 0 rim
          float a = smoothstep(0.0, 0.55, edge) * 0.55;
          // wet dark earth, slightly greener at the rim
          vec3 c = mix(vec3(0.24, 0.23, 0.16), vec3(0.13, 0.12, 0.08), edge);
          gl_FragColor = vec4(c, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1.5;
    group.add(mesh);
  }

  // ——— water: animated flow, sparkle, edge foam ———
  {
    const geo = stripGeometry(waterRows);
    const uTime = { value: 0 };
    timeUniforms.push(uTime);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        ...(bumpsTex ? { bumpsTex: { value: bumpsTex } } : {}),
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        ${bumpsTex ? "uniform sampler2D bumpsTex;" : ""}
        varying vec2 vUv;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 s = f * f * (3.0 - 2.0 * f);
          float a = hash(i);
          float b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0));
          float d = hash(i + vec2(1.0, 1.0));
          return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
        }

        void main() {
          float edge = 1.0 - abs(vUv.y - 0.5) * 2.0;  // 1 center → 0 rim
          // downstream-flowing ripple field (two octaves, opposing drift)
          vec2 fuv = vec2(vUv.x * 2.6 - uTime * 0.55, vUv.y * 1.4);
          ${
            bumpsTex
              ? `float n1 = texture2D(bumpsTex, fuv * 0.35).g;
          float n2 = texture2D(bumpsTex, vec2(vUv.x * 5.0 - uTime * 0.9, vUv.y * 2.0) * 0.21).g;`
              : `float n1 = noise(fuv);
          float n2 = noise(vec2(vUv.x * 5.0 - uTime * 0.9, vUv.y * 2.0));`
          }
          float flow = n1 * 0.65 + n2 * 0.35;

          // deep center → lighter rim
          vec3 deep = vec3(0.10, 0.23, 0.30);
          vec3 shallow = vec3(0.22, 0.42, 0.47);
          vec3 c = mix(shallow, deep, smoothstep(0.15, 0.85, edge));
          // moving brightness bands read as current
          c += (flow - 0.5) * 0.14;
          // sun sparkle on ripple crests
          float sparkle = smoothstep(0.78, 0.92, flow) * 0.5;
          c += sparkle * vec3(0.9, 0.95, 1.0);
          // white edge foam, animated by the same field
          float foam = smoothstep(0.32, 0.05, edge) * smoothstep(0.45, 0.75, flow + edge * 0.2);
          c = mix(c, vec3(0.85, 0.92, 0.94), foam * 0.7);

          float a = smoothstep(0.0, 0.3, edge) * 0.88;
          gl_FragColor = vec4(c, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1.6;
    group.add(mesh);
  }

  return { group, timeUniforms };
}
