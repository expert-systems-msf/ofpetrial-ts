// @vitest-environment jsdom
// Browser smoke test (task 8.1): the built bundle must run the full pipeline
// in a DOM environment without touching any Node builtin (node:fs/node:path
// are only reachable through writeTrialFilesToDisk's dynamic imports, which
// this test never calls). Fixture data is loaded by the TEST via fs — the
// library itself only ever sees plain GeoJSON objects / raw bytes and
// returns plain data.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assignRates,
  checkOrthoWithChars,
  extractRasterMeans,
  makeExpPlots,
  prepPlot,
  prepRate,
  readGeoTiffRaster,
  writeTrialFiles,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — dist is built by `bun run build` (CI runs build before test? no: skip below when absent)
} from "../dist/index.js";

const root = join(import.meta.dirname, "..");
const boundary = JSON.parse(readFileSync(join(root, "fixtures/boundary-simple1.geojson"), "utf8"));
const abLine = JSON.parse(readFileSync(join(root, "fixtures/ab-line-simple1.geojson"), "utf8"));
const ssurgo = JSON.parse(readFileSync(join(root, "fixtures/ssurgo-simple1.geojson"), "utf8"));
const slopeTiffBytes = new Uint8Array(readFileSync(join(root, "fixtures/slope.tif")));

function buildDesign() {
  const plotInfo = prepPlot({
    inputName: "seed",
    unitSystem: "imperial",
    machineWidth: 60,
    sectionNum: 24,
    harvesterWidth: 30,
  });
  const rateInfo = prepRate(plotInfo, {
    gcRate: 34_000,
    unit: "seeds",
    rates: [20_000, 26_000, 32_000, 38_000, 44_000],
  });
  const layout = makeExpPlots({ inputPlotInfo: plotInfo, boundary, abLine });
  return assignRates(layout, rateInfo, { seed: 20_260_702 });
}

describe("browser bundle smoke", () => {
  it("runs the full pipeline in a jsdom environment", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("object"); // really jsdom

    const design = buildDesign();

    const input = design.inputs[0]!;
    expect(input.plots.features.length).toBeGreaterThan(300);
    const rates = new Set(input.plots.features.map((f) => f.properties?.rate as number));
    expect(rates.size).toBe(5);

    const ortho = checkOrthoWithChars(design, ssurgo, ["clay"]);
    expect(Math.abs(ortho[0]!.correlations[0]!.corWithRate)).toBeLessThan(0.3);

    const zip = writeTrialFiles(design, { ext: "geojson" });
    expect(zip.length).toBeGreaterThan(5000);
  });

  it("runs the GeoTIFF raster diagnostics path in a jsdom environment", async () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("object"); // really jsdom

    const design = buildDesign();

    // Raw bytes in, plain data out — no Node builtin inside the library.
    const raster = await readGeoTiffRaster(slopeTiffBytes);
    expect(raster.width).toBeGreaterThan(0);
    expect(raster.epsg).toBe(4326);

    const input = design.inputs[0]!;
    const fullDesign = {
      type: "FeatureCollection" as const,
      features: [...input.plots.features, ...input.headlands.features],
    };
    const means = extractRasterMeans(fullDesign, raster);
    expect(means.length).toBe(fullDesign.features.length);
    expect(means.every((m: { mean: number }) => Number.isFinite(m.mean))).toBe(true);

    const ortho = checkOrthoWithChars(design, { raster, variable: "slope" }, ["slope"]);
    expect(Number.isFinite(ortho[0]!.correlations[0]!.corWithRate)).toBe(true);
  });
});
