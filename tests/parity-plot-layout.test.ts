// Golden-master parity: makeExpPlots against the frozen R fixtures
// (tasks 4.1-4.4). For every case x unit system, each TS plot polygon must
// overlap its R counterpart (matched by strip_id/plot_id) by >= 99% with
// centroids within 10 cm, and the (strip_id, plot_id) key sets must match.
//
// Duplicate keys: R restarts plot_id at 1 in each piece of a strip that a
// boundary hole splits in two, so on the with-holes case (strip_id, plot_id)
// is not unique — duplicates are paired by coordinate order, which is
// well-defined because the pieces of a strip never overlap.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
  MultiPolygon,
  Polygon,
} from "geojson";
import { makeExpPlots } from "../src/plot-layout.js";
import { prepPlot } from "../src/trial-setup.js";
import { GeometryError, ValidationError } from "../src/types.js";
import type { PlotInfo } from "../src/types.js";
import { centroidDistanceMeters, overlapRatio } from "../test-cases-runner/compare.js";
import { toUtm } from "../src/projection.js";

const ROOT = join(import.meta.dirname, "..");

interface FixtureParameters {
  input_name: string;
  machine_width: number;
  section_num: number;
  harvester_width: number;
}

const CASES = [
  {
    name: "simple1",
    boundary: "fixtures/boundary-simple1.geojson",
    abLine: "fixtures/ab-line-simple1.geojson",
  },
  {
    name: "two-input",
    boundary: "fixtures/boundary-simple1.geojson",
    abLine: "fixtures/ab-line-simple1.geojson",
  },
  {
    name: "with-holes",
    boundary: "fixtures/field-boundary-with-holes.geojson",
    abLine: "fixtures/ab-line-for-field-with-holes.geojson",
  },
] as const;

function load<T>(relPath: string): T {
  return JSON.parse(readFileSync(join(ROOT, relPath), "utf8")) as T;
}

type PolyFeature = Feature<Polygon | MultiPolygon>;

function plotKeyOf(f: PolyFeature): string {
  const properties = f.properties as { strip_id: number; plot_id: number };
  return `${properties.strip_id}:${properties.plot_id}`;
}

/** Groups plot features by (strip_id, plot_id), duplicates in coordinate order. */
function groupByKey(features: PolyFeature[]): Map<string, PolyFeature[]> {
  const firstCoord = (f: PolyFeature): number[] =>
    (f.geometry.type === "Polygon"
      ? f.geometry.coordinates[0]![0]
      : f.geometry.coordinates[0]![0]![0]) as number[];
  const map = new Map<string, PolyFeature[]>();
  for (const f of features) {
    const key = plotKeyOf(f);
    const list = map.get(key) ?? [];
    list.push(f);
    map.set(key, list);
  }
  for (const list of map.values()) {
    list.sort(
      (a, b) => firstCoord(a)[0]! - firstCoord(b)[0]! || firstCoord(a)[1]! - firstCoord(b)[1]!
    );
  }
  return map;
}

/** Both line endpoints within `tolMeters`, allowing a reversed vertex order. */
function lineEndpointsClose(
  ts: Feature<LineString | MultiLineString>,
  r: Feature<LineString>,
  tolMeters: number
): boolean {
  if (ts.geometry.type !== "LineString") return false; // multi-part: not an endpoint match
  const rc = r.geometry.coordinates;
  const tc = ts.geometry.coordinates;
  if (rc.length !== 2 || tc.length !== 2) return false;
  const { epsg } = toUtm([rc[0]![0]!, rc[0]![1]!]);
  const pts = (coords: typeof rc): Array<[number, number]> =>
    coords.map((c) => toUtm([c[0]!, c[1]!], epsg).point);
  const [r0, r1] = pts(rc);
  const [t0, t1] = pts(tc);
  const distribution = (a: [number, number], b: [number, number]): number =>
    Math.hypot(a[0] - b[0], a[1] - b[1]);
  const same = Math.max(distribution(t0!, r0!), distribution(t1!, r1!));
  const flipped = Math.max(distribution(t0!, r1!), distribution(t1!, r0!));
  return Math.min(same, flipped) <= tolMeters;
}

