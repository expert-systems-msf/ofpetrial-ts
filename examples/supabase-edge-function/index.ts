// Example Supabase Edge Function (Deno) generating an on-farm trial design.
// Deploy: supabase functions deploy make-trial --no-verify-jwt
// Local smoke run (from the repo root, after `bun run build`):
//   deno run --allow-read tools/deno-smoke.ts
//
// POST body: { boundary: Feature<Polygon>, abLine: Feature<LineString> }
// Response: the assigned trial design (GeoJSON per input) + a base64 zip of
// the shapefile export.
import {
  assignRates,
  makeExpPlots,
  prepPlot,
  prepRate,
  writeTrialFiles,
} from "npm:ofpetrial-ts";

Deno.serve(async (req) => {
  const { boundary, abLine } = await req.json();

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

  const layout = makeExpPlots({ inputPlotInfo: [plotInfo], boundary, abLine });
  const design = assignRates(layout, [rateInfo], { seed: 20260702 });

  const zip = writeTrialFiles(design, { ext: "shp" });

  return new Response(
    JSON.stringify({
      inputs: design.inputs.map((i) => ({
        inputName: i.plotInfo.input_name,
        plots: i.plots,
      })),
      shapefileZipBase64: btoa(String.fromCharCode(...zip)),
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});
