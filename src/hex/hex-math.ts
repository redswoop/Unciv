/**
 * 1:1 port of Unciv's HexMath.kt (core/src/com/unciv/logic/map/HexMath.kt).
 *
 * DO NOT "improve" this file with redblob-style axial/offset conversions —
 * Unciv has its own hex coordinate scheme and this port mirrors it exactly:
 *
 *   HexCoords are an (x, y) vector where x is the vector to the top-LEFT
 *   neighbour (10 o'clock) and y to the top-RIGHT neighbour (2 o'clock).
 *   (1,1) is straight up. Latitude = x + y, longitude = x - y.
 *
 * World coords use +Y up (as in libGDX). The tile circumradius is 1, so
 * neighbouring centers are sqrt(3) apart and hex CORNERS sit at clock hours
 * 1, 3, 5, 7, 9, 11 (edges face the six neighbour directions 12..10).
 */

export interface Vec2 {
  x: number;
  y: number;
}

const SQRT3 = Math.sqrt(3);

export function getVectorForAngle(angle: number): Vec2 {
  return { x: Math.sin(angle), y: Math.cos(angle) };
}

function getVectorByClockHour(hour: number): Vec2 {
  return getVectorForAngle(2 * Math.PI * (hour / 12));
}

/** Number of tiles in a hexagonal map of the given radius, incl. origin. */
export function getNumberOfTilesInHexagon(size: number): number {
  if (size < 0) return 0;
  return 1 + (6 * size * (size + 1)) / 2;
}

/** Fractional hexagon radius that would hold an area of numberOfTiles. */
export function getHexagonalRadiusForArea(numberOfTiles: number): number {
  return numberOfTiles < 1 ? 0 : (Math.sqrt(12 * numberOfTiles - 3) - 3) / 6;
}

export function getLatitude(v: Vec2): number {
  return v.x + v.y;
}

export function getLongitude(v: Vec2): number {
  return v.x - v.y;
}

/** Inverse of getLatitude/getLongitude. */
export function hexFromLatLong(latitude: number, longitude: number): Vec2 {
  const y = (latitude - longitude) / 2;
  const x = longitude + y;
  return { x, y };
}

/** Hex-space position -> world position; tile circumradius = 1. */
export function hex2WorldCoords(hexCoord: Vec2): Vec2 {
  // Distance between cells = 2 * normal of triangle = sqrt(3)
  const xVector = getVectorByClockHour(10);
  const yVector = getVectorByClockHour(2);
  return {
    x: SQRT3 * hexCoord.x * xVector.x + SQRT3 * hexCoord.y * yVector.x,
    y: SQRT3 * hexCoord.x * xVector.y + SQRT3 * hexCoord.y * yVector.y,
  };
}

/** World position -> fractional hex coords (pass through roundHexCoords). */
export function world2HexCoords(worldCoord: Vec2): Vec2 {
  // D: diagonal, A: antidiagonal versors
  const D = getVectorByClockHour(10);
  D.x *= SQRT3;
  D.y *= SQRT3;
  const A = getVectorByClockHour(2);
  A.x *= SQRT3;
  A.y *= SQRT3;
  const den = D.x * A.y - D.y * A.x;
  return {
    x: (worldCoord.x * A.y - worldCoord.y * A.x) / den,
    y: (worldCoord.y * D.x - worldCoord.x * D.y) / den,
  };
}

// Both x (10 o'clock) and y (2 o'clock) increase the row by 0.5
export function getRow(v: Vec2): number {
  return Math.trunc((v.x + v.y) / 2);
}

// y (2 o'clock) increases column by 1, x (10 o'clock) decreases it by 1
export function getColumn(v: Vec2): number {
  return v.y - v.x;
}

export function getTileCoordsFromColumnRow(column: number, row: number): Vec2 {
  let twoRows = row * 2;
  if (Math.abs(column) % 2 === 1) twoRows += 1;
  return { x: (twoRows - column) / 2, y: (twoRows + column) / 2 };
}

