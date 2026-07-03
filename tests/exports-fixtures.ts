// Builds TrialDesign objects (task 7's public input type) from the frozen
// R fixtures, for the export test suite. Reuses fixtures/<case>/<unit>/
// {plot-info,rate-info}.json (already snake_case, matching PlotInfo/RateInfo
// verbatim — see src/types.ts) and fixtures/<case>/<unit>/<inputName>/
// {trial-design,ab-line,harvester-ab-line}.geojson (frozen final design,
// already merged plots+headlands with rate/strip_id/plot_id/type props).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Feature, FeatureCollection, LineString } from "geojson";
import type { InputDesign, PlotInfo, RateInfo, TrialDesign } from "../src/types.js";

const ROOT = join(import.meta.dirname, "..");

function load<T>(relPath: string): T {
  return JSON.parse(readFileSync(join(ROOT, relPath), "utf8")) as T;
}

export function loadTrialDesign(
  caseDir: string,
  unit: "imperial" | "metric",
  inputNames: string[]
): TrialDesign {
  const plotInfoRaw = load<PlotInfo[][]>(`fixtures/${caseDir}/${unit}/plot-info.json`).flat();
  const rateInfoRaw = load<RateInfo[][]>(`fixtures/${caseDir}/${unit}/rate-info.json`).flat();

  const inputs: InputDesign[] = inputNames.map((inputName) => {
    const trialDesign = load<FeatureCollection>(
      `fixtures/${caseDir}/${unit}/${inputName}/trial-design.geojson`
    );
    const plots: FeatureCollection = {
      type: "FeatureCollection",
      features: trialDesign.features.filter((f) => f.properties?.["type"] === "experiment"),
    };
    const headlands: FeatureCollection = {
      type: "FeatureCollection",
      features: trialDesign.features.filter((f) => f.properties?.["type"] === "headland"),
    };
    const abLineFc = load<FeatureCollection>(
      `fixtures/${caseDir}/${unit}/${inputName}/ab-line.geojson`
    );
    const guidanceLines = load<FeatureCollection>(
      `fixtures/${caseDir}/${unit}/${inputName}/harvester-ab-line.geojson`
    );
    const plotInfo = plotInfoRaw.find((p) => p.input_name === inputName);
    if (!plotInfo) throw new Error(`no plot-info fixture for input "${inputName}"`);
    const rateInfo = rateInfoRaw.find((r) => r.input_name === inputName) ?? null;

    return {
      plotInfo,
      rateInfo,
      plots,
      headlands,
      abLine: abLineFc.features[0] as Feature<LineString>,
      guidanceLines,
    };
  });

  return { inputs, seed: 0 };
}
