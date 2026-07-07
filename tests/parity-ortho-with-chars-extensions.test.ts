// Golden-master parity for the two checkOrthoWithChars scope extensions vs R
// ofpetrial 0.1.3 (diagnose.R's summarize_chars / summarize_indiv_char):
//
// - Raster (SpatRaster) branch: terra::extract(raster, rate_design,
//   fun = mean, na.rm = TRUE) over the FULL trial design, then an unweighted
//   cor(use = "complete.obs") between rate and the per-plot mean — a
//   per-polygon computation, unlike the vector-fragment path.
// - Character/factor branch: summarize_indiv_char's `var_class %in%
//   c("character", "factor")` case — unweighted rate_mean/rate_sd (sample
//   sd, n - 1) by class, over the same st_intersection fragments as the
//   numeric path.
//
// Kept in its own file (rather than extending parity-diagnostics.test.ts) to
// avoid touching that file's existing describe blocks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Feature, FeatureCollection, LineString } from "geojson";
import { checkOrthoWithChars, extractRasterMeans } from "../src/diagnostics.js";
import type { RasterSoilData } from "../src/diagnostics.js";
import { readGeoTiffRaster } from "../src/raster.js";
import type { RasterGrid } from "../src/raster.js";
import { ValidationError } from "../src/types.js";
import { loadTrialDesign } from "./exports-fixtures.js";
import type { InputDesign, PlotInfo, SoilFragment, TrialDesign } from "../src/types.js";
import { relClose } from "../test-cases-runner/compare.js";

const ROOT = join(import.meta.dirname, "..");

function load<T>(relPath: string): T {
  return JSON.parse(readFileSync(join(ROOT, relPath), "utf8")) as T;
}

function loadBytes(relPath: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, relPath)));
}

const emptyAbLine: Feature<LineString> = {
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates: [] },
};

/** Splits a frozen trial-design.geojson fixture into plots/headlands FeatureCollections. */
function splitDesign(geojson: FeatureCollection): {
  plots: FeatureCollection;
  headlands: FeatureCollection;
} {
  const plots: Feature[] = [];
  const headlands: Feature[] = [];
  for (const f of geojson.features) {
    const type = (f.properties as { type: string }).type;
    (type === "headland" ? headlands : plots).push(f);
  }
  return {
    plots: { type: "FeatureCollection", features: plots },
    headlands: { type: "FeatureCollection", features: headlands },
  };
}

function buildTrialDesign(caseDir: string, inputName: string): TrialDesign {
  const plotInfo = load<PlotInfo[][]>(`${caseDir}/plot-info.json`)[0]![0]!;
  const geojson = load<FeatureCollection>(`${caseDir}/${inputName}/trial-design.geojson`);
  const { plots, headlands } = splitDesign(geojson);
  const input: InputDesign = {
    plotInfo,
    rateInfo: null,
    plots,
    headlands,
    abLine: emptyAbLine,
    guidanceLines: { type: "FeatureCollection", features: [] },
  };
  return { inputs: [input], seed: 20_260_702 };
}

const UNIT_SYSTEMS = ["imperial", "metric"] as const;

// !===========================================================
// ! Feature 1 — raster (SpatRaster) branch
// !===========================================================

interface RasterPlotMeanRow {
  plotKey: string;
  rate: number;
  mean: number;
}

interface RasterCorrelationRef {
  var: string;
  corWithRate: number;
}

describe("checkOrthoWithChars raster branch — precomputed means (1e-6)", () => {
  for (const unitSystem of UNIT_SYSTEMS) {
    it(`reproduces R's correlation from raster-plot-means.json for simple1/${unitSystem}`, () => {
      const caseDir = `fixtures/simple1/${unitSystem}`;
      const means = load<RasterPlotMeanRow[]>(`${caseDir}/seed/raster-plot-means.json`);
      const expected = load<RasterCorrelationRef>(`${caseDir}/seed/raster-correlations.json`);

      // Route through checkOrthoWithChars's SoilFragment[] mode: identical
      // pearsonCorrelation arithmetic to the raster path's own correlation
      // step, exercised here as pure arithmetic on R's own precomputed rows
      // (no geometry/extraction involved) — same rationale as the fragments
      // 1e-6 tests in parity-diagnostics.test.ts.
      const fragments: SoilFragment[] = means.map((m) => ({
        plotKey: m.plotKey,
        rate: m.rate,
        values: { [expected.var]: m.mean },
      }));
      const plotInfo = load<PlotInfo[][]>(`${caseDir}/plot-info.json`)[0]![0]!;
      const stubTd: TrialDesign = {
        inputs: [
          {
            plotInfo,
            rateInfo: null,
            plots: { type: "FeatureCollection", features: [] },
            headlands: { type: "FeatureCollection", features: [] },
            abLine: emptyAbLine,
            guidanceLines: { type: "FeatureCollection", features: [] },
          },
        ],
        seed: 0,
      };

      const result = checkOrthoWithChars(stubTd, fragments, [expected.var]);
      const actual = result[0]!.correlations[0]!.corWithRate;
      expect(
        relClose(actual, expected.corWithRate, 1e-6),
        `${actual} vs ${expected.corWithRate}`
      ).toBe(true);
    });
  }
});

