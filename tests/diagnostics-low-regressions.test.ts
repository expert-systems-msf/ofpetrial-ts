// Regression tests for the LOW diagnostics audit findings (L1-L4), each
// reproduced against the public API.
import { describe, expect, it } from "vitest";
import type { Feature, FeatureCollection, Point, Polygon } from "geojson";
import { checkOrthoInputs, checkOrthoWithChars, spatialJoin } from "../src/diagnostics.js";
import { ValidationError } from "../src/types.js";
import type { SoilFragment, TrialDesign } from "../src/types.js";

/** Minimal stub TrialDesign with `n` inputs (enough for the guards under test). */
function stubTd(inputNames: string[]): TrialDesign {
  return {
    inputs: inputNames.map((name) => ({
      plotInfo: { input_name: name } as never,
      rateInfo: null,
      plots: { type: "FeatureCollection", features: [] },
      headlands: { type: "FeatureCollection", features: [] },
      abLine: {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: [] },
      },
      guidanceLines: { type: "FeatureCollection", features: [] },
    })),
    seed: 0,
  };
}

const squarePolygon: Feature<Polygon> = {
  type: "Feature",
  properties: { type: "experiment", strip_id: 1, plot_id: 1, rate: 100 },
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [0, 10],
        [10, 10],
        [10, 0],
        [0, 0],
      ],
    ],
  },
};
const design: FeatureCollection = { type: "FeatureCollection", features: [squarePolygon] };

describe("checkOrthoInputs — L1: no silent NaN", () => {
  it("throws on an empty fragment table instead of returning NaN", () => {
    expect(() => checkOrthoInputs(stubTd(["a", "b"]), [])).toThrow(ValidationError);
  });

  it("throws when a fragment carries a non-finite rate", () => {
    const fragments = [
      { rate_1: 100, rate_2: NaN, area: 50 },
      { rate_1: 120, rate_2: NaN, area: 50 },
    ] as never;
    expect(() => checkOrthoInputs(stubTd(["a", "b"]), fragments)).toThrow(ValidationError);
  });
});

describe("spatialJoin — L3: non-homogeneous soil layers do not crash", () => {
  const pointFeature: Feature<Point> = {
    type: "Feature",
    properties: { soil: "clay" },
    geometry: { type: "Point", coordinates: [5, 5] },
  };
  const polygonSoil: Feature<Polygon> = {
    type: "Feature",
    properties: { soil: "silt" },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [0, 10],
          [10, 10],
          [10, 0],
          [0, 0],
        ],
      ],
    },
  };
  const nullGeomPoint = {
    type: "Feature",
    properties: { soil: "loam" },
    geometry: null,
  } as unknown as Feature;

  it("does not throw on a mixed Point + Polygon layer", () => {
    const soil: FeatureCollection = {
      type: "FeatureCollection",
      features: [polygonSoil, pointFeature],
    };
    expect(() => spatialJoin(design, soil)).not.toThrow();
  });

  it("does not throw on a Point layer containing a null-geometry feature (ogr2ogr output)", () => {
    const soil: FeatureCollection = {
      type: "FeatureCollection",
      features: [pointFeature, nullGeomPoint],
    };
    expect(() => spatialJoin(design, soil)).not.toThrow();
    // the real point still joins
    const frags = spatialJoin(design, soil);
    expect(frags.length).toBe(1);
    expect(frags[0]!.values.soil).toBe("clay");
  });
});

describe("checkOrthoWithChars — L2/L4", () => {
  it('L2: a null factor value becomes a single <NA> class, not dropped or named "null"', () => {
    const fragments: SoilFragment[] = [
      { plotKey: "1:1", rate: 10, values: { soil: null as unknown as string } },
      { plotKey: "1:2", rate: 20, values: { soil: "clay" } },
      { plotKey: "1:3", rate: 30, values: { soil: "clay" } },
    ];
    const result = checkOrthoWithChars(stubTd(["seed"]), fragments, ["soil"]);
    const classes = result[0]!.factorSummaries.find((s) => s.var === "soil")!.classes;
    const na = classes.find((c) => c.class === "<NA>");
    expect(na, "null factor value must form an <NA> group").toBeDefined();
    expect(na!.rateMean).toBe(10);
    expect(classes.find((c) => c.class === "null")).toBeUndefined();
  });

  it("L4: a SoilFragment[] table is rejected for a multi-input design", () => {
    const fragments: SoilFragment[] = [{ plotKey: "1:1", rate: 10, values: { clay: 1 } }];
    expect(() => checkOrthoWithChars(stubTd(["seed", "NH3"]), fragments, ["clay"])).toThrow(
      ValidationError
    );
  });
});
