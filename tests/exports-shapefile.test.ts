// Shapefile writer (task 7.1) — geometry/attribute correctness and R
// fixture parity, verified by an independent reader (tests/exports-shp-reader.ts)
// that shares no code with src/exports/shapefile.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MultiPolygon, Polygon } from "geojson";
import { ExportError } from "../src/types.js";
import { TRIAL_DESIGN_FIELDS, AB_LINE_FIELDS } from "../src/exports/write-trial-files.js";
import type { ShapefileFeatureInput } from "../src/exports/shapefile.js";
import { writeShapefile } from "../src/exports/shapefile.js";
import { loadTrialDesign } from "./exports-fixtures.js";
import { readDbf, readShp, readShpHeader } from "./exports-shp-reader.js";

const ROOT = join(import.meta.dirname, "..");

function trialDesignFeatures(td: ReturnType<typeof loadTrialDesign>): ShapefileFeatureInput[] {
  const input = td.inputs[0]!;
  const features: ShapefileFeatureInput[] = [];
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

describe("writeShapefile — trial-design layer (simple1, imperial)", () => {
  const td = loadTrialDesign("simple1", "imperial", ["seed"]);
  const features = trialDesignFeatures(td);
  const { shp, shx, dbf, prj } = writeShapefile(features, {
    geometryType: "polygon",
    fields: TRIAL_DESIGN_FIELDS,
  });

  it("writes a .prj declaring WGS84, matching R's sf::st_write output byte-for-byte", () => {
    const rPrj = readFileSync(
      join(ROOT, "fixtures/simple1/imperial/r-exports/trial-design-seed.prj"),
      "utf8",
    );
    expect(new TextDecoder().decode(prj)).toBe(rPrj);
  });

  it("round-trips through an independent .shp/.dbf reader with the right feature count", () => {
    const shpResult = readShp(shp);
    const dbfResult = readDbf(dbf);
    expect(shpResult.shapeType).toBe(5); // Polygon
    expect(shpResult.features.length).toBe(features.length);
    expect(dbfResult.records.length).toBe(features.length);
  });

  it("writes correct fixed .shp/.shx header fields (file code 9994 BE, file length in words BE, dataset bbox)", () => {
    const shpResult = readShp(shp);
    expect(shpResult.fileCode).toBe(9994);
    expect(shpResult.fileLengthWords).toBe(shp.length / 2);

    // Same 100-byte header layout on .shx (header-only read: .shx records
    // are 8-byte index entries, not shape records).
    const shxHeader = readShpHeader(shx);
    expect(shxHeader.fileCode).toBe(9994);
    expect(shxHeader.fileLengthWords).toBe(shx.length / 2);

    // Dataset bbox must be the envelope of every coordinate in the file.
    let xMin = Infinity;
    let yMin = Infinity;
    let xMax = -Infinity;
    let yMax = -Infinity;
    for (const feature of shpResult.features) {
      for (const part of feature.parts) {
        for (const [x, y] of part) {
          xMin = Math.min(xMin, x);
          yMin = Math.min(yMin, y);
          xMax = Math.max(xMax, x);
          yMax = Math.max(yMax, y);
        }
      }
    }
    expect(shpResult.bbox.xMin).toBeCloseTo(xMin, 12);
    expect(shpResult.bbox.yMin).toBeCloseTo(yMin, 12);
    expect(shpResult.bbox.xMax).toBeCloseTo(xMax, 12);
    expect(shpResult.bbox.yMax).toBeCloseTo(yMax, 12);
    // And match R's own header bbox for the same features (1e-7 deg).
    const rShp = readShp(
      new Uint8Array(readFileSync(join(ROOT, "fixtures/simple1/imperial/r-exports/trial-design-seed.shp"))),
    );
    expect(Math.abs(shpResult.bbox.xMin - rShp.bbox.xMin)).toBeLessThan(1e-7);
    expect(Math.abs(shpResult.bbox.yMin - rShp.bbox.yMin)).toBeLessThan(1e-7);
    expect(Math.abs(shpResult.bbox.xMax - rShp.bbox.xMax)).toBeLessThan(1e-7);
    expect(Math.abs(shpResult.bbox.yMax - rShp.bbox.yMax)).toBeLessThan(1e-7);
  });

  it(".shx offsets/lengths agree with the .shp record table", () => {
    const shxView = new DataView(shx.buffer, shx.byteOffset, shx.byteLength);
    const shpView = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
    const numRecords = features.length;
    let shpOffset = 100;
    for (let i = 0; i < numRecords; i++) {
      const shxRecOffset = 100 + i * 8;
      const offsetWords = shxView.getInt32(shxRecOffset, false);
      const lengthWords = shxView.getInt32(shxRecOffset + 4, false);
      expect(offsetWords * 2).toBe(shpOffset);
      const shpContentLengthWords = shpView.getInt32(shpOffset + 4, false);
      expect(lengthWords).toBe(shpContentLengthWords);
      shpOffset += 8 + lengthWords * 2;
    }
    expect(shpOffset).toBe(shp.length);
  });

  it("DBF field schema matches R exactly (name/type/length/decimals)", () => {
    const dbfResult = readDbf(dbf);
    expect(dbfResult.fields).toEqual([
      { name: "rate", type: "N", length: 24, decimals: 15 },
      { name: "strip_id", type: "N", length: 9, decimals: 0 },
      { name: "plot_id", type: "N", length: 9, decimals: 0 },
      { name: "type", type: "C", length: 80, decimals: 0 },
    ]);
  });

  it("encodes headland NA strip_id/plot_id as null (dBase '*' NA marker), matching R's convention", () => {
    const dbfResult = readDbf(dbf);
    const headlandRecords = dbfResult.records.filter((r) => r.type === "headland");
    expect(headlandRecords.length).toBe(1);
    expect(headlandRecords[0]!.strip_id).toBeNull();
    expect(headlandRecords[0]!.plot_id).toBeNull();
    expect(headlandRecords[0]!.rate).toBeCloseTo(34000, 6);
  });

  it("fixes ring winding to the shapefile convention regardless of input winding", () => {
    const shpResult = readShp(shp);
    function signedArea(ring: Array<[number, number]>): number {
      let sum = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i]!;
        const [x2, y2] = ring[i + 1]!;
        sum += x1 * y2 - x2 * y1;
      }
      return sum / 2;
    }
    for (const feature of shpResult.features) {
      expect(signedArea(feature.parts[0]!)).toBeLessThan(0); // exterior: CW
      for (const hole of feature.parts.slice(1)) {
        expect(signedArea(hole)).toBeGreaterThan(0); // holes: CCW
      }
    }
  });
});