describe("checkOrthoWithChars raster branch — full TS GeoTIFF path (1e-3)", () => {
  for (const unitSystem of UNIT_SYSTEMS) {
    it(`matches R's per-plot means and correlation for simple1/${unitSystem} (extractRasterMeans)`, async () => {
      const caseDir = `fixtures/simple1/${unitSystem}`;
      const rasterBytes = loadBytes("fixtures/slope.tif");
      const raster = await readGeoTiffRaster(rasterBytes);

      const expectedMeans = load<RasterPlotMeanRow[]>(`${caseDir}/seed/raster-plot-means.json`);
      const expectedCor = load<RasterCorrelationRef>(`${caseDir}/seed/raster-correlations.json`);

      // Pass the frozen trial-design.geojson directly: its feature order is
      // exactly the R trial_design row order raster-plot-means.json was
      // exported in, so rows can be compared by index position (a Map keyed
      // on plotKey would collapse duplicate keys, e.g. multiple "headland"
      // rows on multi-piece headlands).
      const design = load<FeatureCollection>(`${caseDir}/seed/trial-design.geojson`);
      const actualMeans = extractRasterMeans(design, raster);
      expect(actualMeans).toHaveLength(expectedMeans.length);

      let mismatched = 0;
      for (const [index, e] of expectedMeans.entries()) {
        const a = actualMeans[index]!;
        expect(a.plotKey, `plotKey order mismatch at row ${index}`).toBe(e.plotKey);
        expect(a.rate, `rate mismatch at row ${index} (${e.plotKey})`).toBe(e.rate);
        if (!relClose(a.mean, e.mean, 1e-3)) mismatched += 1;
      }
      const mismatchRatio = mismatched / actualMeans.length;
      expect(
        mismatchRatio,
        `${mismatched}/${actualMeans.length} plots (${(mismatchRatio * 100).toFixed(2)}%) have a ` +
          "differing cell-center mean beyond 1e-3 relative — investigate if this exceeds 2%"
      ).toBeLessThanOrEqual(0.02);

      const actualCor = pearsonOf(actualMeans);
      expect(
        relClose(actualCor, expectedCor.corWithRate, 1e-3),
        `${actualCor} vs ${expectedCor.corWithRate}`
      ).toBe(true);
    });

    it(`checkOrthoWithChars's raster soilData variant matches R for simple1/${unitSystem}`, async () => {
      const caseDir = `fixtures/simple1/${unitSystem}`;
      const td = buildTrialDesign(caseDir, "seed");
      const raster = await readGeoTiffRaster(loadBytes("fixtures/slope.tif"));
      const expectedCor = load<RasterCorrelationRef>(`${caseDir}/seed/raster-correlations.json`);

      const soilData: RasterSoilData = { raster, variable: "slope" };
      const result = checkOrthoWithChars(td, soilData, ["slope"]);

      expect(result).toHaveLength(1);
      expect(result[0]!.factorSummaries).toEqual([]);
      expect(result[0]!.correlations).toHaveLength(1);
      expect(result[0]!.correlations[0]!.var).toBe("slope");
      expect(relClose(result[0]!.correlations[0]!.corWithRate, expectedCor.corWithRate, 1e-3)).toBe(
        true
      );
    });
  }

  it("rejects a vars list that doesn't match the raster's single variable", async () => {
    const caseDir = "fixtures/simple1/imperial";
    const td = buildTrialDesign(caseDir, "seed");
    const raster = await readGeoTiffRaster(loadBytes("fixtures/slope.tif"));
    const soilData: RasterSoilData = { raster, variable: "slope" };
    expect(() => checkOrthoWithChars(td, soilData, ["not_slope"])).toThrow(/slope/);
  });
});

// !===========================================================
// ! extractRasterMeans unit tests — orientation & CRS guards
// !===========================================================

/**
 * 2x2 synthetic grid over bbox [0,0]..[2,2] (WGS84), cell centers at
 * x in {0.5, 1.5}, y in {0.5, 1.5}. Geographic values:
 *   north row (y=1.5): 10 (west), 20 (east)
 *   south row (y=0.5): 30 (west), 40 (east)
 */
