// R fixture parity for the machine-file exports (tasks 7.1/7.4), across the
// two-input case and both unit systems — complements
// tests/exports-shapefile.test.ts (simple1 case, unit-level writeShapefile
// API). Reads with an independent parser (tests/exports-shp-reader.ts) per
// design.md D8.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { writeTrialFiles } from "../src/exports/write-trial-files.js";
import { writeGeoJson } from "../src/exports/geojson.js";
import { rateToDdiValue } from "../src/exports/isoxml.js";
import { loadTrialDesign } from "./exports-fixtures.js";
import { readDbf, readShp } from "./exports-shp-reader.js";
import { parseTags } from "./exports-isoxml-reader.js";

const ROOT = join(import.meta.dirname, "..");

function loadRShp(relPath: string) {
  return readShp(new Uint8Array(readFileSync(join(ROOT, relPath))));
}
function loadRDbf(relPath: string) {
  return readDbf(new Uint8Array(readFileSync(join(ROOT, relPath))));
}

/**
 * Compares by row index, not by (strip_id, plot_id) key: our TrialDesign is
 * built directly from the same frozen trial-design.geojson R exported as
 * this very .shp/.dbf (tests/exports-fixtures.ts), preserving row order, so
 * index alignment is exact — verified by inspecting the with-holes fixture
 * directly (0 mismatches over 647 rows). A key-based match would break on
 * that same fixture: types.ts documents that (strip_id, plot_id) repeats
 * when a boundary hole splits a strip into disjoint pieces.
 */
function assertLayerParity(
  ours: { shp: ReturnType<typeof readShp>; dbf: ReturnType<typeof readDbf> },
  r: { shp: ReturnType<typeof readShp>; dbf: ReturnType<typeof readDbf> }
): void {
  expect(ours.dbf.records.length).toBe(r.dbf.records.length);
  ours.dbf.records.forEach((rec, i) => {
    const rRec = r.dbf.records[i]!;
    expect(rec.type).toBe(rRec.type);
    expect(rec.rate).toBeCloseTo(rRec.rate as number, 6);
    const oursGeom = ours.shp.features[i]!;
    const rGeom = r.shp.features[i]!;
    expect(oursGeom.parts.length).toBe(rGeom.parts.length);
    oursGeom.parts.forEach((ring, ringIdx) => {
      const rRing = rGeom.parts[ringIdx]!;
      ring.forEach(([x, y], ptIdx) => {
        const [rx, ry] = rRing[ptIdx]!;
        expect(Math.abs(x - rx)).toBeLessThan(1e-7);
        expect(Math.abs(y - ry)).toBeLessThan(1e-7);
      });
    });
  });
}

// D9: strict imperial/metric equality — every parity case runs in both unit
// systems. simple1's design geojson lives under <case>/<unit>/seed/, the
// two-input case under <case>/<unit>/{seed,NH3}/.
const CASES = [
  { caseDir: "simple1", inputs: ["seed"] },
  { caseDir: "two-input", inputs: ["seed", "NH3"] },
] as const;
const UNITS = ["imperial", "metric"] as const;

