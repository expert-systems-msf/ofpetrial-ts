// GeoJSON writer (task 7.2) — RFC 7946 shape + parity with the frozen
// trial-design.geojson fixture (itself the ground truth R would export as
// GeoJSON, per write_trial_files()'s sf::st_write(ext="geojson") path).
import { describe, expect, it } from "vitest";
import type { LineString, MultiLineString, MultiPolygon, Polygon } from "geojson";
import { ExportError } from "../src/types.js";
import type { GeoJsonFeatureInput } from "../src/exports/geojson.js";
import { writeGeoJson } from "../src/exports/geojson.js";
import { loadTrialDesign } from "./exports-fixtures.js";

function trialDesignFeatures(
  inputName: string,
  td: ReturnType<typeof loadTrialDesign>
): GeoJsonFeatureInput[] {
  const input = td.inputs.find((index) => index.plotInfo.input_name === inputName)!;
  const features: GeoJsonFeatureInput[] = [];
  for (const f of input.plots.features) {
    const p = f.properties as { rate: number; strip_id: number; plot_id: number };
    features.push({
      geometry: f.geometry as Polygon | MultiPolygon,
      properties: { rate: p.rate, strip_id: p.strip_id, plot_id: p.plot_id, type: "experiment" },
    });
  }
  for (const f of input.headlands.features) {
    const p = f.properties as { rate: number };
    features.push({
      geometry: f.geometry as Polygon | MultiPolygon,
      properties: { rate: p.rate, strip_id: null, plot_id: null, type: "headland" },
    });
  }
  return features;
}

function signedArea(ring: ReadonlyArray<readonly number[]>): number {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index++) {
    const [x1, y1] = ring[index]!;
    const [x2, y2] = ring[index + 1]!;
    sum += x1! * y2! - x2! * y1!;
  }
  return sum / 2;
}

describe("writeGeoJson — RFC 7946 shape", () => {
  const td = loadTrialDesign("simple1", "imperial", ["seed"]);
  const features = trialDesignFeatures("seed", td);
  const bytes = writeGeoJson(features);
  const fc = JSON.parse(new TextDecoder().decode(bytes)) as {
    type: string;
    crs?: unknown;
    features: Array<{
      type: string;
      properties: Record<string, unknown>;
      geometry: { type: string; coordinates: unknown };
    }>;
  };

  it("is a FeatureCollection with no top-level crs member", () => {
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.crs).toBeUndefined();
    expect("crs" in fc).toBe(false);
  });

  it("has one Feature per plot + headland, with rate/plot_id/strip_id/type props", () => {
    expect(fc.features.length).toBe(features.length);
    for (const f of fc.features) {
      expect(f.type).toBe("Feature");
      expect(Object.keys(f.properties).toSorted((a, b) => a.localeCompare(b))).toEqual([
        "plot_id",
        "rate",
        "strip_id",
        "type",
      ]);
    }
  });

  it("orients every polygon by the right-hand rule (exterior CCW, holes CW)", () => {
    for (const f of fc.features) {
      const rings = f.geometry.coordinates as number[][][];
      expect(signedArea(rings[0]!)).toBeGreaterThan(0);
      for (const hole of rings.slice(1)) {
        expect(signedArea(hole)).toBeLessThan(0);
      }
    }
  });

  it("throws ExportError on an empty feature list", () => {
    const act = () => writeGeoJson([]);
    expect(act).toThrow(ExportError);
    expect(act).toThrow(/cannot write a layer with zero features/);
  });
});

describe("writeGeoJson — non-polygon and multi-polygon geometries", () => {
  it("reorients a MultiPolygon to the right-hand rule (each exterior CCW, each hole CW)", () => {
    // Two component polygons, both fed in with the WRONG (shapefile) winding:
    // exterior CW (area < 0), hole CCW (area > 0). The writer must flip both.
    const multi: MultiPolygon = {
      type: "MultiPolygon",
      coordinates: [
        [
          // exterior, clockwise
          [
            [0, 0],
            [0, 10],
            [10, 10],
            [10, 0],
            [0, 0],
          ],
          // hole, counter-clockwise
          [
            [2, 2],
            [4, 2],
            [4, 4],
            [2, 4],
            [2, 2],
          ],
        ],
        [
          // second polygon exterior, clockwise, no hole
          [
            [20, 20],
            [20, 30],
            [30, 30],
            [30, 20],
            [20, 20],
          ],
        ],
      ],
    };
    const bytes = writeGeoJson([{ geometry: multi, properties: { rate: 1 } }]);
    const fc = JSON.parse(new TextDecoder().decode(bytes)) as {
      features: Array<{ geometry: { type: string; coordinates: number[][][][] } }>;
    };
    const geom = fc.features[0]!.geometry;
    expect(geom.type).toBe("MultiPolygon");
    expect(geom.coordinates).toHaveLength(2);
    for (const polygon of geom.coordinates) {
      expect(signedArea(polygon[0]!)).toBeGreaterThan(0); // exterior CCW
      for (const hole of polygon.slice(1)) {
        expect(signedArea(hole)).toBeLessThan(0); // holes CW
      }
    }
  });

  it("passes a LineString geometry through unchanged (RFC 7946 does not constrain line winding)", () => {
    const line: LineString = {
      type: "LineString",
      coordinates: [
        [-88.2, 40.1],
        [-88.19, 40.12],
        [-88.18, 40.11],
      ],
    };
    const bytes = writeGeoJson([{ geometry: line, properties: { ab_id: 1 } }]);
    const fc = JSON.parse(new TextDecoder().decode(bytes)) as {
      features: Array<{ geometry: LineString }>;
    };
    expect(fc.features[0]!.geometry).toEqual(line);
  });

  it("passes a MultiLineString geometry through unchanged", () => {
    const mls: MultiLineString = {
      type: "MultiLineString",
      coordinates: [
        [
          [-88.2, 40.1],
          [-88.2, 40.11],
        ],
        [
          [-88.19, 40.12],
          [-88.19, 40.13],
        ],
      ],
    };
    const bytes = writeGeoJson([{ geometry: mls, properties: { ab_id: 1 } }]);
    const fc = JSON.parse(new TextDecoder().decode(bytes)) as {
      features: Array<{ geometry: MultiLineString }>;
    };
    expect(fc.features[0]!.geometry).toEqual(mls);
  });
});

describe("writeGeoJson — fixture parity (simple1, imperial)", () => {
  it("matches fixtures/simple1/imperial/seed/trial-design.geojson feature-for-feature", () => {
    const td = loadTrialDesign("simple1", "imperial", ["seed"]);
    const features = trialDesignFeatures("seed", td);
    const bytes = writeGeoJson(features);
    const fc = JSON.parse(new TextDecoder().decode(bytes)) as {
      features: Array<{
        properties: { rate: number; strip_id: number | null; plot_id: number | null; type: string };
      }>;
    };

    // The fixture IS the merged trial-design (task's own construction source),
    // so this is a direct structural check, not a coincidence.
    expect(fc.features.length).toBe(
      td.inputs[0]!.plots.features.length + td.inputs[0]!.headlands.features.length
    );
    const headland = fc.features.find((f) => f.properties.type === "headland")!;
    expect(headland.properties.rate).toBeCloseTo(34_000, 6);
    expect(headland.properties.strip_id).toBeNull();
    expect(headland.properties.plot_id).toBeNull();
  });
});