function syntheticGrid(orientation: "north-up" | "south-up"): RasterGrid {
  const northUp = orientation === "north-up";
  return {
    width: 2,
    height: 2,
    bbox: [0, 0, 2, 2],
    xres: 1,
    // Signed y-resolution: negative = row 0 at maxY, positive = row 0 at minY.
    yres: northUp ? -1 : 1,
    northUp,
    // Row-major storage flips with orientation for the SAME geographic scene.
    data: northUp ? new Float64Array([10, 20, 30, 40]) : new Float64Array([30, 40, 10, 20]),
    epsg: 4326,
  };
}

/** Rectangle polygon design feature covering [x0,y0]..[x1,y1]. */
function rectDesign(x0: number, y0: number, x1: number, y1: number): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { rate: 1, strip_id: 1, plot_id: 1 },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [x0, y0],
              [x1, y0],
              [x1, y1],
              [x0, y1],
              [x0, y0],
            ],
          ],
        },
      },
    ],
  };
}

describe("extractRasterMeans orientation and CRS guards", () => {
  it("south-up raster (positive yres) yields the same geographic means as its north-up twin", () => {
    // Upper half (y 1..2) contains only the north-row centers (y=1.5): 10, 20.
    const upperHalf = rectDesign(0, 1, 2, 2);
    // Lower half (y 0..1) contains only the south-row centers (y=0.5): 30, 40.
    const lowerHalf = rectDesign(0, 0, 2, 1);

    for (const orientation of ["north-up", "south-up"] as const) {
      const grid = syntheticGrid(orientation);
      expect(extractRasterMeans(upperHalf, grid)[0]!.mean, `${orientation} upper half`).toBe(15);
      expect(extractRasterMeans(lowerHalf, grid)[0]!.mean, `${orientation} lower half`).toBe(35);
    }
  });

  it("full-extent polygon averages all four cells regardless of orientation", () => {
    const full = rectDesign(0, 0, 2, 2);
    expect(extractRasterMeans(full, syntheticGrid("north-up"))[0]!.mean).toBe(25);
    expect(extractRasterMeans(full, syntheticGrid("south-up"))[0]!.mean).toBe(25);
  });

  it("throws ValidationError when the raster carries no CRS (epsg: null)", () => {
    const grid = { ...syntheticGrid("north-up"), epsg: null };
    expect(() => extractRasterMeans(rectDesign(0, 0, 2, 2), grid)).toThrow(ValidationError);
    expect(() => extractRasterMeans(rectDesign(0, 0, 2, 2), grid)).toThrow(/georeferenced/);
  });

  it("throws ValidationError on a non-WGS84, non-UTM raster CRS", () => {
    const grid = { ...syntheticGrid("north-up"), epsg: 3857 };
    const act = () => extractRasterMeans(rectDesign(0, 0, 2, 2), grid);
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/unsupported raster CRS/);
    expect(act).toThrow(/3857/);
  });
});

