// Golden-master parity for design diagnostics (tasks 6.1-6.4):
// checkAlignment, checkOrthoInputs, spatialJoin, checkOrthoWithChars.
//
// Every check is tested in two layers:
// - spec-level 1e-6 parity on the R-precomputed fragment tables
//   (alignment-fragments.json / ortho-fragments.json / fragments.json) via
//   each function's precomputed input mode — pure arithmetic on the same
//   rows R aggregated, no geometry engine in the loop;
// - integration-level checks of the full TS geometry path (live
//   @turf/intersect joins) at LIVE_JOIN_TOL (see below).
//
// TrialDesign objects are built directly from the frozen R fixtures
// (trial-design.geojson split by `type`, plot-info.json, harvester-ab-line.geojson)
// rather than by re-running makeExpPlots/assignRates: the checks only need
// geometry + rates that R already froze, and using R's exact geometry
// (instead of our ~99%-overlap reconstruction) gives the tightest possible
// parity signal for the integration layer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Feature, FeatureCollection, LineString } from "geojson";
import {
  checkAlignment,
  checkOrthoInputs,
  checkOrthoWithChars,
  spatialJoin,
} from "../src/diagnostics.js";
import type {
  AlignmentFragment,
  AlignmentOverlapRow,
  OrthoInputsFragment,
} from "../src/diagnostics.js";
import { assignRates } from "../src/rate-assignment.js";
import { ValidationError } from "../src/types.js";
import type { InputDesign, PlotInfo, RateInfo, SoilFragment, TrialDesign } from "../src/types.js";
import { relClose } from "../test-cases-runner/compare.js";

const ROOT = join(import.meta.dirname, "..");

function load<T>(relPath: string): T {
  return JSON.parse(readFileSync(join(ROOT, relPath), "utf8")) as T;
}

/**
 * The R fixture's fragments.json rows are flat (`{plotKey, rate, mukey, clay, ...}`,
 * mirroring a data.frame) — reshape into SoilFragment's `values` record.
 */
function loadFragments(relPath: string): SoilFragment[] {
  const rows = load<Array<Record<string, unknown>>>(relPath);
  return rows.map((row) => {
    const { plotKey, rate, ...values } = row;
    return {
      plotKey: plotKey as string,
      rate: rate as number,
      values: values as Record<string, number>,
    };
  });
}

const emptyAbLine: Feature<LineString> = {
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates: [] },
};

/** Builds an InputDesign straight from the frozen per-input fixtures (no RNG involved). */
function inputDesignFromFixture(
  caseDir: string,
  inputName: string,
  plotInfo: PlotInfo
): InputDesign {
  const geojson = load<FeatureCollection>(`${caseDir}/${inputName}/trial-design.geojson`);
  const plots: Feature[] = [];
  const headlands: Feature[] = [];
  for (const f of geojson.features) {
    const type = (f.properties as { type: string }).type;
    (type === "headland" ? headlands : plots).push(f);
  }
  const guidanceLines = load<FeatureCollection>(
    `${caseDir}/${inputName}/harvester-ab-line.geojson`
  );
  return {
    plotInfo,
    rateInfo: null,
    plots: { type: "FeatureCollection", features: plots },
    headlands: { type: "FeatureCollection", features: headlands },
    abLine: emptyAbLine,
    guidanceLines,
  };
}

function trialDesignFromFixture(caseDir: string, inputNames: string[]): TrialDesign {
  const plotInfos = load<PlotInfo[][]>(`${caseDir}/plot-info.json`);
  const inputs = inputNames.map((name, index) =>
    inputDesignFromFixture(caseDir, name, plotInfos[index]![0]!)
  );
  return { inputs, seed: 20_260_702 };
}

// Integration-level tolerance for the LIVE geometry path only: these tests
// re-derive UTM meters from WGS84 fixtures (proj4 vs R's PROJ) and clip with
// @turf/intersect (vs R's GEOS), which produces ~2e-4 relative area noise.
// To be explicit: design.md D9 does NOT sanction 1e-3 for checkAlignment or
// checkOrthoInputs — their spec-level 1e-6 requirement is covered by the
// precomputed-fragments tests below (pure arithmetic on R's own fragment
// rows). The live tests are kept as integration coverage of the TS geometry
// path, where 1e-6 is unreachable by construction across geometry engines.
const LIVE_JOIN_TOL = 1e-3;

