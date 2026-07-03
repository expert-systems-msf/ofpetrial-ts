// Unified export entry point — task 7.4. Merges a TrialDesign's per-input
// plots + headlands into the R-equivalent trial-design layer, plus the
// applicator and harvester ab-lines, and writes them all into a single zip
// (fflate) with the subdirectory layout from
// specs/machine-file-export/spec.md:
//   <inputName>/<inputName>.<ext>   (shp: .shp+.shx+.dbf+.prj, geojson: .geojson)
//   <inputName>/ab-line.<ext>
//   harvester-ab-line/harvester-ab-line.<ext>
// ISOXML exception (ISO 11783-10 terminals look for this exact name):
//   <inputName>/TASKDATA.XML   — no ab-lines, no harvester-ab-line dir.
import { zipSync } from "fflate";
import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon } from "geojson";
import type { InputDesign, TrialDesign } from "../types.js";
import { ExportError } from "../types.js";
import { writeGeoJson } from "./geojson.js";
import { writeIsoxml } from "./isoxml.js";
import type { ShapefileFeatureInput } from "./shapefile.js";
import { writeShapefile } from "./shapefile.js";

export type WriteTrialFilesExt = "shp" | "geojson" | "isoxml";

export interface WriteTrialFilesOptions {
  ext: WriteTrialFilesExt;
  zipName?: string;
}

/** DBF schema for the trial-design layer, matching R's write_trial_files() output field-for-field. */
export const TRIAL_DESIGN_FIELDS = [
  { name: "rate", type: "N" as const, length: 24, decimals: 15 },
  { name: "strip_id", type: "N" as const, length: 9 },
  { name: "plot_id", type: "N" as const, length: 9 },
  { name: "type", type: "C" as const, length: 80 },
];

/** DBF schema for ab-line layers (applicator + harvester), matching R's `ab_id` field. */
export const AB_LINE_FIELDS = [{ name: "ab_id", type: "N" as const, length: 9 }];

/**
 * Zip-Slip guard: input_name is free-form user data that becomes zip entry
 * paths (and, via writeTrialFilesToDisk, on-disk paths). Reject anything
 * that could escape the archive root or smuggle path separators / control
 * characters.
 */
function assertSafeInputName(inputName: string): void {
  const hasControlChars = /[\u0000-\u001f\u007f]/.test(inputName);
  if (
    inputName.length === 0 ||
    inputName.includes("/") ||
    inputName.includes("\\") ||
    inputName.includes("..") ||
    inputName.startsWith(".") ||
    hasControlChars
  ) {
    throw new ExportError(
      `writeTrialFiles: unsafe input_name ${JSON.stringify(inputName)} — must not be empty, contain "/", "\\", "..", control characters, or start with "."`
    );
  }
}

/** Merges plots + headlands into the R `trial_design` layer's feature set (rate/strip_id/plot_id/type). */
function trialDesignFeatures(input: InputDesign): ShapefileFeatureInput[] {
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
  if (features.length === 0) {
    throw new ExportError(`writeTrialFiles: input has no plots or headlands`);
  }
  return features;
}

function abLineFeatures(abLine: Feature<LineString>): ShapefileFeatureInput[] {
  return [{ geometry: abLine.geometry, properties: { ab_id: 1 } }];
}

function guidanceLineFeatures(guidanceLines: FeatureCollection): ShapefileFeatureInput[] {
  return guidanceLines.features.map((f, i) => ({
    geometry: f.geometry as LineString,
    properties: { ab_id: i + 1 },
  }));
}

function shapefileZipEntries(
  prefix: string,
  name: string,
  features: ShapefileFeatureInput[],
  geometryType: "polygon" | "polyline",
  fields: typeof TRIAL_DESIGN_FIELDS | typeof AB_LINE_FIELDS
): Record<string, Uint8Array> {
  const { shp, shx, dbf, prj } = writeShapefile(features, { geometryType, fields });
  return {
    [`${prefix}/${name}.shp`]: shp,
    [`${prefix}/${name}.shx`]: shx,
    [`${prefix}/${name}.dbf`]: dbf,
    [`${prefix}/${name}.prj`]: prj,
  };
}

