// writeTrialFiles / writeTrialFilesToDisk (task 7.4) — unified API, zip
// layout per specs/machine-file-export/spec.md's "Conditionnement
// multi-intrant" scenario, unzipped independently via fflate (a third-party
// library already used elsewhere in this codebase, not code this task wrote).
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ExportError } from "../src/types.js";
import { writeTrialFiles, writeTrialFilesToDisk } from "../src/exports/write-trial-files.js";
import { loadTrialDesign } from "./exports-fixtures.js";

describe("writeTrialFiles — ext=shp", () => {
  it("two-input design: 3 subdirectories (nitrogen-equivalent + seed + harvester-ab-line), no root files", () => {
    const td = loadTrialDesign("two-input", "imperial", ["seed", "NH3"]);
    const zip = writeTrialFiles(td, { ext: "shp" });
    const files = unzipSync(zip);
    const paths = Object.keys(files).toSorted((a, b) => a.localeCompare(b));

    const rootFiles = paths.filter((p) => !p.includes("/"));
    expect(rootFiles).toEqual([]);

    const expected = [
      "NH3/NH3.dbf",
      "NH3/NH3.prj",
      "NH3/NH3.shp",
      "NH3/NH3.shx",
      "NH3/ab-line.dbf",
      "NH3/ab-line.prj",
      "NH3/ab-line.shp",
      "NH3/ab-line.shx",
      "harvester-ab-line/harvester-ab-line.dbf",
      "harvester-ab-line/harvester-ab-line.prj",
      "harvester-ab-line/harvester-ab-line.shp",
      "harvester-ab-line/harvester-ab-line.shx",
      "seed/ab-line.dbf",
      "seed/ab-line.prj",
      "seed/ab-line.shp",
      "seed/ab-line.shx",
      "seed/seed.dbf",
      "seed/seed.prj",
      "seed/seed.shp",
      "seed/seed.shx",
    ].toSorted((a, b) => a.localeCompare(b));
    expect(paths).toEqual(expected);
  });
});

describe("writeTrialFiles — ext=geojson", () => {
  it("mono-input design: <inputName>/<inputName>.geojson, ab-line, harvester", () => {
    const td = loadTrialDesign("simple1", "imperial", ["seed"]);
    const zip = writeTrialFiles(td, { ext: "geojson" });
    const paths = Object.keys(unzipSync(zip)).toSorted((a, b) => a.localeCompare(b));
    expect(paths).toEqual(
      [
        "harvester-ab-line/harvester-ab-line.geojson",
        "seed/ab-line.geojson",
        "seed/seed.geojson",
      ].toSorted((a, b) => a.localeCompare(b))
    );
  });
});

describe("writeTrialFiles — ext=isoxml", () => {
  it("no ab-lines, no harvester dir; TASKDATA/TASKDATA.XML per input (ISO 11783-10 naming)", () => {
    const td = loadTrialDesign("two-input", "imperial", ["seed", "NH3"]);
    const zip = writeTrialFiles(td, { ext: "isoxml" });
    const paths = Object.keys(unzipSync(zip)).toSorted((a, b) => a.localeCompare(b));
    expect(paths).toEqual(["NH3/TASKDATA/TASKDATA.XML", "seed/TASKDATA/TASKDATA.XML"]);
  });
});

describe("writeTrialFiles — error cases", () => {
  it("throws ExportError on an unsupported ext", () => {
    const td = loadTrialDesign("simple1", "imperial", ["seed"]);
    expect(() => writeTrialFiles(td, { ext: "kml" as never })).toThrow(ExportError);
  });

  it("throws ExportError on a TrialDesign with zero inputs", () => {
    expect(() => writeTrialFiles({ inputs: [], seed: 0 }, { ext: "shp" })).toThrow(ExportError);
  });
});

describe("writeTrialFilesToDisk", () => {
  it("writes the same layout as writeTrialFiles, unzipped, to a folder", async () => {
    const td = loadTrialDesign("simple1", "imperial", ["seed"]);
    const dir = await mkdtemp(join(tmpdir(), "ofpetrial-exports-"));
    try {
      await writeTrialFilesToDisk(td, dir, { ext: "geojson" });
      const seedEntries = await readdir(join(dir, "seed"));
      const seedFiles = seedEntries.toSorted((a, b) => a.localeCompare(b));
      expect(seedFiles).toEqual(["ab-line.geojson", "seed.geojson"]);
      const harvesterFiles = await readdir(join(dir, "harvester-ab-line"));
      expect(harvesterFiles).toEqual(["harvester-ab-line.geojson"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
