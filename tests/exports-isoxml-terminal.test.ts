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
    expect(Object.keys(files).sort((a, b) => a.localeCompare(b))).toEqual([
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