/**
 * Live-mode comparison: row-by-row after verifying a *constant* ha_strip_id
 * offset. The ordering itself is a provable invariant (the p90 sign flip vs
 * R's rotate_mat_p90 cancels against the grid-index iteration direction —
 * see alignmentForInput's docstring); only the absolute labels can shift by
 * a constant when a zero-area sliver strip at the field edge survives in one
 * geometry engine and not the other. Every numeric metric must still match
 * within LIVE_JOIN_TOL. The precomputed-mode tests below match R's labels
 * exactly, with no offset allowance.
 */
function expectAlignmentMatches(
  actual: AlignmentOverlapRow[],
  expected: AlignmentOverlapRow[]
): void {
  expect(actual.length).toBe(expected.length);
  expect(actual.length).toBeGreaterThan(0);
  const offset = actual[0]!.ha_strip_id - expected[0]!.ha_strip_id;
  for (const [index, element] of expected.entries()) {
    const a = actual[index]!;
    const e = element!;
    expect(a.ha_strip_id - offset, `ha_strip_id offset consistency at row ${index}`).toBe(
      e.ha_strip_id
    );
    expect(a.strip_id, `strip_id at row ${index}`).toBe(e.strip_id);
    expect(
      relClose(a.area, e.area, LIVE_JOIN_TOL),
      `area at row ${index}: ${a.area} vs ${e.area}`
    ).toBe(true);
    expect(relClose(a.ha_area, e.ha_area, LIVE_JOIN_TOL), `ha_area at row ${index}`).toBe(true);
    expect(
      relClose(a.total_intersecting_ha_area, e.total_intersecting_ha_area, LIVE_JOIN_TOL),
      `total_intersecting_ha_area at row ${index}`
    ).toBe(true);
    expect(
      relClose(a.intersecting_pct, e.intersecting_pct, LIVE_JOIN_TOL),
      `intersecting_pct at row ${index}`
    ).toBe(true);
    expect(
      relClose(a.dominant_pct, e.dominant_pct, LIVE_JOIN_TOL),
      `dominant_pct at row ${index}`
    ).toBe(true);
  }
}

const UNIT_SYSTEMS = ["imperial", "metric"] as const;

const ALL_CASES: Array<{ name: string; inputNames: string[] }> = [
  { name: "simple1", inputNames: ["seed"] },
  { name: "two-input", inputNames: ["seed", "NH3"] },
  { name: "with-holes", inputNames: ["seed"] },
];

/** Exact-row comparison for the precomputed mode: same R rows in, 1e-6 out. */
function expectAlignmentExact(
  actual: AlignmentOverlapRow[],
  expected: AlignmentOverlapRow[]
): void {
  expect(actual.length).toBe(expected.length);
  for (const [index, element] of expected.entries()) {
    const a = actual[index]!;
    const e = element!;
    expect(a.ha_strip_id, `ha_strip_id at row ${index}`).toBe(e.ha_strip_id);
    expect(a.strip_id, `strip_id at row ${index}`).toBe(e.strip_id);
    for (const col of [
      "area",
      "ha_area",
      "total_intersecting_ha_area",
      "intersecting_pct",
      "dominant_pct",
    ] as const) {
      expect(relClose(a[col], e[col], 1e-6), `${col} at row ${index}: ${a[col]} vs ${e[col]}`).toBe(
        true
      );
    }
  }
}

// !===========================================================
// ! 6.1 checkAlignment — precomputed fragments (spec-level, 1e-6)
// !===========================================================

describe("checkAlignment parity with R — precomputed fragments (task 6.1, 1e-6)", () => {
  for (const testCase of ALL_CASES) {
    for (const unitSystem of UNIT_SYSTEMS) {
      it(`matches R's overlapData exactly for ${testCase.name}/${unitSystem}`, () => {
        const caseDir = `fixtures/${testCase.name}/${unitSystem}`;
        const td = trialDesignFromFixture(caseDir, testCase.inputNames);
        const fragments = testCase.inputNames.map((name) =>
          load<AlignmentFragment[]>(`${caseDir}/${name}/alignment-fragments.json`)
        );
        const expected = load<{
          alignment: Array<{ inputName: string; overlapData: AlignmentOverlapRow[] }>;
        }>(`${caseDir}/checks.json`);

        const result = checkAlignment(td, fragments);
        expect(result).toHaveLength(testCase.inputNames.length);
        result.forEach((r, index) => {
          expect(r.inputName).toBe(expected.alignment[index]!.inputName);
          expectAlignmentExact(r.overlapData, expected.alignment[index]!.overlapData);
        });
      });
    }
  }

  it("throws ValidationError when the fragment table count does not match the inputs", () => {
    const td = trialDesignFromFixture("fixtures/simple1/imperial", ["seed"]);
    const act = () => checkAlignment(td, []);
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/checkAlignment received/);
  });
});

