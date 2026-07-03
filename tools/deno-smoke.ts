// Deno runtime smoke test (task 8.1): runs the full pipeline against the
// built bundle (dist/index.js) under Deno, mirroring what the example
// Supabase Edge Function does per request.
// Run from the repo root:  bun run build && deno run --allow-read tools/deno-smoke.ts
import {
  assignRates,
  makeExpPlots,
  prepPlot,
  prepRate,
  writeTrialFiles,
} from "../dist/index.js";

const boundary = JSON.parse(await Deno.readTextFile("fixtures/boundary-simple1.geojson"));
const abLine = JSON.parse(await Deno.readTextFile("fixtures/ab-line-simple1.geojson"));

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

const input = design.inputs[0];
const plotCount = input.plots.features.length;
const rates = new Set(input.plots.features.map((f: { properties: { rate: number } }) => f.properties.rate));

const zip = writeTrialFiles(design, { ext: "shp" });

if (plotCount < 300) throw new Error(`too few plots: ${plotCount}`);
if (rates.size !== 5) throw new Error(`expected 5 distinct rates, got ${rates.size}`);
if (zip.length < 10_000) throw new Error(`zip suspiciously small: ${zip.length} bytes`);

console.log(`DENO SMOKE OK — ${plotCount} plots, ${rates.size} rates, zip ${zip.length} bytes`);