function pearsonOf(rows: Array<{ rate: number; mean: number }>): number {
  const pairs = rows
    .map((r) => ({ x: r.rate, y: r.mean }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = pairs.length;
  const mx = pairs.reduce((s, p) => s + p.x, 0) / n;
  const my = pairs.reduce((s, p) => s + p.y, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (const { x, y } of pairs) {
    cov += (x - mx) * (y - my);
    vx += (x - mx) ** 2;
    vy += (y - my) ** 2;
  }
  return cov / Math.sqrt(vx * vy);
}

// !===========================================================
// ! Feature 2 — character/factor branch
// !===========================================================

interface FactorFragmentRow {
  plotKey: string;
  rate: number;
  musym: string;
}

interface FactorSummaryRow {
  class: string;
  rateMean: number;
  rateSd: number;
}

function loadFactorFragments(relPath: string): SoilFragment[] {
  const rows = load<FactorFragmentRow[]>(relPath);
  return rows.map((row) => ({
    plotKey: row.plotKey,
    rate: row.rate,
    values: { musym: row.musym },
  }));
}

describe("checkOrthoWithChars factor branch — precomputed fragments (1e-6)", () => {
  for (const unitSystem of UNIT_SYSTEMS) {
    it(`matches R's per-class rate_mean/rate_sd for simple1/${unitSystem}`, () => {
      const caseDir = `fixtures/simple1/${unitSystem}`;
      const fragments = loadFactorFragments(`${caseDir}/seed/factor-fragments.json`);
      const expected = load<FactorSummaryRow[]>(`${caseDir}/seed/factor-summary.json`);
      const plotInfo = load<PlotInfo[][]>(`${caseDir}/plot-info.json`)[0]![0]!;

      const stubTd: TrialDesign = {
        inputs: [
          {
            plotInfo,
            rateInfo: null,
            plots: { type: "FeatureCollection", features: [] },
            headlands: { type: "FeatureCollection", features: [] },
            abLine: emptyAbLine,
            guidanceLines: { type: "FeatureCollection", features: [] },
          },
        ],
        seed: 0,
      };

      const result = checkOrthoWithChars(stubTd, fragments, ["musym"]);
      expect(result[0]!.correlations).toEqual([]);
      expect(result[0]!.factorSummaries).toHaveLength(1);
      const classes = result[0]!.factorSummaries[0]!.classes;
      expect(classes).toHaveLength(expected.length);

      for (const e of expected) {
        const a = classes.find((c) => c.class === e.class);
        expect(a, `missing class ${e.class}`).toBeDefined();
        expect(relClose(a!.rateMean, e.rateMean, 1e-6), `${e.class} rateMean`).toBe(true);
        expect(relClose(a!.rateSd, e.rateSd, 1e-6), `${e.class} rateSd`).toBe(true);
      }
    });
  }
});

describe("checkOrthoWithChars factor branch — full TS spatialJoin (1e-3)", () => {
  it("matches R's per-class rate_mean/rate_sd for simple1/imperial via a full TS spatial join", () => {
    const caseDir = "fixtures/simple1/imperial";
    const td = buildTrialDesign(caseDir, "seed");
    const soilLayer = load<FeatureCollection>("fixtures/ssurgo-simple1.geojson");
    const expected = load<FactorSummaryRow[]>(`${caseDir}/seed/factor-summary.json`);

    const result = checkOrthoWithChars(td, soilLayer, ["musym"]);
    expect(result[0]!.correlations).toEqual([]);
    expect(result[0]!.factorSummaries).toHaveLength(1);
    const classes = result[0]!.factorSummaries[0]!.classes;

    const expectedClasses = new Set(expected.map((e) => e.class));
    const actualClasses = new Set(classes.map((c) => c.class));
    expect(actualClasses).toEqual(expectedClasses);

    for (const e of expected) {
      const a = classes.find((c) => c.class === e.class)!;
      expect(relClose(a.rateMean, e.rateMean, 1e-3), `${e.class} rateMean`).toBe(true);
      expect(relClose(a.rateSd, e.rateSd, 1e-3), `${e.class} rateSd`).toBe(true);
    }
  });
});

describe("checkOrthoWithChars mixed numeric + factor vars", () => {
  it("splits correlations (numeric) and factorSummaries (character) for the same call", () => {
    const caseDir = "fixtures/simple1/imperial";
    const plotInfo = load<PlotInfo[][]>(`${caseDir}/plot-info.json`)[0]![0]!;
    const numericFragments = load<Array<Record<string, unknown>>>(`${caseDir}/seed/fragments.json`);
    const factorFragments = load<FactorFragmentRow[]>(`${caseDir}/seed/factor-fragments.json`);
    // Both tables are derived from the same st_intersection over the same
    // design/soil pair, so keying by plotKey lines them up; only clay + musym
    // are used to keep the stub small.
    const factorByKey = new Map<string, string>();
    for (const row of factorFragments)
      if (!factorByKey.has(row.plotKey)) factorByKey.set(row.plotKey, row.musym);

    const fragments: SoilFragment[] = numericFragments.map((row) => ({
      plotKey: row.plotKey as string,
      rate: row.rate as number,
      values: {
        clay: row.clay as number,
        musym: factorByKey.get(row.plotKey as string) ?? "unknown",
      },
    }));

    const stubTd: TrialDesign = {
      inputs: [
        {
          plotInfo,
          rateInfo: null,
          plots: { type: "FeatureCollection", features: [] },
          headlands: { type: "FeatureCollection", features: [] },
          abLine: emptyAbLine,
          guidanceLines: { type: "FeatureCollection", features: [] },
        },
      ],
      seed: 0,
    };

    const result = checkOrthoWithChars(stubTd, fragments, ["clay", "musym"]);
    expect(result[0]!.correlations).toHaveLength(1);
    expect(result[0]!.correlations[0]!.var).toBe("clay");
    expect(result[0]!.factorSummaries).toHaveLength(1);
    expect(result[0]!.factorSummaries[0]!.var).toBe("musym");
  });
});

describe("SoilFragment shape validation (DX)", () => {
  it("rejects flat fragment rows with a ValidationError explaining the mapping", () => {
    const td = loadTrialDesign("simple1", "imperial", ["seed"]);
    const flatRows = [{ plotKey: "1:1", rate: 34_000, clay: 25.1 }] as unknown as SoilFragment[];
    expect(() => checkOrthoWithChars(td, flatRows, ["clay"])).toThrow(ValidationError);
    expect(() => checkOrthoWithChars(td, flatRows, ["clay"])).toThrow(/values/);
  });
});
