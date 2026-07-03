// Task 7.5 — software-terminal validation of the ISOXML export.
//
// No physical ISOBUS terminal is wired into CI, so this test stands in with
// the industry-reference JS implementation (dev4Agriculture's `isoxml`, the
// parser behind isoxml.online and commercial FMIS import pipelines): if it
// accepts our TASKDATA zip the way a terminal's file import does, the layout
// and entity structure are terminal-shaped. A run on real hardware is still
// what lifts the beta flag — see docs/isoxml-units.md "Terminal import".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { ISOXMLManager, TAGS } from "isoxml";
import { describe, expect, it } from "vitest";
import { writeTrialFiles } from "../src/exports/write-trial-files.js";
import { loadTrialDesign } from "./exports-fixtures.js";

const root = join(import.meta.dirname, "..");

describe("ISOXML terminal-import layout (task 7.5)", () => {
  it("single input: TASKDATA/TASKDATA.XML sits at the medium root", () => {
    const td = loadTrialDesign("simple1", "imperial", ["seed"]);
    const files = unzipSync(writeTrialFiles(td, { ext: "isoxml" }));
    expect(Object.keys(files)).toEqual(["TASKDATA/TASKDATA.XML"]);
  });

  it("multi input: one TASKDATA dir per input subdirectory", () => {
    const td = loadTrialDesign("two-input", "imperial", ["seed", "NH3"]);
    const files = unzipSync(writeTrialFiles(td, { ext: "isoxml" }));
    expect(Object.keys(files).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "NH3/TASKDATA/TASKDATA.XML",
      "seed/TASKDATA/TASKDATA.XML",
    ]);
  });
});

describe("ISOXML parsed by the reference implementation (task 7.5)", () => {
  async function parseWithReference(zipBytes: Uint8Array): Promise<ISOXMLManager> {
    const manager = new ISOXMLManager();
    await manager.parseISOXMLFile(zipBytes, "application/zip");
    return manager;
  }

  it("single-input export imports cleanly (partfield, task, treatment zones, rates)", async () => {
    const td = loadTrialDesign("simple1", "imperial", ["seed"]);
    const manager = await parseWithReference(writeTrialFiles(td, { ext: "isoxml" }));

    const partfields = manager.getEntitiesOfTag(TAGS.Partfield);
    const tasks = manager.getEntitiesOfTag(TAGS.Task);
    expect(partfields.length).toBe(1);
    expect(tasks.length).toBe(1);
    // Treatment zones are children of the task, not top-level entities.
    const zones =
      (tasks[0]!.attributes as { TreatmentZone?: { attributes: Record<string, unknown> }[] })
        .TreatmentZone ?? [];
    // 5 trial rates + the headland gc-rate zone
    expect(zones.length).toBeGreaterThanOrEqual(5);

    const fixtureRates = new Set(
      JSON.parse(
        readFileSync(join(root, "fixtures/simple1/imperial/seed/trial-design.geojson"), "utf8")
      ).features.map((f: { properties: { rate: number } }) => f.properties.rate)
    );
    // Every treatment zone's process-data value maps back to a fixture rate
    // (seeds are DDI count-per-area; raw value = seeds/ha as an integer).
    const zoneValues = zones.flatMap(
      (z) =>
        (
          z.attributes as unknown as {
            ProcessDataVariable?: { attributes: { ProcessDataValue: number } }[];
          }
        ).ProcessDataVariable?.map((p) => p.attributes.ProcessDataValue) ?? []
    );
    expect(zoneValues.length).toBeGreaterThanOrEqual(5);
    // DDI 11 raw = seeds/m^2 / 0.001 resolution (docs/isoxml-units.md);
    // decode back to seeds/acre: raw * 0.001 * 4046.8564224 m^2/acre.
    const acreM2 = 4046.8564224;
    for (const raw of zoneValues) {
      const seedsPerAcre = raw * 0.001 * acreM2;
      // raw is integer-rounded: +/-0.5 raw ~= +/-2 seeds/acre of slack
      const matches = [...fixtureRates].some((r) => Math.abs(seedsPerAcre - (r as number)) < 5);
      expect(
        matches,
        `zone value ${raw} (≈${seedsPerAcre}/ac) not in ${[...fixtureRates].join(",")}`
      ).toBe(true);
    }

    // The reference parser reports no structural warnings on our file.
    expect(manager.getWarnings()).toEqual([]);
  });

  it("each input of a multi-input export imports cleanly on its own", async () => {
    const td = loadTrialDesign("two-input", "imperial", ["seed", "NH3"]);
    const files = unzipSync(writeTrialFiles(td, { ext: "isoxml" }));
    for (const inputName of ["seed", "NH3"]) {
      // Simulate the documented transfer procedure: copy one input's
      // TASKDATA/ folder to the medium root, then import.
      const medium = zipSync({
        "TASKDATA/TASKDATA.XML": files[`${inputName}/TASKDATA/TASKDATA.XML`]!,
      });
      const manager = await parseWithReference(medium);
      expect(manager.getEntitiesOfTag(TAGS.Partfield).length).toBe(1);
      expect(manager.getEntitiesOfTag(TAGS.Task).length).toBe(1);
      expect(manager.getWarnings()).toEqual([]);
    }
  });
});