describe("writeShapefile — R fixture parity (simple1, imperial)", () => {
  const td = loadTrialDesign("simple1", "imperial", ["seed"]);
  const features = trialDesignFeatures(td);
  const { shp, dbf } = writeShapefile(features, { geometryType: "polygon", fields: TRIAL_DESIGN_FIELDS });
  const ours = { shp: readShp(shp), dbf: readDbf(dbf) };

  const rShpBytes = readFileSync(join(ROOT, "fixtures/simple1/imperial/r-exports/trial-design-seed.shp"));
  const rDbfBytes = readFileSync(join(ROOT, "fixtures/simple1/imperial/r-exports/trial-design-seed.dbf"));
  const r = { shp: readShp(new Uint8Array(rShpBytes)), dbf: readDbf(new Uint8Array(rDbfBytes)) };

  it("same feature count as R", () => {
    expect(ours.dbf.records.length).toBe(r.dbf.records.length);
    expect(ours.shp.features.length).toBe(r.shp.features.length);
  });

  // Compared by row index, not by (strip_id, plot_id): our TrialDesign is
  // built directly from the same frozen trial-design.geojson R exported as
  // this .shp/.dbf (tests/exports-fixtures.ts), so row order is preserved
  // and index alignment is exact. A key-based match would break on fields
  // with holes: types.ts documents that (strip_id, plot_id) repeats when a
  // boundary hole splits a strip into disjoint pieces (see
  // tests/parity-exports.test.ts's with-holes case).
  it("same attributes and coordinates as R, matched by row index", () => {
    expect(ours.dbf.records.length).toBe(r.dbf.records.length);
    ours.dbf.records.forEach((rec, i) => {
      const rRec = r.dbf.records[i]!;
      expect(rec.rate).toBeCloseTo(rRec.rate as number, 6);
      expect(rec.type).toBe(rRec.type);

      const oursGeom = ours.shp.features[i]!;
      const rGeom = r.shp.features[i]!;
      expect(oursGeom.parts.length).toBe(rGeom.parts.length);
      oursGeom.parts.forEach((ring, ringIdx) => {
        const rRing = rGeom.parts[ringIdx]!;
        expect(ring.length).toBe(rRing.length);
        ring.forEach(([x, y], ptIdx) => {
          const [rx, ry] = rRing[ptIdx]!;
          expect(Math.abs(x - rx)).toBeLessThan(1e-7);
          expect(Math.abs(y - ry)).toBeLessThan(1e-7);
        });
      });
    });
  });
});