// !===========================================================
// ! 6.1 checkAlignment — live geometry (integration)
// !===========================================================

describe("checkAlignment live-geometry integration (task 6.1)", () => {
  for (const unitSystem of UNIT_SYSTEMS) {
    it(`matches R's overlapData for simple1/${unitSystem}`, () => {
      const caseDir = `fixtures/simple1/${unitSystem}`;
      const td = trialDesignFromFixture(caseDir, ["seed"]);
      const expected = load<{
        alignment: Array<{ inputName: string; overlapData: AlignmentOverlapRow[] }>;
      }>(`${caseDir}/checks.json`);

      const result = checkAlignment(td);
      expect(result).toHaveLength(1);
      expect(result[0]!.inputName).toBe("seed");
      expectAlignmentMatches(result[0]!.overlapData, expected.alignment[0]!.overlapData);
    });
  }

  it("matches R's overlapData for both inputs of two-input/imperial", () => {
    const caseDir = "fixtures/two-input/imperial";
    const td = trialDesignFromFixture(caseDir, ["seed", "NH3"]);
    const expected = load<{
      alignment: Array<{ inputName: string; overlapData: AlignmentOverlapRow[] }>;
    }>(`${caseDir}/checks.json`);

    const result = checkAlignment(td);
    expect(result).toHaveLength(2);
    for (let index = 0; index < 2; index++) {
      expect(result[index]!.inputName).toBe(expected.alignment[index]!.inputName);
      expectAlignmentMatches(result[index]!.overlapData, expected.alignment[index]!.overlapData);
    }
  });
});

// !===========================================================
// ! 6.2 checkOrthoInputs — precomputed fragments (spec-level, 1e-6)
// !===========================================================

describe("checkOrthoInputs parity with R — precomputed fragments (task 6.2, 1e-6)", () => {
  for (const unitSystem of UNIT_SYSTEMS) {
    it(`matches R's weighted correlation for two-input/${unitSystem}`, () => {
      const caseDir = `fixtures/two-input/${unitSystem}`;
      const td = trialDesignFromFixture(caseDir, ["seed", "NH3"]);
      const fragments = load<OrthoInputsFragment[]>(`${caseDir}/ortho-fragments.json`);
      const expected = load<{ orthoInputs: number }>(`${caseDir}/checks.json`).orthoInputs;

      const actual = checkOrthoInputs(td, fragments);
      expect(relClose(actual, expected, 1e-6), `${actual} vs ${expected}`).toBe(true);
    });
  }
});

// !===========================================================
// ! 6.2 checkOrthoInputs — live geometry (integration)
// !===========================================================

describe("checkOrthoInputs live-geometry integration (task 6.2)", () => {
  for (const unitSystem of UNIT_SYSTEMS) {
    it(`matches R's weighted correlation for two-input/${unitSystem}`, () => {
      const caseDir = `fixtures/two-input/${unitSystem}`;
      const td = trialDesignFromFixture(caseDir, ["seed", "NH3"]);
      const expected = load<{ orthoInputs: number }>(`${caseDir}/checks.json`).orthoInputs;

      const actual = checkOrthoInputs(td);
      // Live @turf/intersect join over reprojected geometry (see
      // LIVE_JOIN_TOL above) — R's cov.wt is area-weighted, so it inherits
      // the same geometry-engine noise as checkAlignment's live areas.
      expect(relClose(actual, expected, LIVE_JOIN_TOL), `${actual} vs ${expected}`).toBe(true);
    });
  }

  it("throws ValidationError on a single-input design (R: cor_input never assigned)", () => {
    const caseDir = "fixtures/simple1/imperial";
    const td = trialDesignFromFixture(caseDir, ["seed"]);
    const act = () => checkOrthoInputs(td);
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/requires a two-input trial design/);
  });
});