for (const { caseDir, inputs } of CASES) {
  for (const unit of UNITS) {
    describe(`writeTrialFiles(ext=shp) — ${caseDir} R parity (${unit})`, () => {
      const td = loadTrialDesign(caseDir, unit, [...inputs]);
      const zip = writeTrialFiles(td, { ext: "shp" });
      const files = unzipSync(zip);

      it(`trial-design layers match R's trial-design-{${inputs.join(",")}}.shp/.dbf`, () => {
        for (const inputName of inputs) {
          const ours = {
            shp: readShp(files[`${inputName}/${inputName}.shp`]!),
            dbf: readDbf(files[`${inputName}/${inputName}.dbf`]!),
          };
          const r = {
            shp: loadRShp(`fixtures/${caseDir}/${unit}/r-exports/trial-design-${inputName}.shp`),
            dbf: loadRDbf(`fixtures/${caseDir}/${unit}/r-exports/trial-design-${inputName}.dbf`),
          };
          assertLayerParity(ours, r);
        }
      });

      it("ab-line layers match R's ab-line-*.shp/.dbf", () => {
        for (const inputName of inputs) {
          const oursDbf = readDbf(files[`${inputName}/ab-line.dbf`]!);
          const rDbf = loadRDbf(`fixtures/${caseDir}/${unit}/r-exports/ab-line-${inputName}.dbf`);
          expect(oursDbf.records).toEqual(rDbf.records);
        }
      });

      it("harvester ab-line matches R's ab-line-harvester.shp (written once, from the first input)", () => {
        const oursShp = readShp(files["harvester-ab-line/harvester-ab-line.shp"]!);
        const rShp = loadRShp(`fixtures/${caseDir}/${unit}/r-exports/ab-line-harvester.shp`);
        expect(oursShp.features.length).toBe(rShp.features.length);
        oursShp.features[0]!.parts[0]!.forEach(([x, y], i) => {
          const [rx, ry] = rShp.features[0]!.parts[0]![i]!;
          expect(Math.abs(x - rx)).toBeLessThan(1e-7);
          expect(Math.abs(y - ry)).toBeLessThan(1e-7);
        });
      });

      it("every .prj is R's exact WGS84 WKT", () => {
        const rPrj = readFileSync(
          join(ROOT, `fixtures/${caseDir}/${unit}/r-exports/trial-design-seed.prj`),
          "utf8"
        );
        for (const path of Object.keys(files)) {
          if (path.endsWith(".prj")) {
            expect(new TextDecoder().decode(files[path]!)).toBe(rPrj);
          }
        }
      });
    });

    describe(`writeGeoJson — ${caseDir} fixture parity (${unit})`, () => {
      it("layers match their frozen trial-design.geojson (feature count + headland rate)", () => {
        const td = loadTrialDesign(caseDir, unit, [...inputs]);
        for (const inputName of inputs) {
          const input = td.inputs.find((i) => i.plotInfo.input_name === inputName)!;
          const features = [
            ...input.plots.features.map((f) => ({
              geometry: f.geometry as never,
              properties: {
                rate: (f.properties as { rate: number }).rate,
                strip_id: (f.properties as { strip_id: number }).strip_id,
                plot_id: (f.properties as { plot_id: number }).plot_id,
                type: "experiment",
              },
            })),
            ...input.headlands.features.map((f) => ({
              geometry: f.geometry as never,
              properties: {
                rate: (f.properties as { rate: number }).rate,
                strip_id: null,
                plot_id: null,
                type: "headland",
              },
            })),
          ];
          const fc = JSON.parse(new TextDecoder().decode(writeGeoJson(features))) as {
            features: Array<{ properties: { type: string; rate: number } }>;
          };
          const fixture = JSON.parse(
            readFileSync(
              join(ROOT, `fixtures/${caseDir}/${unit}/${inputName}/trial-design.geojson`),
              "utf8"
            )
          ) as { features: Array<{ properties: { type: string; rate: number } }> };
          expect(fc.features.length).toBe(fixture.features.length);
          const ourHeadland = fc.features.find((f) => f.properties.type === "headland")!;
          const fixtureHeadland = fixture.features.find((f) => f.properties.type === "headland")!;
          expect(ourHeadland.properties.rate).toBeCloseTo(fixtureHeadland.properties.rate, 6);
        }
      });
    });
  }
}

describe("writeTrialFiles(ext=isoxml) — two-input DDI mapping (imperial)", () => {
  it("picks DDI 000B for seed (count) and 0006 for NH3 (mass), per docs/isoxml-units.md", () => {
    const td = loadTrialDesign("two-input", "imperial", ["seed", "NH3"]);
    const zip = writeTrialFiles(td, { ext: "isoxml" });
    const files = unzipSync(zip);

    const seedXml = new TextDecoder().decode(files["seed/TASKDATA/TASKDATA.XML"]!);
    const nh3Xml = new TextDecoder().decode(files["NH3/TASKDATA/TASKDATA.XML"]!);

    const seedPdvs = parseTags(seedXml).filter((t) => t.name === "PDV");
    const nh3Pdvs = parseTags(nh3Xml).filter((t) => t.name === "PDV");
    expect(seedPdvs.every((p) => p.attrs.A === "000B")).toBe(true);
    expect(nh3Pdvs.every((p) => p.attrs.A === "0006")).toBe(true);

    const nh3 = td.inputs.find((i) => i.plotInfo.input_name === "NH3")!;
    const gcRate = nh3.rateInfo!.gc_rate;
    const { raw } = rateToDdiValue(gcRate, "imperial", "lb");
    expect(nh3Pdvs.some((p) => p.attrs.B === String(raw))).toBe(true);
  });
});

describe("writeShapefile via writeTrialFiles — metric case sanity (with-holes)", () => {
  it("still exports WGS84 regardless of the design's internal unit system", () => {
    const td = loadTrialDesign("with-holes", "metric", ["seed"]);
    const zip = writeTrialFiles(td, { ext: "shp" });
    const files = unzipSync(zip);
    const rPrj = readFileSync(
      join(ROOT, "fixtures/with-holes/metric/r-exports/trial-design-seed.prj"),
      "utf8"
    );
    expect(new TextDecoder().decode(files["seed/seed.prj"]!)).toBe(rPrj);

    const ours = { shp: readShp(files["seed/seed.shp"]!), dbf: readDbf(files["seed/seed.dbf"]!) };
    const r = {
      shp: loadRShp("fixtures/with-holes/metric/r-exports/trial-design-seed.shp"),
      dbf: loadRDbf("fixtures/with-holes/metric/r-exports/trial-design-seed.dbf"),
    };
    assertLayerParity(ours, r);
  });
});