/**
 * Writes all machine files for a TrialDesign into a single zip archive
 * (Uint8Array). See spec.md's "Conditionnement multi-intrant" scenario for
 * the exact subdirectory layout.
 */
export function writeTrialFiles(td: TrialDesign, opts: WriteTrialFilesOptions): Uint8Array {
  if (td.inputs.length === 0) {
    throw new ExportError("writeTrialFiles: TrialDesign has no inputs");
  }

  const entries: Record<string, Uint8Array> = {};

  for (const input of td.inputs) {
    const inputName = input.plotInfo.input_name;
    assertSafeInputName(inputName);
    const trialFeatures = trialDesignFeatures(input);

    if (opts.ext === "shp") {
      Object.assign(
        entries,
        shapefileZipEntries(inputName, inputName, trialFeatures, "polygon", TRIAL_DESIGN_FIELDS),
        shapefileZipEntries(
          inputName,
          "ab-line",
          abLineFeatures(input.abLine),
          "polyline",
          AB_LINE_FIELDS
        )
      );
    } else if (opts.ext === "geojson") {
      entries[`${inputName}/${inputName}.geojson`] = writeGeoJson(trialFeatures);
      entries[`${inputName}/ab-line.geojson`] = writeGeoJson(abLineFeatures(input.abLine));
    } else if (opts.ext === "isoxml") {
      const rateUnit = input.rateInfo?.unit;
      if (!rateUnit) {
        throw new ExportError(
          `writeTrialFiles: input "${inputName}" has no rateInfo (required for ISOXML)`
        );
      }
      const plots = trialFeatures.map((f) => ({
        geometry: f.geometry as Polygon | MultiPolygon,
        rate: f.properties["rate"] as number,
      }));
      entries[`${inputName}/TASKDATA.XML`] = writeIsoxml(plots, {
        inputName,
        unitSystem: input.plotInfo.unit_system,
        rateUnit,
      });
    } else {
      throw new ExportError(`writeTrialFiles: unsupported ext "${String(opts.ext)}"`);
    }
  }

  // Harvester ab-line: written once, from the first input only (R:
  // `td$harvest_ab_lines[[1]]` — identical across inputs in the two-input
  // case). Not exported to ISOXML (guidance lines are out of the beta scope).
  if (opts.ext !== "isoxml") {
    const harvester = td.inputs[0]!.guidanceLines;
    const harvesterFeatures = guidanceLineFeatures(harvester);
    if (opts.ext === "shp") {
      Object.assign(
        entries,
        shapefileZipEntries(
          "harvester-ab-line",
          "harvester-ab-line",
          harvesterFeatures,
          "polyline",
          AB_LINE_FIELDS
        )
      );
    } else {
      entries["harvester-ab-line/harvester-ab-line.geojson"] = writeGeoJson(harvesterFeatures);
    }
  }

  return zipSync(entries, { level: 9 });
}

/** Node/Deno helper: writes the zip produced by writeTrialFiles to disk (unzipped) under folderPath. */
export async function writeTrialFilesToDisk(
  td: TrialDesign,
  folderPath: string,
  opts: WriteTrialFilesOptions
): Promise<void> {
  const { unzipSync } = await import("fflate");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname, join, resolve, sep } = await import("node:path");

  const zipBytes = writeTrialFiles(td, opts);
  const files = unzipSync(zipBytes);
  const root = resolve(folderPath);
  await mkdir(root, { recursive: true });
  for (const [relPath, bytes] of Object.entries(files)) {
    const fullPath = resolve(join(root, relPath));
    // Defense in depth against Zip-Slip: assertSafeInputName already blocks
    // hostile input_name values at zip-creation time, but re-verify here
    // that every resolved path stays under folderPath before touching disk.
    if (!fullPath.startsWith(root + sep)) {
      throw new ExportError(
        `writeTrialFilesToDisk: zip entry ${JSON.stringify(relPath)} escapes the output folder`
      );
    }
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, bytes);
  }
}