// !===========================================================
// ! 6.3 spatialJoin + checkOrthoWithChars
// !===========================================================

const SOIL_VARS = ["mukey", "clay", "sand", "silt", "wtr_str"];

describe("checkOrthoWithChars parity with R — precomputed fragments (task 6.3a, 1e-6)", () => {
  for (const unitSystem of UNIT_SYSTEMS) {
    it(`matches R's correlations for simple1/${unitSystem}/seed`, () => {
      const caseDir = `fixtures/simple1/${unitSystem}`;
      const fragments = loadFragments(`${caseDir}/seed/fragments.json`);
      const expected = load<Array<{ var: string; corWithRate: number }>>(
        `${caseDir}/seed/correlations.json`
      );
      const plotInfo = load<PlotInfo[][]>(`${caseDir}/plot-info.json`)[0]![0]!;

      const td: TrialDesign = {
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
        seed: 20_260_702,
      };

      const result = checkOrthoWithChars(td, fragments, SOIL_VARS);
      expect(result).toHaveLength(1);
      expect(result[0]!.correlations).toHaveLength(expected.length);
      for (const e of expected) {
        const a = result[0]!.correlations.find((c) => c.var === e.var);
        expect(a, `missing correlation for ${e.var}`).toBeDefined();
        expect(
          relClose(a!.corWithRate, e.corWithRate, 1e-6),
          `${e.var}: ${a!.corWithRate} vs ${e.corWithRate}`
        ).toBe(true);
      }
    });
  }

  it("matches R's correlations for two-input/imperial/NH3", () => {
    const caseDir = "fixtures/two-input/imperial";
    const fragments = loadFragments(`${caseDir}/NH3/fragments.json`);
    const expected = load<Array<{ var: string; corWithRate: number }>>(
      `${caseDir}/NH3/correlations.json`
    );
    const plotInfo = load<PlotInfo[][]>(`${caseDir}/plot-info.json`)[1]![0]!;

    const td: TrialDesign = {
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
      seed: 20_260_702,
    };

    const result = checkOrthoWithChars(td, fragments, SOIL_VARS);
    for (const e of expected) {
      const a = result[0]!.correlations.find((c) => c.var === e.var);
      expect(relClose(a!.corWithRate, e.corWithRate, 1e-6)).toBe(true);
    }
  });
});