describe("makeExpPlots parity with R fixtures", () => {
  for (const testCase of CASES) {
    for (const unitSystem of ["imperial", "metric"] as const) {
      describe(`${testCase.name}/${unitSystem}`, () => {
        const dir = `fixtures/${testCase.name}/${unitSystem}`;
        const parameters = load<FixtureParameters[]>(`${dir}/params.json`);
        const plotInfos: PlotInfo[] = parameters.map((p) =>
          prepPlot({
            inputName: p.input_name,
            unitSystem,
            machineWidth: p.machine_width,
            sectionNum: p.section_num,
            harvesterWidth: p.harvester_width,
          })
        );
        const expData = makeExpPlots({
          inputPlotInfo: plotInfos.length === 1 ? plotInfos[0]! : plotInfos,
          boundary: load<FeatureCollection>(testCase.boundary),
          abLine: load<FeatureCollection>(testCase.abLine),
        });

        parameters.forEach((p, index) => {
          const inputDir = `${dir}/${p.input_name}`;
          const layout = expData.inputs[index]!;

          it(`plots match R for input ${p.input_name}`, () => {
            const rPlots = load<FeatureCollection>(`${inputDir}/plots.geojson`);
            const rByKey = groupByKey(rPlots.features as PolyFeature[]);
            const tsByKey = groupByKey(layout.plots.features as PolyFeature[]);

            expect(
              tsByKey
                .keys()
                .toArray()
                .toSorted((a, b) => a.localeCompare(b))
            ).toEqual(
              rByKey
                .keys()
                .toArray()
                .toSorted((a, b) => a.localeCompare(b))
            );
            expect(layout.plots.features).toHaveLength(rPlots.features.length);

            for (const [key, rFeatures] of rByKey) {
              const tsFeatures = tsByKey.get(key)!;
              expect(tsFeatures, `duplicate count for ${key}`).toHaveLength(rFeatures.length);
              rFeatures.forEach((rf, index) => {
                const tf = tsFeatures[index]!;
                expect(overlapRatio(tf, rf), `overlap for plot ${key}`).toBeGreaterThanOrEqual(
                  0.99
                );
                expect(
                  centroidDistanceMeters(tf, rf),
                  `centroid distance for plot ${key}`
                ).toBeLessThanOrEqual(0.1);
              });
            }
          });

          it(`headland matches R for input ${p.input_name}`, () => {
            const rHead = load<FeatureCollection>(`${inputDir}/headlands.geojson`);
            expect(layout.headlands.features).toHaveLength(rHead.features.length);
            const rf = rHead.features[0] as PolyFeature;
            const tf = layout.headlands.features[0] as PolyFeature;
            expect(tf.properties).toMatchObject({ type: "headland" });
            // Two-way overlap instead of the centroid criterion: turf's
            // centroid is a vertex mean, and the R headland ring carries
            // hundreds of tiny st_buffer arc vertices ours does not, which
            // skews the vertex mean by meters while the shapes agree to
            // better than 99.9%.
            expect(overlapRatio(tf, rf), "headland overlap (ts vs r)").toBeGreaterThanOrEqual(0.99);
            expect(overlapRatio(rf, tf), "headland overlap (r vs ts)").toBeGreaterThanOrEqual(0.99);
          });

          it(`ab-line and guidance line match R for input ${p.input_name}`, () => {
            const rAb = load<FeatureCollection>(`${inputDir}/ab-line.geojson`).features[0]!;
            const rHarvest = load<FeatureCollection>(`${inputDir}/harvester-ab-line.geojson`)
              .features[0]!;
            expect(
              lineEndpointsClose(layout.abLine, rAb as Feature<LineString>, 0.1),
              "ab-line endpoints within 10 cm"
            ).toBe(true);
            expect(layout.guidanceLines.features).toHaveLength(1);
            expect(
              lineEndpointsClose(
                layout.guidanceLines.features[0] as Feature<LineString>,
                rHarvest as Feature<LineString>,
                0.1
              ),
              "guidance line endpoints within 10 cm"
            ).toBe(true);
          });
        });
      });
    }
  }
});