export function roundHexCoords(hexCoord: Vec2): Vec2 {
  // cubic magic, straight from the Kotlin
  const cubic = {
    x: hexCoord.y - hexCoord.x,
    y: hexCoord.x,
    z: -hexCoord.y,
  };
  let rx = Math.round(cubic.x);
  let ry = Math.round(cubic.y);
  let rz = Math.round(cubic.z);
  const dx = Math.abs(rx - cubic.x);
  const dy = Math.abs(ry - cubic.y);
  const dz = Math.abs(rz - cubic.z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { x: ry, y: -rz };
}

/** Hex distance between two tile positions (no world-wrap). */
export function getDistance(origin: Vec2, destination: Vec2): number {
  const relativeX = origin.x - destination.x;
  const relativeY = origin.y - destination.y;
  return relativeX * relativeY >= 0
    ? Math.max(Math.abs(relativeX), Math.abs(relativeY))
    : Math.abs(relativeX) + Math.abs(relativeY);
}

/**
 * Closest equivalent of unwrapHexCoord to staticHexCoord on a world-wrapped
 * map. May not be a valid tile coordinate — it is a *drawing* position.
 */
export function getUnwrappedNearestTo(
  unwrapHexCoord: Vec2,
  staticHexCoord: Vec2,
  longitudinalRadius: number,
): Vec2 {
  const referenceLong = getLongitude(staticHexCoord);
  const toWrapLat = getLatitude(unwrapHexCoord);
  const toWrapLong = getLongitude(unwrapHexCoord);
  const mod = (a: number, n: number) => ((a % n) + n) % n; // Kotlin .mod()
  return hexFromLatLong(
    toWrapLat,
    mod(toWrapLong - referenceLong + longitudinalRadius, longitudinalRadius * 2) -
      longitudinalRadius +
      referenceLong,
  );
}

/** Hex-space offset of the neighbour in the given clock direction. */
const CLOCK_TO_HEX: ReadonlyMap<number, Vec2> = new Map([
  [0, { x: 1, y: 1 }],
  [12, { x: 1, y: 1 }],
  [2, { x: 0, y: 1 }],
  [4, { x: -1, y: 0 }],
  [6, { x: -1, y: -1 }],
  [8, { x: 0, y: -1 }],
  [10, { x: 1, y: 0 }],
]);

export function getClockPositionToHexcoord(clockPosition: number): Vec2 {
  return CLOCK_TO_HEX.get(clockPosition) ?? { x: 0, y: 0 };
}

/**
 * World/screen-space vector for a clock direction, for border/road/river
 * drawing. NOTE: mirrors the Kotlin oddity — entry N is the world vector of
 * the hex-space offset that lies at clock position (N+6), i.e. entry 2 points
 * toward 8 o'clock. Ported verbatim; use with the same semantics TileGroup does.
 */
const CLOCK_TO_WORLD: ReadonlyMap<number, Vec2> = new Map([
  [2, hex2WorldCoords({ x: 0, y: -1 })],
  [4, hex2WorldCoords({ x: 1, y: 0 })],
  [6, hex2WorldCoords({ x: 1, y: 1 })],
  [8, hex2WorldCoords({ x: 0, y: 1 })],
  [10, hex2WorldCoords({ x: -1, y: 0 })],
  [12, hex2WorldCoords({ x: -1, y: -1 })],
]);

export function getClockPositionToWorldVector(clockPosition: number): Vec2 {
  return CLOCK_TO_WORLD.get(clockPosition) ?? { x: 0, y: 0 };
}

/** All six neighbour clock directions, in drawing order. */
export const NEIGHBOR_CLOCK_POSITIONS = [12, 2, 4, 6, 8, 10] as const;

/**
 * Corner positions of the unit hex (circumradius 1) centred at the origin.
 * Corners at clock hours 1,3,5,7,9,11 so that edges face the six neighbour
 * directions of Unciv's scheme. Order matters: corner[i] and corner[i+1]
 * bound the edge facing NEIGHBOR_CLOCK_POSITIONS[i].
 */
export function hexCornerVectors(): Vec2[] {
  return [11, 1, 3, 5, 7, 9].map((hour) => getVectorByClockHour(hour));
}
