// @vitest-environment jsdom
// Browser smoke test (task 8.1): the built bundle must run the full pipeline
// in a DOM environment without touching any Node builtin (node:fs/node:path
// are only reachable through writeTrialFilesToDisk's dynamic imports, which
// this test never calls). Fixture data is loaded by the TEST via fs — the
// library itself only ever sees plain GeoJSON objects and returns bytes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assignRates,
  checkOrthoWithChars,
  makeExpPlots,
  prepPlot,
  prepRate,
  writeTrialFiles,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — dist is built by `bun run build` (CI runs build before test? no: skip below when absent)
} from "../dist/index.js";

const root = join(import.meta.dirname, "..");
const boundary = JSON.parse(readFileSync(join(root, "fixtures/boundary-simple1.geojson"), "utf8"));
const abLine = JSON.parse(readFileSync(join(root, "fixtures/ab-line-simple1.geojson"), "utf8"));
const ssurgo = JSON.parse(readFileSync(join(root, "fixtures/ssurgo-simple1.geojson"), "utf8"));

describe("browser bundle smoke", () => {
  it("runs the full pipeline in a jsdom environment", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("object"); // really jsdom

    const plotInfo = prepPlot({
      inputName: "seed",
      unitSystem: "imperial",
      machineWidth: 60,
      sectionNum: 24,
      harvesterWidth: 30,
    });
    const rateInfo = prepRate(plotInfo, {
      gcRate: 34000,
      unit: "seeds",
      rates: [20000, 26000, 32000, 38000, 44000],
    });
    const layout = makeExpPlots({ inputPlotInfo: plotInfo, boundary, abLine });
    const design = assignRates(layout, rateInfo, { seed: 20260702 });

    const input = design.inputs[0]!;
    expect(input.plots.features.length).toBeGreaterThan(300);
    const rates = new Set(input.plots.features.map((f) => f.properties?.rate as number));
    expect(rates.size).toBe(5);

    const ortho = checkOrthoWithChars(design, ssurgo, ["clay"]);
    expect(Math.abs(ortho[0]!.correlations[0]!.corWithRate)).toBeLessThan(0.3);

    const zip = writeTrialFiles(design, { ext: "geojson" });
    expect(zip.length).toBeGreaterThan(5_000);
  });
});