describe("spatialJoin + checkOrthoWithChars integration (task 6.3b, 1e-3)", () => {
  it("matches R's correlations for simple1/imperial/seed via a full TS spatial join", () => {
    const caseDir = "fixtures/simple1/imperial";
    const designGeojson = load<FeatureCollection>(`${caseDir}/seed/trial-design.geojson`);
    const soilLayer = load<FeatureCollection>("fixtures/ssurgo-simple1.geojson");
    const expected = load<Array<{ var: string; corWithRate: number }>>(
      `${caseDir}/seed/correlations.json`
    );
    const plotInfo = load<PlotInfo[][]>(`${caseDir}/plot-info.json`)[0]![0]!;

    const plots: Feature[] = [];
    const headlands: Feature[] = [];
    for (const f of designGeojson.features) {
      const type = (f.properties as { type: string }).type;
      (type === "headland" ? headlands : plots).push(f);
    }
    const td: TrialDesign = {
      inputs: [
        {
          plotInfo,
          rateInfo: null,
          plots: { type: "FeatureCollection", features: plots },
          headlands: { type: "FeatureCollection", features: headlands },
          abLine: emptyAbLine,
          guidanceLines: { type: "FeatureCollection", features: [] },
        },
      ],
      seed: 20_260_702,
    };

    const result = checkOrthoWithChars(td, soilLayer, SOIL_VARS);
    expect(result[0]!.correlations).toHaveLength(expected.length);
    for (const e of expected) {
      const a = result[0]!.correlations.find((c) => c.var === e.var);
      expect(a, `missing correlation for ${e.var}`).toBeDefined();
      expect(
        relClose(a!.corWithRate, e.corWithRate, 1e-3),
        `${e.var}: ${a!.corWithRate} vs ${e.corWithRate}`
      ).toBe(true);
    }
  });

  it("spatialJoin returns [] on with-holes (soil layer does not cover that boundary)", () => {
    const caseDir = "fixtures/with-holes/imperial";
    const designGeojson = load<FeatureCollection>(`${caseDir}/seed/trial-design.geojson`);
    const soilLayer = load<FeatureCollection>("fixtures/ssurgo-simple1.geojson");

    const fragments = spatialJoin(designGeojson, soilLayer);
    expect(fragments).toEqual([]);
  });

  // Regression for audit M5: type/presence must be decided over the whole
  // column, not from the first feature. A GDAL/sf layer serialises an NA as
  // JSON null, so a numeric variable that is null on the FIRST feature must
  // still be treated as a numeric correlation, not rejected as "not found".
  it("M5: a leading null value does not reject a numeric column (FeatureCollection mode)", () => {
    const caseDir = "fixtures/simple1/imperial";
    const designGeojson = load<FeatureCollection>(`${caseDir}/seed/trial-design.geojson`);
    const soilLayer = load<FeatureCollection>("fixtures/ssurgo-simple1.geojson");
    const plotInfo = load<PlotInfo[][]>(`${caseDir}/plot-info.json`)[0]![0]!;

    // null out `clay` on the FIRST feature only
    const patched: FeatureCollection = {
      type: "FeatureCollection",
      features: soilLayer.features.map((f, i) =>
        i === 0 ? { ...f, properties: { ...f.properties, clay: null } } : f
      ),
    };

    const plots: Feature[] = [];
    const headlands: Feature[] = [];
    for (const f of designGeojson.features) {
      const type = (f.properties as { type: string }).type;
      (type === "headland" ? headlands : plots).push(f);
    }
    const td: TrialDesign = {
      inputs: [
        {
          plotInfo,
          rateInfo: null,
          plots: { type: "FeatureCollection", features: plots },
          headlands: { type: "FeatureCollection", features: headlands },
          abLine: emptyAbLine,
          guidanceLines: { type: "FeatureCollection", features: [] },
        },
      ],
      seed: 1,
    };

    expect(() => checkOrthoWithChars(td, patched, ["clay"])).not.toThrow();
    const result = checkOrthoWithChars(td, patched, ["clay"]);
    const clay = result[0]!.correlations.find((c) => c.var === "clay");
    expect(
      clay,
      "clay must be a numeric correlation, not rejected or routed to factor"
    ).toBeDefined();
    expect(result[0]!.factorSummaries.find((s) => s.var === "clay")).toBeUndefined();
  });
});

describe("checkOrthoWithChars error cases (task 6.3)", () => {
  const plotInfo = load<PlotInfo[][]>("fixtures/simple1/imperial/plot-info.json")[0]![0]!;
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

  it("throws ValidationError when vars is empty", () => {
    const act = () => checkOrthoWithChars(stubTd, { type: "FeatureCollection", features: [] }, []);
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/requires a non-empty vars list/);
  });

  it("throws ValidationError naming the missing variable (FeatureCollection mode)", () => {
    const soilLayer = load<FeatureCollection>("fixtures/ssurgo-simple1.geojson");
    expect(() => checkOrthoWithChars(stubTd, soilLayer, ["not_a_real_column"])).toThrow(
      /not_a_real_column/
    );
  });

  it("throws ValidationError naming the missing variable (precomputed fragments mode)", () => {
    const fragments = loadFragments("fixtures/simple1/imperial/seed/fragments.json");
    expect(() => checkOrthoWithChars(stubTd, fragments, ["not_a_real_column"])).toThrow(
      /not_a_real_column/
    );
  });

  it("throws ValidationError on an empty soil layer (FeatureCollection mode)", () => {
    const act = () =>
      checkOrthoWithChars(stubTd, { type: "FeatureCollection", features: [] }, ["clay"]);
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/received an empty soil layer/);
  });

  it("throws ValidationError on an empty fragment table (precomputed mode)", () => {
    expect(() => checkOrthoWithChars(stubTd, [] as SoilFragment[], ["clay"])).toThrow(
      ValidationError
    );
  });
});

// !===========================================================
// ! 6.4 Cross-validation: assignRates-produced designs judged by the ported checks
// !===========================================================