describe("makeExpPlots error cases (task 4.5)", () => {
  const boundary = load<FeatureCollection>("fixtures/boundary-simple1.geojson");
  const abLine = load<FeatureCollection>("fixtures/ab-line-simple1.geojson");
  const plotInfo = prepPlot({
    inputName: "seed",
    unitSystem: "imperial",
    machineWidth: 60,
    sectionNum: 24,
    harvesterWidth: 30,
  });
  const emptyFc: FeatureCollection = { type: "FeatureCollection", features: [] };

  it("throws ValidationError when the ab-line is missing with ablineType lock", () => {
    expect(() =>
      makeExpPlots({ inputPlotInfo: plotInfo, boundary, abLine: emptyFc, ablineType: "lock" })
    ).toThrow(ValidationError);
  });

  it("throws ValidationError when the ab-line is missing (free)", () => {
    // Deviation from R: R only requires abline_data for actual generation and
    // fails obscurely on NA input; the port validates upfront (spec: ab-line
    // required).
    expect(() => makeExpPlots({ inputPlotInfo: plotInfo, boundary, abLine: emptyFc })).toThrow(
      ValidationError
    );
  });

  it("throws GeometryError for an irreparable (degenerate) boundary", () => {
    const degenerate: Feature<Polygon> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-88.2, 40.1],
            [-88.2, 40.1],
            [-88.2, 40.1],
            [-88.2, 40.1],
          ],
        ],
      },
    };
    expect(() => makeExpPlots({ inputPlotInfo: plotInfo, boundary: degenerate, abLine })).toThrow(
      GeometryError
    );
  });

  it("repairs a self-intersecting (bowtie) boundary instead of failing", () => {
    // st_make_valid equivalent: the bowtie is split into its two lobes and
    // plots are laid into the surviving geometry.
    const bowtie: Feature<Polygon> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-88.21, 40.1],
            [-88.19, 40.11],
            [-88.19, 40.1],
            [-88.21, 40.11],
            [-88.21, 40.1],
          ],
        ],
      },
    };
    const abLineBowtie: Feature<LineString> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [-88.205, 40.101],
          [-88.205, 40.109],
        ],
      },
    };
    const result = makeExpPlots({
      inputPlotInfo: prepPlot({
        inputName: "seed",
        unitSystem: "metric",
        machineWidth: 12,
        sectionNum: 1,
        harvesterWidth: 12,
        headlandLength: 24,
        sideLength: 12,
        minPlotLength: 50,
        maxPlotLength: 80,
      }),
      boundary: bowtie,
      abLine: abLineBowtie,
    });
    expect(result.inputs[0]!.plots.features.length).toBeGreaterThan(0);
  });

  it("throws ValidationError for inconsistent lengths across two inputs", () => {
    const other = prepPlot({
      inputName: "NH3",
      unitSystem: "imperial",
      machineWidth: 30,
      sectionNum: 1,
      harvesterWidth: 60, // differs from the first input's 30
    });
    expect(() => makeExpPlots({ inputPlotInfo: [plotInfo, other], boundary, abLine })).toThrow(
      ValidationError
    );
  });

  it('accepts ablineType "non" (design.md D3) and still produces plots', () => {
    // Deviation from R: R's make_ablines returns NULL for the per-input
    // ab-line when abline_type == "non" (guidance lines are unaffected,
    // R always builds those in "free" mode). InputLayout.abLine is
    // non-nullable, so "non" falls back to the same "free" computation.
    const result = makeExpPlots({ inputPlotInfo: plotInfo, boundary, abLine, ablineType: "non" });
    expect(result.inputs[0]!.plots.features.length).toBeGreaterThan(0);
    expect(result.inputs[0]!.abLine.geometry.type).toBe("LineString");
  });

  it("throws ValidationError for an unsupported ablineType", () => {
    expect(() =>
      makeExpPlots({
        inputPlotInfo: plotInfo,
        boundary,
        abLine,
        ablineType: "bogus" as unknown as "free",
      })
    ).toThrow(ValidationError);
  });

  it('returns the extended input ab-line unchanged for ablineType "lock"', () => {
    const result = makeExpPlots({ inputPlotInfo: plotInfo, boundary, abLine, ablineType: "lock" });
    const out = result.inputs[0]!.abLine.geometry.coordinates;
    const input = (abLine.features[0] as Feature<LineString>).geometry.coordinates;
    // R lock: ab_lines = the input ab-line stretched across the field, so the
    // first vertex is preserved and the heading is unchanged.
    expect(out[0]![0]).toBeCloseTo(input[0]![0]!, 6);
    expect(out[0]![1]).toBeCloseTo(input[0]![1]!, 6);
    expect(result.inputs[0]!.plots.features.length).toBeGreaterThan(0);
  });
});

describe("makeExpPlots — M3: equal-width inputs own independent objects", () => {
  const boundary = load<FeatureCollection>("fixtures/boundary-simple1.geojson");
  const abLine = load<FeatureCollection>("fixtures/ab-line-simple1.geojson");
  const equalWidth = (name: string): PlotInfo =>
    prepPlot({
      inputName: name,
      unitSystem: "imperial",
      machineWidth: 60,
      sectionNum: 24,
      harvesterWidth: 30,
    });

  it("does not share plots/headlands/guidance between two equal-plot-width inputs", () => {
    const exp = makeExpPlots({
      inputPlotInfo: [equalWidth("A"), equalWidth("B")],
      boundary,
      abLine,
    });
    const [a, b] = exp.inputs;

    // Distinct collections AND distinct feature objects.
    expect(a!.plots).not.toBe(b!.plots);
    expect(a!.plots.features[0]).not.toBe(b!.plots.features[0]);
    expect(a!.headlands).not.toBe(b!.headlands);
    expect(a!.guidanceLines.features[0]).not.toBe(b!.guidanceLines.features[0]);

    // Same geometry, though (shared plot width): mutating A must not touch B.
    const before = (b!.plots.features[0]!.properties as { strip_id: number }).strip_id;
    (a!.plots.features[0]!.properties as { rate?: number }).rate = 999;
    (a!.plots.features[0]!.properties as { strip_id: number }).strip_id = -1;
    expect((b!.plots.features[0]!.properties as { rate?: number }).rate).toBeUndefined();
    expect((b!.plots.features[0]!.properties as { strip_id: number }).strip_id).toBe(before);
  });
});