describe("ISOXML field boundary and guidance lines (task 7.3 extension)", () => {
  // Partfield's own child-tag naming (isoxml-js baseEntities/Partfield.ts
  // CHILD_TAGS): PLN -> "PolygonnonTreatmentZoneonly" (the boundary PLN,
  // distinct from a TZN's own PLN children), GGP -> "GuidanceGroup".
  interface PartfieldAttrs {
    PolygonnonTreatmentZoneonly?: { attributes: { PolygonType: string } }[];
    GuidanceGroup?: {
      attributes: {
        GuidancePattern?: {
          attributes: {
            GuidancePatternDesignator: string;
            GuidancePatternType: string;
            LineString?: {
              attributes: {
                LineStringType: string;
                Point?: { attributes: { PointEast: number; PointNorth: number } }[];
              };
            }[];
          };
        }[];
      };
    }[];
  }

  async function parseWithReference(zipBytes: Uint8Array): Promise<ISOXMLManager> {
    const manager = new ISOXMLManager();
    await manager.parseISOXMLFile(zipBytes, "application/zip");
    return manager;
  }

  it("PFD carries a Partfield Boundary PLN (PolygonType 1), separate from TZN polygons", async () => {
    const td = loadTrialDesign("simple1", "imperial", ["seed"]);
    const manager = await parseWithReference(writeTrialFiles(td, { ext: "isoxml" }));
    const partfield = manager.getEntitiesOfTag(TAGS.Partfield)[0] as unknown as {
      attributes: PartfieldAttrs;
    };
    const boundaryPlns = partfield.attributes.PolygonnonTreatmentZoneonly ?? [];
    expect(boundaryPlns.length).toBeGreaterThanOrEqual(1);
    for (const pln of boundaryPlns) {
      expect(pln.attributes.PolygonType).toBe("1");
    }
    expect(manager.getWarnings()).toEqual([]);
  });

  it("PFD carries a GuidanceGroup with one GPN for the ab-line and one per harvester guidance line", async () => {
    const td = loadTrialDesign("simple1", "imperial", ["seed"]);
    const manager = await parseWithReference(writeTrialFiles(td, { ext: "isoxml" }));
    const partfield = manager.getEntitiesOfTag(TAGS.Partfield)[0] as unknown as {
      attributes: PartfieldAttrs;
    };
    const abLineFixture: { features: { geometry: { coordinates: [number, number][] } }[] } =
      JSON.parse(
        readFileSync(join(root, "fixtures/simple1/imperial/seed/ab-line.geojson"), "utf8")
      );
    const harvesterFixture: { features: { geometry: { coordinates: [number, number][] } }[] } =
      JSON.parse(
        readFileSync(join(root, "fixtures/simple1/imperial/seed/harvester-ab-line.geojson"), "utf8")
      );

    const guidanceGroups = partfield.attributes.GuidanceGroup ?? [];
    expect(guidanceGroups).toHaveLength(1);
    const patterns = guidanceGroups[0]!.attributes.GuidancePattern ?? [];
    // ab-line + 1 harvester guidance line in the simple1 fixture.
    expect(patterns).toHaveLength(1 + harvesterFixture.features.length);

    const abPattern = patterns.find((p) => p.attributes.GuidancePatternDesignator === "ab-line")!;
    expect(abPattern).toBeDefined();
    expect(abPattern.attributes.GuidancePatternType).toBe("1"); // AB line
    const abLsg = abPattern.attributes.LineString![0]!;
    expect(abLsg.attributes.LineStringType).toBe("5"); // Guidance Pattern
    const abPoints = abLsg.attributes.Point!.map((p) => [
      p.attributes.PointEast,
      p.attributes.PointNorth,
    ]);
    const expectedAbPoints = abLineFixture.features[0]!.geometry.coordinates;
    expect(abPoints).toHaveLength(expectedAbPoints.length);
    for (const [i, [east, north]] of abPoints.entries()) {
      expect(east).toBeCloseTo(expectedAbPoints[i]![0]!, 7);
      expect(north).toBeCloseTo(expectedAbPoints[i]![1]!, 7);
    }

    const harvesterPattern = patterns.find(
      (p) => p.attributes.GuidancePatternDesignator === "harvester-1"
    )!;
    expect(harvesterPattern).toBeDefined();
    const harvesterPoints = harvesterPattern.attributes.LineString![0]!.attributes.Point!.map(
      (p) => [p.attributes.PointEast, p.attributes.PointNorth]
    );
    const expectedHarvesterPoints = harvesterFixture.features[0]!.geometry.coordinates;
    expect(harvesterPoints).toHaveLength(expectedHarvesterPoints.length);
    for (const [i, [east, north]] of harvesterPoints.entries()) {
      expect(east).toBeCloseTo(expectedHarvesterPoints[i]![0]!, 7);
      expect(north).toBeCloseTo(expectedHarvesterPoints[i]![1]!, 7);
    }

    expect(manager.getWarnings()).toEqual([]);
  });

  it("boundary and guidance lines survive the multi-input terminal-transfer layout too", async () => {
    const td = loadTrialDesign("two-input", "imperial", ["seed", "NH3"]);
    const files = unzipSync(writeTrialFiles(td, { ext: "isoxml" }));
    for (const inputName of ["seed", "NH3"]) {
      const medium = zipSync({
        "TASKDATA/TASKDATA.XML": files[`${inputName}/TASKDATA/TASKDATA.XML`]!,
      });
      const manager = await parseWithReference(medium);
      const partfield = manager.getEntitiesOfTag(TAGS.Partfield)[0] as unknown as {
        attributes: PartfieldAttrs;
      };
      expect(
        (partfield.attributes.PolygonnonTreatmentZoneonly ?? []).length
      ).toBeGreaterThanOrEqual(1);
      const guidanceGroups = partfield.attributes.GuidanceGroup ?? [];
      expect(guidanceGroups).toHaveLength(1);
      expect((guidanceGroups[0]!.attributes.GuidancePattern ?? []).length).toBeGreaterThanOrEqual(
        2
      );
      expect(manager.getWarnings()).toEqual([]);
    }
  });
});