interface CrossvalReference {
  seeds: number[];
  perVar: Record<string, { min: number; max: number }>;
}

describe("cross-validation: assignRates designs stay within R's reference range (task 6.4)", () => {
  it("checkOrthoWithChars correlations stay within the 10-seed R envelope across 5 seeds on the simple1 layout", () => {
    // Each seed re-runs a full spatial join (~380 design fragments x 11 soil
    // features): comfortably under the default 5 s timeout individually, but
    // 5 of them in one test need more headroom.
    const caseDir = "fixtures/simple1/imperial";
    // R reference envelope: per-var min/max of check_ortho_with_chars
    // correlations over 10 R assign_rates designs (seeds 1:10) on this same
    // layout — generated by tools/gen-crossval-fixture.R. The +/- 0.05 margin
    // accounts for TS's different RNG (design.md D4: properties, not
    // sequences): TS seeds sample the same design distribution, not the same
    // designs, so its 5-seed values need not fall strictly inside the R
    // 10-seed min/max.
    const reference = load<CrossvalReference>("fixtures/crossval-reference.json");
    const MARGIN = 0.05;
    const designGeojson = load<FeatureCollection>(`${caseDir}/seed/trial-design.geojson`);
    const soilLayer = load<FeatureCollection>("fixtures/ssurgo-simple1.geojson");
    const plotInfo = load<PlotInfo[][]>(`${caseDir}/plot-info.json`)[0]![0]!;
    const rateInfo = load<RateInfo[][]>(`${caseDir}/rate-info.json`)[0]![0]!;

    // Geometry (plots/headlands) frozen from R; only the rate assignment is
    // ours, re-randomized per seed via assignRates' own layout-shaped input.
    const plots: Feature[] = [];
    const headlands: Feature[] = [];
    for (const f of designGeojson.features) {
      const type = (f.properties as { type: string }).type;
      (type === "headland" ? headlands : plots).push(f);
    }
    // Strip any frozen rate/rate_rank so assignRates treats this as a fresh layout.
    const layoutPlots = plots.map((f) => {
      const {
        rate: _rate,
        rate_rank: _rank,
        type: _type,
        ...rest
      } = f.properties as Record<string, unknown>;
      return { ...f, properties: rest };
    });

    for (const seed of [1, 2, 3, 4, 5]) {
      const expData = {
        inputs: [
          {
            plotInfo,
            plots: { type: "FeatureCollection" as const, features: layoutPlots },
            headlands: { type: "FeatureCollection" as const, features: headlands },
            abLine: emptyAbLine,
            guidanceLines: { type: "FeatureCollection" as const, features: [] },
          },
        ],
      };
      const td = assignRates(expData, rateInfo, { seed });

      const result = checkOrthoWithChars(td, soilLayer, SOIL_VARS);
      const correlations = result[0]!.correlations;
      // L18: without this guard an empty `correlations` (e.g. a proj4/turf
      // regression, or every variable mis-classified as a factor) would run
      // zero assertions below and the test would pass vacuously.
      expect(
        correlations.length,
        `seed ${seed}: expected ${Object.keys(reference.perVar).length} correlations, got ${correlations.length}`
      ).toBe(Object.keys(reference.perVar).length);
      for (const c of correlations) {
        const range = reference.perVar[c.var];
        expect(range, `var ${c.var} missing from crossval-reference.json`).toBeDefined();
        expect(
          c.corWithRate,
          `seed ${seed}, var ${c.var}: ${c.corWithRate} below R envelope [${range!.min}, ${range!.max}] - ${MARGIN}`
        ).toBeGreaterThanOrEqual(range!.min - MARGIN);
        expect(
          c.corWithRate,
          `seed ${seed}, var ${c.var}: ${c.corWithRate} above R envelope [${range!.min}, ${range!.max}] + ${MARGIN}`
        ).toBeLessThanOrEqual(range!.max + MARGIN);
        // Secondary sanity bound: the coarse absolute threshold from the
        // original task instructions. Much weaker than the R envelope above —
        // kept only as a tripwire in case the fixture is ever regenerated
        // with a degenerate range.
        expect(
          Math.abs(c.corWithRate),
          `seed ${seed}, var ${c.var}: |cor| sanity`
        ).toBeLessThanOrEqual(0.3);
      }
    }
  }, 30_000);
});
