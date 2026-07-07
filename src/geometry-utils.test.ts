import { describe, expect, it } from "vitest";

import { signedRingArea, utmEpsgFromVertexMean } from "./geometry-utils.js";

describe("signedRingArea", () => {
  it("returns the positive area for a counter-clockwise ring", () => {
    // 2 x 3 rectangle wound CCW → +6 (shoelace, area is exact).
    const ccw = [
      [0, 0],
      [2, 0],
      [2, 3],
      [0, 3],
      [0, 0],
    ];
    expect(signedRingArea(ccw)).toBe(6);
  });

  it("returns the negated area for the same ring wound clockwise", () => {
    // Same rectangle, reversed winding → −6. Pins the sign and rules out the
    // `sum -=` and `sum * 2` mutants (which give +6 and 24 respectively).
    const cw = [
      [0, 0],
      [0, 3],
      [2, 3],
      [2, 0],
      [0, 0],
    ];
    expect(signedRingArea(cw)).toBe(-6);
  });

  it("computes a triangle's signed area exactly", () => {
    const tri = [
      [0, 0],
      [4, 0],
      [0, 2],
      [0, 0],
    ];
    expect(signedRingArea(tri)).toBe(4);
  });
});

describe("utmEpsgFromVertexMean", () => {
  it("selects the northern UTM zone from the coordinate mean", () => {
    // Mean lon −88.5 (zone 16), lat +40.5 (north) → EPSG 32616.
    const points = [
      [-89, 40],
      [-88, 40],
      [-89, 41],
      [-88, 41],
    ];
    expect(utmEpsgFromVertexMean(points)).toBe(32_616);
  });

  it("selects the southern UTM zone when the latitude mean is negative", () => {
    // Mean lon −58.5 (zone 21), lat −34.5 (south) → EPSG 32721. A `latSum -=`
    // mutant would flip the hemisphere to 32621, and a wrong longitude sum
    // would land in a different zone — both change the result here.
    const points = [
      [-59, -35],
      [-58, -34],
    ];
    expect(utmEpsgFromVertexMean(points)).toBe(32_721);
  });
});
