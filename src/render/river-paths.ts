/**
 * River geometry: chain per-edge river segments (each tile owns its three
 * bottom hex edges — see board-model RIVER_EDGES) into continuous polylines,
 * then smooth them into natural meanders.
 *
 * Pure math, no three.js — the whole pipeline is testable in bun:test.
 * scene.ts turns the smoothed paths into draped ribbon geometry.
 */

import type { EdgeSegment } from "./board-model";

export interface RiverPoint {
  x: number;
  y: number;
  z: number;
}

export interface RiverPath {
  points: RiverPoint[];
  /** number of raw hex-edge segments chained into this path */
  segmentCount: number;
}

const KEY_SCALE = 1000;

function nodeKey(x: number, y: number): string {
  return `${Math.round(x * KEY_SCALE)},${Math.round(y * KEY_SCALE)}`;
}

interface Node {
  x: number;
  y: number;
  z: number;
  /** indices into the segment list */
  edges: number[];
}

/**
 * Chain edge segments into polylines. Segments meeting at a hex corner join;
 * at Y-junctions (3 river edges share a corner) the straightest continuation
 * wins and the remaining branch starts its own path — main channels flow
 * through, tributaries join visibly, exactly how Civ5 forks read.
 */
export function chainRiverPaths(segments: EdgeSegment[]): RiverPath[] {
  const nodes = new Map<string, Node>();
  const segNodes: [string, string][] = [];
  const used = new Uint8Array(segments.length);

  const addNode = (x: number, y: number, z: number): string => {
    const key = nodeKey(x, y);
    const existing = nodes.get(key);
    if (existing) {
      // duplicate corner from a neighbouring tile — z should already agree
      return key;
    }
    nodes.set(key, { x, y, z, edges: [] });
    return key;
  };

  segments.forEach((s, i) => {
    const ka = addNode(s.a.x, s.a.y, s.za);
    const kb = addNode(s.b.x, s.b.y, s.zb);
    nodes.get(ka)!.edges.push(i);
    nodes.get(kb)!.edges.push(i);
    segNodes.push([ka, kb]);
  });

  const otherEnd = (segIdx: number, from: string): string => {
    const [ka, kb] = segNodes[segIdx]!;
    return ka === from ? kb : ka;
  };

  /** pick the unused edge at `key` that continues straightest from dir (dx,dy) */
  const pickNext = (key: string, dx: number, dy: number): number => {
    const node = nodes.get(key)!;
    let best = -1;
    let bestDot = -Infinity;
    for (const e of node.edges) {
      if (used[e]) continue;
      const to = nodes.get(otherEnd(e, key))!;
      const ex = to.x - node.x;
      const ey = to.y - node.y;
      const len = Math.hypot(ex, ey) || 1;
      const dot = (ex * dx + ey * dy) / len;
      if (dot > bestDot) {
        bestDot = dot;
        best = e;
      }
    }
    return best;
  };

  const walk = (startSeg: number, startKey: string): RiverPath => {
    const points: RiverPoint[] = [];
    let count = 0;
    let key = startKey;
    let seg = startSeg;
    const startNode = nodes.get(key)!;
    points.push({ x: startNode.x, y: startNode.y, z: startNode.z });
    let px = startNode.x;
    let py = startNode.y;
    while (seg >= 0 && !used[seg]) {
      used[seg] = 1;
      count++;
      key = otherEnd(seg, key);
      const n = nodes.get(key)!;
      const dx = n.x - px;
      const dy = n.y - py;
      points.push({ x: n.x, y: n.y, z: n.z });
      px = n.x;
      py = n.y;
      seg = pickNext(key, dx, dy);
    }
    return { points, segmentCount: count };
  };

  const paths: RiverPath[] = [];
  // start at odd-degree nodes (true river ends) first for longest chains
  for (const [key, node] of nodes) {
    if (node.edges.length % 2 === 0) continue;
    for (const e of node.edges) {
      if (!used[e]) paths.push(walk(e, key));
    }
  }
  // leftovers (cycles or fully-even subgraphs)
  segments.forEach((_, i) => {
    if (!used[i]) paths.push(walk(i, segNodes[i]![0]!));
  });
  return paths.filter((p) => p.points.length >= 2);
}

/**
 * Centripetal Catmull-Rom resample: turns the hex-edge zigzag into a smooth
 * meander that still passes through every corner node (so welded z values
 * stay honest). `perSegment` output points per input segment.
 */
export function smoothRiverPath(path: RiverPath, perSegment = 5): RiverPoint[] {
  const pts = path.points;
  if (pts.length < 3) return pts.slice();
  const out: RiverPoint[] = [];

  const get = (i: number): RiverPoint => pts[Math.max(0, Math.min(pts.length - 1, i))]!;

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    for (let s = 0; s < perSegment; s++) {
      const t = s / perSegment;
      // centripetal parameterization avoids loops/overshoot on tight turns
      const t2 = t * t;
      const t3 = t2 * t;
      const c0 = -0.5 * t3 + t2 - 0.5 * t;
      const c1 = 1.5 * t3 - 2.5 * t2 + 1;
      const c2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
      const c3 = 0.5 * t3 - 0.5 * t2;
      out.push({
        x: c0 * p0.x + c1 * p1.x + c2 * p2.x + c3 * p3.x,
        y: c0 * p0.y + c1 * p1.y + c2 * p2.y + c3 * p3.y,
        // z stays linear between the two welded corner heights — catmull in z
        // can overshoot below the seabed or above the bank
        z: p1.z * (1 - t) + p2.z * t,
      });
    }
  }
  out.push({ ...pts[pts.length - 1]! });
  return out;
}

/**
 * River ribbon half-width at parameter u ∈ [0,1] along the path.
 * Slight taper toward both ends + gentle deterministic variation so the
 * channel reads hand-drawn, not extruded.
 */
export function riverWidthAt(u: number, baseWidth: number, pathSeed: number): number {
  const taperIn = Math.min(1, u / 0.12);
  const taperOut = Math.min(1, (1 - u) / 0.12);
  const taper = 0.55 + 0.45 * Math.min(taperIn, taperOut);
  const wobble = 1 + 0.18 * Math.sin(u * 23 + pathSeed) + 0.1 * Math.sin(u * 57 + pathSeed * 2.7);
  return baseWidth * taper * wobble;
}
