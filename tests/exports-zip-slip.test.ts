// Zip-Slip / path-traversal guards (security review item on tasks 7.1-7.4).
// Two layers, tested separately:
// 1. writeTrialFiles rejects hostile input_name values before any zip entry
//    is created (source-side guard).
// 2. writeTrialFilesToDisk re-verifies every resolved output path stays
//    under folderPath (defense in depth). That branch is unreachable through
//    the public API once layer 1 holds, so it is exercised by mocking
//    fflate's unzipSync to return a crafted "../" entry.
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExportError } from "../src/types.js";
import { writeTrialFiles, writeTrialFilesToDisk } from "../src/exports/write-trial-files.js";
import { loadTrialDesign } from "./exports-fixtures.js";

vi.mock("fflate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fflate")>();
  return {
    ...actual,
    unzipSync: (data: Uint8Array) => {
      // Real unzip, then inject a traversal entry to hit the disk-side guard.
      const files = actual.unzipSync(data);
      return { "../evil.txt": new Uint8Array([0x45]), ...files };
    },
  };
});

function maliciousTd(inputName: string) {
  const td = loadTrialDesign("simple1", "imperial", ["seed"]);
  const input = td.inputs[0]!;
  return {
    ...td,
    inputs: [{ ...input, plotInfo: { ...input.plotInfo, input_name: inputName } }],
  };
}

describe("writeTrialFiles — input_name validation (Zip-Slip source guard)", () => {
  const badNames = [
    "../evil",
    "..",
    "a/b",
    "a\\b",
    ".hidden",
    "",
    "nul\u0000name",
    "line\nbreak",
  ];

  for (const name of badNames) {
    it(`rejects input_name ${JSON.stringify(name)}`, () => {
      expect(() => writeTrialFiles(maliciousTd(name), { ext: "geojson" })).toThrow(ExportError);
    });
  }

  it("accepts ordinary names (letters, digits, dash, underscore, inner dot)", () => {
    expect(() => writeTrialFiles(maliciousTd("NH3_v2.final"), { ext: "geojson" })).not.toThrow();
  });
});

describe("writeTrialFilesToDisk — crafted zip entry blocked (defense in depth)", () => {
  it("throws ExportError on a traversal entry and writes nothing outside the folder", async () => {
    const td = loadTrialDesign("simple1", "imperial", ["seed"]);
    const parent = await mkdtemp(join(tmpdir(), "ofpetrial-zipslip-"));
    const outDir = join(parent, "out");
    try {
      // The mocked unzipSync injects "../evil.txt" ahead of the real entries.
      await expect(writeTrialFilesToDisk(td, outDir, { ext: "geojson" })).rejects.toThrow(ExportError);
      await expect(access(join(parent, "evil.txt"))).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
