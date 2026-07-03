import { describe, expect, it } from "vitest";
import type { Feature, Polygon } from "geojson";
import { centroidDistanceMeters, overlapRatio, relClose } from "../test-cases-runner/compare.js";

function square(lon: number, lat: number, sizeDeg: number): Feature<Polygon> {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [lon, lat],
          [lon + sizeDeg, lat],
          [lon + sizeDeg, lat + sizeDeg],
          [lon, lat + sizeDeg],
          [lon, lat],
        ],
      ],
    },
  };
}

describe("relClose", () => {
  it("accepts within relative tolerance and rejects outside", () => {
    expect(relClose(1.0000005, 1, 1e-6)).toBe(true);
    expect(relClose(1.000002, 1, 1e-6)).toBe(false);
    // Small expected values fall back to absolute tolerance (max(1, |e|)).
    expect(relClose(1e-9, 0, 1e-6)).toBe(true);
    expect(relClose(-42.0000001, -42, 1e-6)).toBe(true);
  });
});

describe("overlapRatio", () => {
  it("is 1 for identical polygons", () => {
    const a = square(-88.2, 40.1, 0.001);
    expect(overlapRatio(a, a)).toBeCloseTo(1, 6);
  });

  it("is ~0.5 for a half-offset square", () => {
    const r = square(-88.2, 40.1, 0.001);
    const ts = square(-88.2 + 0.0005, 40.1, 0.001);
    expect(overlapRatio(ts, r)).toBeCloseTo(0.5, 3);
  });

  it("is 0 for disjoint polygons", () => {
    const r = square(-88.2, 40.1, 0.001);
    const ts = square(-88, 40.1, 0.001);
    expect(overlapRatio(ts, r)).toBe(0);
  });
});

describe("centroidDistanceMeters", () => {
  it("is ~0 for identical polygons", () => {
    const a = square(-71.2, 46.8, 0.001);
    expect(centroidDistanceMeters(a, a)).toBeLessThan(1e-6);
  });

  it("measures a ~1.11 m shift for 1e-5 degrees of latitude", () => {
    const r = square(-71.2, 46.8, 0.001);
    const ts = square(-71.2, 46.8 + 1e-5, 0.001);
    const d = centroidDistanceMeters(ts, r);
    expect(d).toBeGreaterThan(1);
    expect(d).toBeLessThan(1.2);
  });
});