describe("writeShapefile — ab-line layer (polyline)", () => {
  it("matches R's ab-line-seed.shp/.dbf (ab_id field, LineString coordinates)", () => {
    const td = loadTrialDesign("simple1", "imperial", ["seed"]);
    const abLine = td.inputs[0]!.abLine;
    const { shp, dbf } = writeShapefile([{ geometry: abLine.geometry, properties: { ab_id: 1 } }], {
      geometryType: "polyline",
      fields: AB_LINE_FIELDS,
    });
    const ours = { shp: readShp(shp), dbf: readDbf(dbf) };

    const rShpBytes = readFileSync(join(ROOT, "fixtures/simple1/imperial/r-exports/ab-line-seed.shp"));
    const rDbfBytes = readFileSync(join(ROOT, "fixtures/simple1/imperial/r-exports/ab-line-seed.dbf"));
    const r = { shp: readShp(new Uint8Array(rShpBytes)), dbf: readDbf(new Uint8Array(rDbfBytes)) };

    expect(ours.shp.shapeType).toBe(3); // PolyLine
    expect(ours.dbf.records).toEqual(r.dbf.records);
    expect(ours.shp.features[0]!.parts[0]!.length).toBe(r.shp.features[0]!.parts[0]!.length);
    ours.shp.features[0]!.parts[0]!.forEach(([x, y], i) => {
      const [rx, ry] = r.shp.features[0]!.parts[0]![i]!;
      expect(Math.abs(x - rx)).toBeLessThan(1e-7);
      expect(Math.abs(y - ry)).toBeLessThan(1e-7);
    });
  });
});

describe("writeShapefile — MultiPolygon support", () => {
  it("flattens a MultiPolygon's rings into a single multi-part record", () => {
    const multi: MultiPolygon = {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
          ],
        ],
        [
          [
            [10, 10],
            [10, 11],
            [11, 11],
            [11, 10],
            [10, 10],
          ],
        ],
      ],
    };
    const { shp } = writeShapefile([{ geometry: multi, properties: { ab_id: 1 } }], {
      geometryType: "polygon",
      fields: AB_LINE_FIELDS,
    });
    const result = readShp(shp);
    expect(result.features.length).toBe(1);
    expect(result.features[0]!.parts.length).toBe(2); // one ring per sub-polygon
  });
});

describe("writeShapefile — error cases", () => {
  it("throws ExportError on an empty feature list", () => {
    expect(() => writeShapefile([], { geometryType: "polygon", fields: TRIAL_DESIGN_FIELDS })).toThrow(
      ExportError,
    );
  });

  it("throws ExportError on a geometry/geometryType mismatch", () => {
    const lineGeom = { type: "LineString" as const, coordinates: [[0, 0] as [number, number], [1, 1] as [number, number]] };
    expect(() =>
      writeShapefile([{ geometry: lineGeom, properties: { ab_id: 1 } }], {
        geometryType: "polygon",
        fields: AB_LINE_FIELDS,
      }),
    ).toThrow(ExportError);
  });

  const squareGeom: Polygon = {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
        [0, 0],
      ],
    ],
  };

  it("throws ExportError on a DBF field name longer than 10 chars", () => {
    expect(() =>
      writeShapefile([{ geometry: squareGeom, properties: { verylongfieldname: 1 } }], {
        geometryType: "polygon",
        fields: [{ name: "verylongfieldname", type: "N", length: 9 }],
      }),
    ).toThrow(ExportError);
  });

  it("throws ExportError on a DBF field length above the single-byte maximum (255)", () => {
    expect(() =>
      writeShapefile([{ geometry: squareGeom, properties: { big: "x" } }], {
        geometryType: "polygon",
        fields: [{ name: "big", type: "C", length: 256 }],
      }),
    ).toThrow(ExportError);
  });

  it("throws ExportError on an empty geometry (zero rings/points)", () => {
    const emptyGeom: Polygon = { type: "Polygon", coordinates: [] };
    expect(() =>
      writeShapefile([{ geometry: emptyGeom, properties: { ab_id: 1 } }], {
        geometryType: "polygon",
        fields: AB_LINE_FIELDS,
      }),
    ).toThrow(ExportError);
  });

  it("throws ExportError on null in a character ('C') field — '*' NA padding is numeric-only", () => {
    expect(() =>
      writeShapefile([{ geometry: squareGeom, properties: { label: null } }], {
        geometryType: "polygon",
        fields: [{ name: "label", type: "C", length: 20 }],
      }),
    ).toThrow(ExportError);
  });
});
