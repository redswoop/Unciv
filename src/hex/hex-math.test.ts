import { describe, expect, test } from "bun:test";
import {
  getColumn,
  getDistance,
  getLatitude,
  getLongitude,
  getNumberOfTilesInHexagon,
  getRow,
  getTileCoordsFromColumnRow,
  getUnwrappedNearestTo,
  hex2WorldCoords,
  hexCornerVectors,
  hexFromLatLong,
  roundHexCoords,
  world2HexCoords,
  getClockPositionToHexcoord,
  NEIGHBOR_CLOCK_POSITIONS,
} from "./hex-math";

const SQRT3 = Math.sqrt(3);

describe("hex2WorldCoords (the spine of the POC)", () => {
  test("origin maps to origin", () => {
    expect(hex2WorldCoords({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  test("matches the closed form: ( 1.5*(y-x), sqrt(3)/2*(x+y) )", () => {
    for (const [x, y] of [[1, 0], [0, 1], [1, 1], [-3, 2], [57, -57], [-17, -40]]) {
      const w = hex2WorldCoords({ x: x!, y: y! });
      expect(w.x).toBeCloseTo(1.5 * (y! - x!), 10);
      expect(w.y).toBeCloseTo((SQRT3 / 2) * (x! + y!), 10);
    }
  });

  test("(1,1) is straight up at distance sqrt(3)", () => {
    const w = hex2WorldCoords({ x: 1, y: 1 });
    expect(w.x).toBeCloseTo(0, 10);
    expect(w.y).toBeCloseTo(SQRT3, 10);
  });

  test("all six neighbours are exactly sqrt(3) away", () => {
    for (const clock of NEIGHBOR_CLOCK_POSITIONS) {
      const n = getClockPositionToHexcoord(clock);
      const w = hex2WorldCoords(n);
      expect(Math.hypot(w.x, w.y)).toBeCloseTo(SQRT3, 10);
    }
  });

  test("world2HexCoords inverts hex2WorldCoords", () => {
    for (const [x, y] of [[0, 0], [5, -3], [-40, -17], [23, 57]]) {
      const w = hex2WorldCoords({ x: x!, y: y! });
      const h = world2HexCoords(w);
      expect(h.x).toBeCloseTo(x!, 8);
      expect(h.y).toBeCloseTo(y!, 8);
    }
  });
});

describe("lat/long", () => {
  test("round-trips through hexFromLatLong", () => {
    for (const [x, y] of [[0, 0], [3, -2], [-7, -7], [12, 5]]) {
      const lat = getLatitude({ x: x!, y: y! });
      const long = getLongitude({ x: x!, y: y! });
      expect(hexFromLatLong(lat, long)).toEqual({ x: x!, y: y! });
    }
  });
});

describe("column/row", () => {
  // Faithful-port note: Unciv's own getRow (Kotlin Int division, truncates
  // toward zero) + getTileCoordsFromColumnRow (twoRows += 1) only round-trip
  // when latitude x+y is even or positive — the original has the same quirk
  // for negative odd latitudes. We pin the original's behavior, not an
  // idealized one.
  test("round-trips where the original round-trips (even or positive latitude)", () => {
    for (let x = -5; x <= 5; x++) {
      for (let y = -5; y <= 5; y++) {
        const lat = x + y;
        if (lat % 2 !== 0 && lat < 0) continue;
        const col = getColumn({ x, y });
        const row = getRow({ x, y });
        expect(getTileCoordsFromColumnRow(col, row)).toEqual({ x, y });
      }
    }
  });

  test("negative odd latitude reproduces the original's off-by-one (quirk pin)", () => {
    // Kotlin: getRow(-5,-4) = -9/2 = -4; recovery lands on (-4,-3), not (-5,-4)
    const col = getColumn({ x: -5, y: -4 });
    const row = getRow({ x: -5, y: -4 });
    expect(getTileCoordsFromColumnRow(col, row)).toEqual({ x: -4, y: -3 });
  });
});

describe("roundHexCoords", () => {
  test("integers are fixed points", () => {
    expect(roundHexCoords({ x: 3, y: -2 })).toEqual({ x: 3, y: -2 });
  });
  test("small perturbations round back", () => {
    expect(roundHexCoords({ x: 3.1, y: -2.05 })).toEqual({ x: 3, y: -2 });
  });
});

describe("getDistance", () => {
  test("same-sign deltas use Chebyshev, opposite-sign use Manhattan", () => {
    expect(getDistance({ x: 0, y: 0 }, { x: 3, y: 2 })).toBe(3);
    expect(getDistance({ x: 0, y: 0 }, { x: -1, y: 2 })).toBe(3);
    expect(getDistance({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(0);
  });
  test("all clock neighbours are distance 1", () => {
    for (const clock of NEIGHBOR_CLOCK_POSITIONS) {
      expect(getDistance({ x: 0, y: 0 }, getClockPositionToHexcoord(clock))).toBe(1);
    }
  });
});

describe("getNumberOfTilesInHexagon", () => {
  test("known values", () => {
    expect(getNumberOfTilesInHexagon(0)).toBe(1);
    expect(getNumberOfTilesInHexagon(1)).toBe(7);
    expect(getNumberOfTilesInHexagon(2)).toBe(19);
    expect(getNumberOfTilesInHexagon(57)).toBe(1 + (6 * 57 * 58) / 2);
  });
});

describe("getUnwrappedNearestTo", () => {
  test("no-op when already nearest", () => {
    const r = getUnwrappedNearestTo({ x: 1, y: 0 }, { x: 0, y: 0 }, 50);
    expect(r.x).toBeCloseTo(1);
    expect(r.y).toBeCloseTo(0);
  });
});

describe("hexCornerVectors", () => {
  test("six corners at radius 1, adjacent corners sqrt(3)-ish apart... no: side length 1", () => {
    const corners = hexCornerVectors();
    expect(corners).toHaveLength(6);
    for (const c of corners) {
      expect(Math.hypot(c.x, c.y)).toBeCloseTo(1, 10);
    }
    // regular unit hexagon: side length equals circumradius (= 1)
    for (let i = 0; i < 6; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % 6]!;
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(1, 10);
    }
  });

  test("corner midpoints face neighbour directions — perfect tessellation", () => {
    // midpoint of edge i must be exactly half of the neighbour center vector
    const corners = hexCornerVectors();
    for (let i = 0; i < 6; i++) {
      const clock = NEIGHBOR_CLOCK_POSITIONS[i]!;
      const neighborCenter = hex2WorldCoords(getClockPositionToHexcoord(clock));
      const a = corners[i]!;
      const b = corners[(i + 1) % 6]!;
      expect((a.x + b.x) / 2).toBeCloseTo(neighborCenter.x / 2, 10);
      expect((a.y + b.y) / 2).toBeCloseTo(neighborCenter.y / 2, 10);
    }
  });
});
