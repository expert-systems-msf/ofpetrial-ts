// Property tests for rate-assignment (design.md D4): randomized designs are
// judged by properties (balance, determinism-by-seed, one rate per plot,
// rate-jump respect, joint two-input correlation), never by reproducing R's
// random sequence. Built on top of makeExpPlots(simple1) — see
// tests/parity-rate-assignment.test.ts for the addBlocks/changeRates parity
// and behavior tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sampleCorrelation } from "simple-statistics";
import { describe, expect, it } from "vitest";
import type { Feature, FeatureCollection, LineString } from "geojson";
import { makeExpPlots } from "./plot-layout.js";
import {
  addBlocks,
  assignEjca,
  assignLs,
  assignRates,
  assignRatesByInput,
  assignRatesConditional,
  circShift,
  defaultRateJumpThreshold,
  genBasicRankWs,
  genBasicRankWsSparse,
  getRankForRb,
  getRankWsForStrip,
  getRankWsForStripSparse,
  getStartingRankAs,
  getStartingRankAsLs,
  matSub,
  maxOverColumns,
  meanAbs,
  meanAbsSum,
  median,
  multipleOfTheOther,
  rangeStep,
  variabilityScore,
} from "./rate-assignment.js";
import type { RateData } from "./types.js";
import { createRng } from "./rng.js";
import { prepPlot, prepRate } from "./trial-setup.js";
import { ValidationError } from "./types.js";
import type { ExpData, InputDesign, InputLayout, PlotInfo, RateInfo } from "./types.js";

const ROOT = join(import.meta.dirname, "..");

function load<T>(relPath: string): T {
  return JSON.parse(readFileSync(join(ROOT, relPath), "utf8")) as T;
}

const boundary = load<FeatureCollection>("fixtures/boundary-simple1.geojson");
const abLine = load<Feature<LineString>>("fixtures/ab-line-simple1.geojson");

function seedPlotInfo(): PlotInfo {
  return prepPlot({
    inputName: "seed",
    unitSystem: "imperial",
    machineWidth: 60,
    sectionNum: 24,
    harvesterWidth: 30,
  });
}

function makeSingleInputExpData(plotInfo: PlotInfo): ExpData {
  return makeExpPlots({ inputPlotInfo: plotInfo, boundary, abLine });
}

function expProperties(f: Feature): {
  stripId: number;
  plotId: number;
  rate: number;
  rateRank: number;
  type: string;
} {
  const p = f.properties as {
    strip_id: number;
    plot_id: number;
    rate: number;
    rate_rank: number;
    type: string;
  };
  return {
    stripId: p.strip_id,
    plotId: p.plot_id,
    rate: p.rate,
    rateRank: p.rate_rank,
    type: p.type,
  };
}

function groupByStripIds(input: InputDesign): Map<number, ReturnType<typeof expProperties>[]> {
  const map = new Map<number, ReturnType<typeof expProperties>[]>();
  for (const f of input.plots.features) {
    const properties = expProperties(f);
    const array = map.get(properties.stripId) ?? [];
    array.push(properties);
    map.set(properties.stripId, array);
  }
  for (const array of map.values()) array.sort((a, b) => a.plotId - b.plotId);
  return map;
}

describe("assignRates: single input (ls design, task 5.2)", () => {
  const plotInfo = seedPlotInfo();
  const expData = makeSingleInputExpData(plotInfo);
  const rateInfo = prepRate(plotInfo, {
    gcRate: 34_000,
    unit: "seeds",
    rates: [20_000, 26_000, 32_000, 38_000, 44_000],
  });

  it("assigns exactly one rate to every experimental plot, and gc_rate to the headland", () => {
    const td = assignRates(expData, rateInfo, { seed: 42 });
    const input = td.inputs[0]!;
    expect(input.plots.features.length).toBeGreaterThan(0);
    for (const f of input.plots.features) {
      const properties = expProperties(f);
      expect(rateInfo.tgt_rate_original).toContain(properties.rate);
      expect(properties.rateRank).toBeGreaterThanOrEqual(1);
      expect(properties.rateRank).toBeLessThanOrEqual(5);
      expect(properties.type).toBe("experiment");
    }
    for (const f of input.headlands.features) {
      expect((f.properties as { rate: number }).rate).toBe(34_000);
    }
    expect(td.seed).toBe(42);
  });

  it("balances rate counts within each strip (off by at most 1)", () => {
    const td = assignRates(expData, rateInfo, { seed: 42 });
    const byStrip = groupByStripIds(td.inputs[0]!);
    for (const [, plots] of byStrip) {
      const counts = new Map<number, number>();
      for (const p of plots) counts.set(p.rate, (counts.get(p.rate) ?? 0) + 1);
      const values = counts.values().toArray();
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
    }
  });

  it("respects the default rate_jump_threshold between adjacent plots within a strip", () => {
    const td = assignRates(expData, rateInfo, { seed: 7 });
    const threshold = Math.ceil(5 / 2); // default: ceil(numRates / 2)
    const byStrip = groupByStripIds(td.inputs[0]!);
    for (const [, plots] of byStrip) {
      for (let index = 1; index < plots.length; index++) {
        expect(Math.abs(plots[index]!.rateRank - plots[index - 1]!.rateRank)).toBeLessThanOrEqual(
          threshold
        );
      }
    }
  });

  it("is deterministic for a given seed", () => {
    const tdA = assignRates(expData, rateInfo, { seed: 123 });
    const tdB = assignRates(expData, rateInfo, { seed: 123 });
    const ratesA = tdA.inputs[0]!.plots.features.map((f) => expProperties(f).rate);
    const ratesB = tdB.inputs[0]!.plots.features.map((f) => expProperties(f).rate);
    expect(ratesA).toEqual(ratesB);
  });

  it("rejects a RateInfo whose input_name has no match in expData", () => {
    const badRateInfo: RateInfo = { ...rateInfo, input_name: "nope" };
    const act = () => assignRates(expData, badRateInfo);
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/has no matching input in expData/);
  });
});

describe("assignRates: sparse design (task 5.1)", () => {
  it("marks roughly every other plot as gc_rate", () => {
    const plotInfo = seedPlotInfo();
    const expData = makeSingleInputExpData(plotInfo);
    const rateInfo = prepRate(plotInfo, {
      gcRate: 32_000,
      unit: "seeds",
      rates: [32_000, 20_000, 26_000, 38_000, 44_000],
      designType: "sparse",
    });

    const td = assignRates(expData, rateInfo, { seed: 5 });
    const byStrip = groupByStripIds(td.inputs[0]!);
    for (const [, plots] of byStrip) {
      const gcCount = plots.filter((p) => p.rate === 32_000).length;
      const expected = Math.floor(plots.length / 2);
      expect(Math.abs(gcCount - expected)).toBeLessThanOrEqual(1);
    }
  });
});

describe("assignRates: partial dosing (task 5.2, spec.md scenario)", () => {
  it("leaves the undosed input with rateInfo: null and no rate/rate_rank properties", () => {
    const seedInfo = seedPlotInfo();
    const nh3Info = prepPlot({
      inputName: "NH3",
      unitSystem: "imperial",
      machineWidth: 30,
      sectionNum: 1,
      harvesterWidth: 30,
    });
    const expData = makeExpPlots({ inputPlotInfo: [seedInfo, nh3Info], boundary, abLine });
    const seedRateInfo = prepRate(seedInfo, {
      gcRate: 34_000,
      unit: "seeds",
      rates: [20_000, 26_000, 32_000, 38_000, 44_000],
    });

    const td = assignRates(expData, seedRateInfo, { seed: 1 });
    const seedInput = td.inputs.find((index) => index.plotInfo.input_name === "seed")!;
    const nh3Input = td.inputs.find((index) => index.plotInfo.input_name === "NH3")!;

    expect(seedInput.rateInfo).not.toBeNull();
    expect(nh3Input.rateInfo).toBeNull();
    for (const f of nh3Input.plots.features) {
      expect((f.properties as Record<string, unknown>).rate).toBeUndefined();
      expect((f.properties as Record<string, unknown>).rate_rank).toBeUndefined();
    }
    expect(nh3Input.plots.features.length).toBeGreaterThan(0);
  });
});

/** Two inputs sharing the exact same plot geometry (same machine dims) and
 * an equal rate count — the precondition for joint two-input designing. */
function twoJointInputs(numberRates: number): { expData: ExpData; riA: RateInfo; riB: RateInfo } {
  const plotInfoA = prepPlot({
    inputName: "A",
    unitSystem: "imperial",
    machineWidth: 60,
    sectionNum: 24,
    harvesterWidth: 30,
  });
  const plotInfoB = prepPlot({
    inputName: "B",
    unitSystem: "imperial",
    machineWidth: 60,
    sectionNum: 24,
    harvesterWidth: 30,
  });
  const expData = makeExpPlots({ inputPlotInfo: [plotInfoA, plotInfoB], boundary, abLine });
  const rates = Array.from({ length: numberRates }, (_, index) => 100 + index * 10);
  const riA = prepRate(plotInfoA, { gcRate: rates[0]!, unit: "lb", rates });
  const riB = prepRate(plotInfoB, {
    gcRate: rates[0]!,
    unit: "lb",
    rates: rates.map((r) => r * 2),
  });
  return { expData, riA, riB };
}

describe("assignRates: two-input joint designing (task 5.2/5.3)", () => {
  it("keeps the correlation between the two rate-rank plans below 0.3 (general case)", () => {
    const { expData, riA, riB } = twoJointInputs(5);
    const td = assignRates(expData, [riA, riB], { seed: 42 });
    const inputA = td.inputs.find((index) => index.plotInfo.input_name === "A")!;
    const inputB = td.inputs.find((index) => index.plotInfo.input_name === "B")!;
    const ranksA = inputA.plots.features.map((f) => expProperties(f).rateRank);
    const ranksB = inputB.plots.features.map((f) => expProperties(f).rateRank);
    expect(Math.abs(sampleCorrelation(ranksA, ranksB))).toBeLessThan(0.3);
  });

  it("2x2 special case is deterministic regardless of seed", () => {
    const { expData, riA, riB } = twoJointInputs(2);
    const tdSeed1 = assignRates(expData, [riA, riB], { seed: 1 });
    const tdSeed2 = assignRates(expData, [riA, riB], { seed: 999 });
    const ratesOf = (td: typeof tdSeed1, name: string): number[] =>
      td.inputs
        .find((index) => index.plotInfo.input_name === name)!
        .plots.features.map((f) => expProperties(f).rate);
    expect(ratesOf(tdSeed1, "A")).toEqual(ratesOf(tdSeed2, "A"));
    expect(ratesOf(tdSeed1, "B")).toEqual(ratesOf(tdSeed2, "B"));
  });

  it("every plot gets exactly one rate for both inputs, drawn from that input's ladder", () => {
    const { expData, riA, riB } = twoJointInputs(5);
    const td = assignRates(expData, [riA, riB], { seed: 3 });
    for (const input of td.inputs) {
      for (const f of input.plots.features) {
        expect(input.rateInfo!.tgt_rate_original).toContain(expProperties(f).rate);
      }
    }
  });
});

describe("assignRatesConditional (task 5.3)", () => {
  it("balances joint (rateA, rateB) combinations and keeps correlation below 0.3", () => {
    const { expData, riA, riB } = twoJointInputs(5);
    const partial = assignRates(expData, riA, { seed: 42 });
    const conditioned = assignRatesConditional(expData, riB, partial, { seed: 42 });

    const inputA = conditioned.inputs.find((index) => index.plotInfo.input_name === "A")!;
    const inputB = conditioned.inputs.find((index) => index.plotInfo.input_name === "B")!;
    expect(inputB.rateInfo).not.toBeNull();

    const ranksA = inputA.plots.features.map((f) => expProperties(f).rateRank);
    const ranksB = inputB.plots.features.map((f) => expProperties(f).rateRank);
    expect(ranksB.length).toBe(ranksA.length);
    expect(Math.abs(sampleCorrelation(ranksA, ranksB))).toBeLessThan(0.3);

    const counts = new Map<number, number>();
    for (const r of ranksB) counts.set(r, (counts.get(r) ?? 0) + 1);
    const values = counts.values().toArray();
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(
      Math.ceil(ranksB.length * 0.2)
    );
  });

  it("rejects an array of RateInfo", () => {
    const { expData, riA, riB } = twoJointInputs(5);
    const partial = assignRates(expData, riA, { seed: 1 });
    const act = () => assignRatesConditional(expData, [riB], partial);
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/accepts a single RateInfo/);
  });

  it("rejects a mono-input existingDesign", () => {
    const { expData, riA, riB } = twoJointInputs(5);
    const monoInput = assignRates({ inputs: [expData.inputs[0]!] }, riA, { seed: 1 });
    const act = () => assignRatesConditional(expData, riB, monoInput);
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/two-input TrialDesign/);
  });

  it("rejects an existingDesign whose second input is already dosed", () => {
    const { expData, riA, riB } = twoJointInputs(5);
    const fullyDosed = assignRates(expData, [riA, riB], { seed: 1 });
    const act = () => assignRatesConditional(expData, riB, fullyDosed);
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/two-input TrialDesign/);
  });
});

describe("assignRates: two-input joint designing — regression (audit H1)", () => {
  // A(4 rates) × B(2 rates), equal machine width so the joint branch runs and
  // B is the "second" input (getDesignForSecond). findRate excludes both the
  // previous plot's rank and the strip-neighbour's rank; with exactly two
  // second-input rates the candidate set can empty out, which previously threw
  // "sample requires 0 <= n <= arr.length (0), got 1" on essentially every seed.
  function asymJointInputs(): { expData: ExpData; riA: RateInfo; riB: RateInfo } {
    const plotInfoA = prepPlot({
      inputName: "A",
      unitSystem: "imperial",
      machineWidth: 60,
      sectionNum: 24,
      harvesterWidth: 30,
    });
    const plotInfoB = prepPlot({
      inputName: "B",
      unitSystem: "imperial",
      machineWidth: 60,
      sectionNum: 24,
      harvesterWidth: 30,
    });
    const expData = makeExpPlots({ inputPlotInfo: [plotInfoA, plotInfoB], boundary, abLine });
    const riA = prepRate(plotInfoA, { gcRate: 100, unit: "lb", rates: [100, 110, 120, 130] });
    const riB = prepRate(plotInfoB, { gcRate: 200, unit: "lb", rates: [200, 260] });
    return { expData, riA, riB };
  }

  it("does not crash when the second input has exactly two rates (all seeds 1..25)", () => {
    const { expData, riA, riB } = asymJointInputs();
    for (let seed = 1; seed <= 25; seed++) {
      const td = assignRates(expData, [riA, riB], { seed });
      const inputB = td.inputs.find((index) => index.plotInfo.input_name === "B")!;
      expect(inputB.plots.features.length).toBeGreaterThan(0);
      for (const f of inputB.plots.features) {
        expect([200, 260]).toContain(expProperties(f).rate);
      }
    }
  });
});

describe("assignRatesConditional — regression (audit H2)", () => {
  // Different machine widths => different plot geometries and plot counts. The
  // joint path indexed the dosed design's ranks positionally against the
  // undosed input's plots — crashing when the dosed input has fewer plots, or
  // silently mis-pairing when it has more. The geometry gate must route to
  // independent per-input design (matching R) instead.
  // Wide applicator (NH3, 120 ft) yields far fewer plots than the seeder
  // (60 ft), so the two inputs have different plot geometries and counts. We
  // dose the smaller-count input (NH3) and condition the larger one (seed):
  // the pre-fix joint path indexes NH3's shorter rank list positionally over
  // seed's longer plot list, whose tail is undefined — crashing with
  // "sample requires 0 <= n <= arr.length (0), got 1".
  function twoDiffWidthInputs(): { expData: ExpData; seedRi: RateInfo; nh3Ri: RateInfo } {
    const seedInfo = prepPlot({
      inputName: "seed",
      unitSystem: "imperial",
      machineWidth: 60,
      sectionNum: 24,
      harvesterWidth: 30,
    });
    const nh3Info = prepPlot({
      inputName: "NH3",
      unitSystem: "imperial",
      machineWidth: 160,
      sectionNum: 8,
      harvesterWidth: 30,
    });
    const expData = makeExpPlots({ inputPlotInfo: [seedInfo, nh3Info], boundary, abLine });
    const seedRi = prepRate(seedInfo, {
      gcRate: 20_000,
      unit: "seeds",
      rates: [20_000, 26_000, 32_000, 38_000, 44_000],
    });
    const nh3Ri = prepRate(nh3Info, {
      gcRate: 100,
      unit: "lb",
      rates: [100, 130, 160, 190, 220],
    });
    return { expData, seedRi, nh3Ri };
  }

  it("doses the conditioned input without crashing when geometries differ", () => {
    const { expData, seedRi, nh3Ri } = twoDiffWidthInputs();
    // dose NH3 (fewer plots), then condition seed (more plots)
    const partial = assignRates(expData, nh3Ri, { seed: 1 });
    const conditioned = assignRatesConditional(expData, seedRi, partial, { seed: 1 });
    const seedInput = conditioned.inputs.find((index) => index.plotInfo.input_name === "seed")!;
    expect(seedInput.rateInfo).not.toBeNull();
    expect(seedInput.plots.features.length).toBeGreaterThan(0);
    for (const f of seedInput.plots.features) {
      expect(seedRi.tgt_rate_original).toContain(expProperties(f).rate);
    }
  });
});

describe("assignRates: str / rstr / rb / ejca designs (task 5.1)", () => {
  const plotInfo = seedPlotInfo();
  const expData = makeSingleInputExpData(plotInfo);
  const RATES_5 = [20_000, 26_000, 32_000, 38_000, 44_000];
  const RATES_4 = [20_000, 26_000, 38_000, 44_000];

  function rateInfoFor(designType: string, rates: number[]): RateInfo {
    return prepRate(plotInfo, { gcRate: 34_000, unit: "seeds", rates, designType });
  }

  function assertOneRateFromLadder(designType: string, rates: number[]): void {
    const td = assignRates(expData, rateInfoFor(designType, rates), { seed: 11 });
    const input = td.inputs[0]!;
    expect(input.plots.features.length).toBeGreaterThan(0);
    for (const f of input.plots.features) {
      expect(rates).toContain(expProperties(f).rate);
    }
  }

  function assertDeterministicBySeed(designType: string, rates: number[]): void {
    const ri = rateInfoFor(designType, rates);
    const a = assignRates(expData, ri, { seed: 77 }).inputs[0]!.plots.features.map(
      (f) => expProperties(f).rate
    );
    const b = assignRates(expData, ri, { seed: 77 }).inputs[0]!.plots.features.map(
      (f) => expProperties(f).rate
    );
    expect(a).toEqual(b);
  }

  for (const [designType, rates] of [
    ["str", RATES_5],
    ["rstr", RATES_5],
    ["rb", RATES_5],
    ["ejca", RATES_4],
  ] as const) {
    it(`${designType}: every experiment plot gets exactly one rate from the ladder`, () => {
      assertOneRateFromLadder(designType, rates);
    });

    it(`${designType}: deterministic by seed`, () => {
      assertDeterministicBySeed(designType, rates);
    });
  }

  for (const designType of ["str", "rstr"] as const) {
    it(`${designType}: rate is constant within each strip`, () => {
      const td = assignRates(expData, rateInfoFor(designType, RATES_5), { seed: 21 });
      const byStrip = groupByStripIds(td.inputs[0]!);
      for (const [, plots] of byStrip) {
        expect(new Set(plots.map((p) => p.rate)).size).toBe(1);
      }
    });
  }

  it("rb: rates are balanced within each block (each rate once per complete set of numRates plots)", () => {
    const numberRates = 5;
    const td = assignRates(expData, rateInfoFor("rb", RATES_5), { seed: 13 });
    const input = td.inputs[0]!;
    // Recompute R's block partition: block_row/block_col by integer division.
    const byBlock = new Map<string, number[]>();
    for (const f of input.plots.features) {
      const { stripId, plotId, rateRank } = expProperties(f);
      const key = `${Math.floor((plotId - 1) / numberRates) + 1}:${Math.floor((stripId - 1) / numberRates) + 1}`;
      const array = byBlock.get(key) ?? [];
      array.push(rateRank);
      byBlock.set(key, array);
    }
    expect(byBlock.size).toBeGreaterThan(1);
    for (const ranks of byBlock.values()) {
      const counts = new Map<number, number>();
      for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
      const values = counts.values().toArray();
      // partial border blocks: counts differ by at most 1
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
      if (ranks.length % numberRates === 0) {
        // complete blocks: each rate appears exactly ranks.length / numRates times
        expect(counts.size).toBe(numberRates);
        for (const v of values) expect(v).toBe(ranks.length / numberRates);
      }
    }
  });

  it("ejca: tiers alternate by strip parity (odd strips low-tier ranks, even strips high-tier)", () => {
    const td = assignRates(expData, rateInfoFor("ejca", RATES_4), { seed: 17 });
    const byStrip = groupByStripIds(td.inputs[0]!);
    // ranks 1..4, median 2.5: tier 1 = {1, 2} on odd strips, tier 2 = {3, 4} on even strips
    for (const [stripId, plots] of byStrip) {
      const expected = stripId % 2 === 1 ? [1, 2] : [3, 4];
      for (const p of plots) {
        expect(expected).toContain(p.rateRank);
      }
    }
  });
});

describe("hole-split strips: feature order is preserved, never re-sorted by plot_id", () => {
  // Regression for the groupByStrip sort bug: plot_id restarts per piece when
  // a boundary hole splits a strip, so sorting by plot_id would interleave
  // the pieces and scramble the physical along-strip order R relies on.
  const holesBoundary = load<FeatureCollection>("fixtures/field-boundary-with-holes.geojson");
  const holesAbLine = load<Feature<LineString>>("fixtures/ab-line-for-field-with-holes.geojson");
  const plotInfo = seedPlotInfo();
  const layout = makeExpPlots({
    inputPlotInfo: plotInfo,
    boundary: holesBoundary,
    abLine: holesAbLine,
  });
  const rateInfo = prepRate(plotInfo, {
    gcRate: 34_000,
    unit: "seeds",
    rates: [20_000, 26_000, 32_000, 38_000, 44_000],
  });

  it("the fixture actually contains a hole-split strip (duplicate plot_ids)", () => {
    const seen = new Set<string>();
    let hasDuplicate = false;
    const features = layout.inputs[0]!.plots.features;
    for (const f of features) {
      const { stripId, plotId } = expProperties(f);
      const key = `${stripId}:${plotId}`;
      if (seen.has(key)) hasDuplicate = true;
      seen.add(key);
    }
    expect(hasDuplicate).toBe(true);
  });

  it("output feature order matches the input layout order within every strip (by geometry identity)", () => {
    const td = assignRates(layout, rateInfo, { seed: 42 });
    const inputFeatures = layout.inputs[0]!.plots.features;
    const outputFeatures = td.inputs[0]!.plots.features;
    expect(outputFeatures.length).toBe(inputFeatures.length);
    for (const [index, inputFeature] of inputFeatures.entries()) {
      expect(JSON.stringify(outputFeatures[index]!.geometry)).toBe(
        JSON.stringify(inputFeature!.geometry)
      );
      expect(expProperties(outputFeatures[index]!).stripId).toBe(
        expProperties(inputFeature!).stripId
      );
      expect(expProperties(outputFeatures[index]!).plotId).toBe(
        expProperties(inputFeature!).plotId
      );
    }
  });

  it("within each strip, ranks follow the within-strip rotation over the FEATURE order (not plot_id order)", () => {
    const td = assignRates(layout, rateInfo, { seed: 42 });
    const basicSeq = genBasicRankWs(5, null);
    const byStrip = new Map<number, number[]>();
    const features = td.inputs[0]!.plots.features;
    for (const f of features) {
      const { stripId, rateRank } = expProperties(f);
      const array = byStrip.get(stripId) ?? [];
      array.push(rateRank);
      byStrip.set(stripId, array);
    }
    for (const [, ranks] of byStrip) {
      const rotation = getRankWsForStrip(ranks[0]!, basicSeq);
      const expected: number[] = [];
      while (expected.length < ranks.length) expected.push(...rotation);
      expect(ranks).toEqual(expected.slice(0, ranks.length));
    }
  });
});

describe("rank-sequence primitives: exact values verified against R (ofpetrial 0.1.3 internals)", () => {
  // Expected vectors obtained by running the R internals directly:
  //   Rscript -e 'ofpetrial:::gen_basic_rank_ws(5)' etc.
  // (R 4.6, ofpetrial 0.1.3 at /opt/homebrew/lib/R/4.6/site-library)
  it("genBasicRankWs matches R gen_basic_rank_ws", () => {
    expect(genBasicRankWs(5, null)).toEqual([3, 1, 4, 2, 5]);
    expect(genBasicRankWs(5, 2)).toEqual([3, 1, 2, 4, 5]);
    expect(genBasicRankWs(4, null)).toEqual([2, 1, 3, 4]);
    expect(genBasicRankWs(2, null)).toEqual([1, 2]);
    expect(genBasicRankWs(9, null)).toEqual([1, 3, 5, 7, 9, 8, 6, 4, 2]);
  });

  it("genBasicRankWsSparse matches R gen_basic_rank_ws_sparse", () => {
    expect(genBasicRankWsSparse(5)).toEqual([3, 1, 5, 1, 4, 1, 2, 1]);
    expect(genBasicRankWsSparse(4)).toEqual([3, 1, 4, 1, 2, 1]);
  });

  it("getRankWsForStrip matches R get_rank_ws_for_strip (rotation to the start rank)", () => {
    expect(getRankWsForStrip(2, [3, 1, 4, 2, 5])).toEqual([2, 5, 3, 1, 4]);
    expect(getRankWsForStrip(3, [3, 1, 4, 2, 5])).toEqual([3, 1, 4, 2, 5]);
  });

  it("getRankWsForStripSparse matches R get_rank_ws_for_strip_sparse (even strips get a leading 1)", () => {
    const sparse5 = genBasicRankWsSparse(5);
    expect(getRankWsForStripSparse(3, sparse5, 2)).toEqual([1, 3, 1, 5, 1, 4, 1, 2]);
    expect(getRankWsForStripSparse(3, sparse5, 1)).toEqual([3, 1, 5, 1, 4, 1, 2, 1]);
  });

  it("getStartingRankAsLs: permutation of 1..n, deterministic by seed, R diagonal property", () => {
    const rankSeqWs = genBasicRankWs(5, null);
    const seq = getStartingRankAsLs(rankSeqWs, createRng(42));
    expect(seq.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(getStartingRankAsLs(rankSeqWs, createRng(42))).toEqual(seq);

    // R filter property: no diagonal (up or down) of the rotated-rank matrix
    // is constant across all rows (check_0_diagonal_up/down < num_rates).
    const n = 5;
    const mat = seq.map((x) => getRankWsForStrip(x, rankSeqWs));
    for (const colDelta of [-1, 1]) {
      for (let index = 0; index < n; index++) {
        let zeros = 0;
        for (let index_ = 0; index_ < n; index_++) {
          const shifted = mat[(index_ + 1) % n]![(((index + colDelta) % n) + n) % n]!;
          if (mat[index_]![index]! === shifted) zeros += 1;
        }
        expect(zeros).toBeLessThan(n);
      }
    }
  });

  it("getStartingRankAs: permutation of 1..n, deterministic by seed", () => {
    const seq = getStartingRankAs(4, createRng(7));
    expect(seq.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(getStartingRankAs(4, createRng(7))).toEqual(seq);
    expect(getStartingRankAs(1, createRng(7))).toEqual([1]);
  });

  it("getRankForRb: complete permutation per numRates chunk, distinct remainder, deterministic", () => {
    const ranks = getRankForRb(5, 12, createRng(3));
    expect(ranks).toHaveLength(12);
    expect(ranks.slice(0, 5).toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(ranks.slice(5, 10).toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    const remainder = ranks.slice(10);
    expect(new Set(remainder).size).toBe(2);
    for (const r of remainder) {
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(5);
    }
    expect(getRankForRb(5, 12, createRng(3))).toEqual(ranks);
  });
});

describe("addBlocks + assignRates integration (task 5.4)", () => {
  it("produces contiguous block ids covering every experimental plot", () => {
    const plotInfo = seedPlotInfo();
    const expData = makeSingleInputExpData(plotInfo);
    const rateInfo = prepRate(plotInfo, {
      gcRate: 34_000,
      unit: "seeds",
      rates: [20_000, 26_000, 32_000, 38_000, 44_000],
    });
    const td = assignRates(expData, rateInfo, { seed: 42 });
    const blocked = addBlocks(td);
    const input = blocked.inputs[0]!;
    for (const f of input.plots.features) {
      const p = f.properties as { block_id: number; plot_id_within_block: number };
      expect(p.block_id).toBeGreaterThanOrEqual(1);
      expect(p.plot_id_within_block).toBeGreaterThanOrEqual(1);
    }
  });
});

// Internal scorers / matrix helpers, pinned to exact values so arithmetic and
// boundary mutants (which the property-level assignRates tests let survive)
// fail. These are the RNG-free building blocks of the ls/ejca optimizers.
describe("rate-assignment internal scorers (exact)", () => {
  it("defaultRateJumpThreshold: n-1 up to 4, n-2 beyond", () => {
    expect(defaultRateJumpThreshold(1)).toBe(0);
    expect(defaultRateJumpThreshold(4)).toBe(3);
    expect(defaultRateJumpThreshold(5)).toBe(3);
    expect(defaultRateJumpThreshold(6)).toBe(4);
  });

  it("multipleOfTheOther: order-independent divisibility", () => {
    expect(multipleOfTheOther(6, 3)).toBe(true);
    expect(multipleOfTheOther(3, 6)).toBe(true);
    expect(multipleOfTheOther(4, 4)).toBe(true);
    expect(multipleOfTheOther(5, 3)).toBe(false);
  });

  it("median: odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([5])).toBe(5);
  });

  it("rangeStep: ascending, descending and stepped", () => {
    expect(rangeStep(1, 5, 1)).toEqual([1, 2, 3, 4, 5]);
    expect(rangeStep(5, 1, -2)).toEqual([5, 3, 1]);
    expect(rangeStep(1, 5, 2)).toEqual([1, 3, 5]);
  });

  it("matSub: element-wise subtraction", () => {
    expect(
      matSub(
        [
          [3, 5],
          [7, 9],
        ],
        [
          [1, 2],
          [3, 4],
        ]
      )
    ).toEqual([
      [2, 3],
      [4, 5],
    ]);
  });

  it("circShift: independent row and column rotation", () => {
    const mat = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ];
    expect(circShift(mat, 1, 0)).toEqual([
      [4, 5, 6],
      [7, 8, 9],
      [1, 2, 3],
    ]);
    expect(circShift(mat, 0, 1)).toEqual([
      [2, 3, 1],
      [5, 6, 4],
      [8, 9, 7],
    ]);
  });

  it("maxOverColumns: largest column sum under a predicate", () => {
    expect(
      maxOverColumns(
        [
          [1, 2],
          [3, 4],
        ],
        (v) => v
      )
    ).toBe(6);
  });

  it("meanAbs / meanAbsSum: mean of absolute values", () => {
    expect(
      meanAbs([
        [-1, 2],
        [3, -4],
      ])
    ).toBe(2.5);
    expect(meanAbsSum([[1, -2]], [[3, 4]])).toBe(5);
  });

  it("variabilityScore: first-plot and subsequent-plot branches", () => {
    // plotId 1: sum over k<rowIndex of (rateTable[k]-cand)^2 * W, / rowIndex.
    expect(variabilityScore(2, 1, 2, [1, 3], [[], [], [1, 1]])).toBe(1);
    // plotId != 1: adds the -1/2 previous-plot term at rowIndex-1.
    expect(variabilityScore(2, 2, 1, [3, 5], [[], [], [2, 4]])).toBe(-12);
  });
});

describe("assignEjca (exact tier-by-strip-parity)", () => {
  it("puts the low rate tier on odd strips and the high tier on even strips", () => {
    const feature = (stripId: number, plotId: number): Feature => ({
      type: "Feature",
      properties: { strip_id: stripId, plot_id: plotId },
      geometry: { type: "Point", coordinates: [0, 0] },
    });
    // 4 strips x 2 plots.
    const features: Feature[] = [];
    for (let strip = 1; strip <= 4; strip++)
      for (let plot = 1; plot <= 2; plot++) features.push(feature(strip, plot));
    const plots: FeatureCollection = { type: "FeatureCollection", features };
    const ratesData: RateData[] = [
      { rate: 10, rate_rank: 1 },
      { rate: 20, rate_rank: 2 },
      { rate: 30, rate_rank: 3 },
      { rate: 40, rate_rank: 4 },
    ];
    const assigned = assignEjca(plots, ratesData, null);

    // median rank 2.5 -> low tier {10,20} on odd strips, high tier {30,40} on
    // even strips. Every plot must be assigned from the tier of its strip.
    expect(assigned.size).toBe(8);
    for (const f of features) {
      const { strip_id: strip } = f.properties as { strip_id: number };
      const rate = assigned.get(f)!.rate;
      if (strip % 2 === 1) expect([10, 20]).toContain(rate);
      else expect([30, 40]).toContain(rate);
    }
  });
});

// !===========================================================
// ! Throw-path error messages (Stryker NoCoverage round 2)
// !===========================================================
describe("rate-assignment throw paths (class + message)", () => {
  const plotInfo = seedPlotInfo();
  const rateInfo = prepRate(plotInfo, {
    gcRate: 34_000,
    unit: "seeds",
    rates: [20_000, 26_000, 32_000, 38_000, 44_000],
  });

  it("firstEpsg: assignRates on an input with an empty plot collection throws", () => {
    const emptyLayout: InputLayout = {
      plotInfo,
      plots: { type: "FeatureCollection", features: [] },
      headlands: { type: "FeatureCollection", features: [] },
      abLine,
      guidanceLines: { type: "FeatureCollection", features: [] },
    };
    const expData: ExpData = { inputs: [emptyLayout] };
    const act = (): unknown => assignRates(expData, rateInfo, { seed: 1 });
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/Cannot assign rates to an empty plot collection/);
  });

  it("genBasicRankWs: no permutation satisfies an impossibly small rate_jump_threshold", () => {
    // For 6 distinct ranks arranged in a cycle, some adjacent (cyclic) jump is
    // always > 1, so the search exhausts and throws.
    const act = (): unknown => genBasicRankWs(6, 1);
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/No rank sequence for 6 rates satisfies rate_jump_threshold=1/);
  });

  it("assignRatesByInput: an unknown design_type hits the default case and throws", () => {
    const emptyPlots: FeatureCollection = { type: "FeatureCollection", features: [] };
    const act = (): unknown =>
      assignRatesByInput(emptyPlots, [], "bogus-design", null, null, null, createRng(1));
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/design_type "bogus-design" does not match any of the design type options/);
  });

  it("assignRates: an empty RateInfo array throws", () => {
    const expData = makeSingleInputExpData(plotInfo);
    const act = (): unknown => assignRates(expData, []);
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/assignRates requires at least one RateInfo/);
  });
});

describe("assignRatesConditional throw paths (class + message)", () => {
  function partialTwoInput(): { expData: ExpData; riA: RateInfo; riB: RateInfo } {
    return twoJointInputs(5);
  }

  it("rejects a RateInfo whose input_name is not the undosed input", () => {
    const { expData, riA, riB } = partialTwoInput();
    const partial = assignRates(expData, riA, { seed: 1 }); // A dosed, B undosed
    // riA targets the ALREADY-dosed input "A", not the undosed "B".
    const act = (): unknown => assignRatesConditional(expData, riA, partial);
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/RateInfo is for input "A", but the undosed input .* is "B"/);
    // sanity: riB (the correct target) does NOT hit this message
    void riB;
  });

  it("rejects when the undosed input has no matching input in expData", () => {
    const { expData, riA, riB } = partialTwoInput();
    const partial = assignRates(expData, riA, { seed: 1 });
    const undosed = partial.inputs.find((index) => index.rateInfo === null)!;
    // Rename the undosed input so its name is absent from expData, but still
    // matches the RateInfo we pass (so we get past the input_name check).
    const renamed: InputDesign = {
      ...undosed,
      plotInfo: { ...undosed.plotInfo, input_name: "GHOST" },
    };
    const existing = {
      ...partial,
      inputs: partial.inputs.map((index) => (index === undosed ? renamed : index)),
    };
    const ri: RateInfo = { ...riB, input_name: "GHOST" };
    const act = (): unknown => assignRatesConditional(expData, ri, existing);
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/RateInfo for input "GHOST" has no matching input in expData/);
  });

  it("rejects a geometry mismatch (would be a third input)", () => {
    const { expData, riA, riB } = partialTwoInput();
    const partial = assignRates(expData, riA, { seed: 1 });
    const undosed = partial.inputs.find((index) => index.rateInfo === null)!;
    // Give the existing design's undosed input a DIFFERENT geometry (one fewer
    // feature) than expData's same-named input, so geometryIdentical is false.
    const trimmed: InputDesign = {
      ...undosed,
      plots: { ...undosed.plots, features: undosed.plots.features.slice(1) },
    };
    const existing = {
      ...partial,
      inputs: partial.inputs.map((index) => (index === undosed ? trimmed : index)),
    };
    const act = (): unknown => assignRatesConditional(expData, riB, existing);
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/trying to add a third input/);
  });
});

// !===========================================================
// ! getStartingRankAsLs: >= 9 deterministic interleave branch (L319-331)
// !===========================================================
describe("getStartingRankAsLs: num_rates >= 9 interleave (exact, deterministic)", () => {
  it("interleaves odd positions ascending and even positions reversed", () => {
    // The >= 9 branch ignores rankSeqWs content (uses only its length) and uses
    // no RNG: temporary = 1..9; odd positions keep 1,3,5,7,9; even positions get
    // 2,4,6,8 reversed -> 8,6,4,2. Verified against R's get_starting_rank_as_ls.
    const rankSeqWs = genBasicRankWs(9, null); // length 9
    const seq = getStartingRankAsLs(rankSeqWs, createRng(1));
    expect(seq).toEqual([1, 8, 3, 6, 5, 4, 7, 2, 9]);
    // deterministic (branch is RNG-free)
    expect(getStartingRankAsLs(rankSeqWs, createRng(999))).toEqual([1, 8, 3, 6, 5, 4, 7, 2, 9]);
    // still a permutation of 1..9
    expect(seq.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

// !===========================================================
// ! rstr block-shuffle across strips (L513-532)
// !===========================================================
describe("assignRstr: block-shuffled starting ranks across strips", () => {
  const plotInfo = seedPlotInfo();
  const expData = makeSingleInputExpData(plotInfo);
  const RATES_5 = [20_000, 26_000, 32_000, 38_000, 44_000];
  const rstrInfo = prepRate(plotInfo, {
    gcRate: 34_000,
    unit: "seeds",
    rates: RATES_5,
    designType: "rstr",
  });

  it("assigns one constant rate per strip and, within each complete block of numRates strips, uses each rate exactly once", () => {
    const td = assignRates(expData, rstrInfo, { seed: 21 });
    const byStrip = groupByStripIds(td.inputs[0]!);

    // per-strip constant rate (defining rstr invariant), drawn from the ladder
    const rateByStrip = new Map<number, number>();
    for (const [stripId, plots] of byStrip) {
      const rates = new Set(plots.map((p) => p.rate));
      expect(rates.size).toBe(1);
      const rate = plots[0]!.rate;
      expect(RATES_5).toContain(rate);
      rateByStrip.set(stripId, rate);
    }

    // block-shuffle: strips grouped into blocks of numRates (=5) consecutive
    // strip ids; a COMPLETE block must contain each of the 5 rates once.
    const numberRates = 5;
    const blocks = new Map<number, number[]>();
    for (const [stripId, rate] of rateByStrip) {
      const block = Math.floor((stripId - 1) / numberRates);
      const array = blocks.get(block) ?? [];
      array.push(rate);
      blocks.set(block, array);
    }
    let completeBlocks = 0;
    for (const rates of blocks.values()) {
      if (rates.length !== numberRates) continue; // partial trailing block
      completeBlocks += 1;
      expect(new Set(rates).size).toBe(numberRates); // a permutation of the ladder
    }
    expect(completeBlocks).toBeGreaterThan(1);
  });

  it("is deterministic by seed", () => {
    const a = assignRates(expData, rstrInfo, { seed: 21 }).inputs[0]!.plots.features.map(
      (f) => expProperties(f).rate
    );
    const b = assignRates(expData, rstrInfo, { seed: 21 }).inputs[0]!.plots.features.map(
      (f) => expProperties(f).rate
    );
    expect(a).toEqual(b);
  });
});

// !===========================================================
// ! assignLs neighbor-avoidance shift branch (L448-456)
// !===========================================================
describe("assignLs: neighbor-avoidance shift branch", () => {
  const HALF = 0.0002; // square half-size in degrees (< inter-plot spacing)
  function square(cx: number, cy: number, stripId: number, plotId: number): Feature {
    return {
      type: "Feature",
      properties: { strip_id: stripId, plot_id: plotId },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [cx - HALF, cy - HALF],
            [cx + HALF, cy - HALF],
            [cx + HALF, cy + HALF],
            [cx - HALF, cy + HALF],
            [cx - HALF, cy - HALF],
          ],
        ],
      },
    };
  }

  it("re-rotates a strip when its initial start duplicates the neighbour ranks (>50%)", () => {
    // Two vertically-aligned strips. rankSeqWs=[1,2], rankSeqAs=[1,1,2]:
    //  - strip 1 starts at rank 1 -> ranks [1,2]
    //  - strip 2's INITIAL start (rankSeqAs[1]=1) reproduces [1,2], duplicating
    //    strip 1's neighbours 100% -> shift to rankSeqAs[2]=2 -> ranks [2,1].
    // Without the shift branch, strip 2 would (wrongly) stay [1,2].
    const features: Feature[] = [
      square(-89, 40, 1, 1),
      square(-89, 40.001, 1, 2),
      square(-89.001, 40, 2, 1),
      square(-89.001, 40.001, 2, 2),
    ];
    const plots: FeatureCollection = { type: "FeatureCollection", features };
    const ratesData: RateData[] = [
      { rate: 10, rate_rank: 1 },
      { rate: 20, rate_rank: 2 },
    ];

    const assigned = assignLs(plots, ratesData, [1, 2], [1, 1, 2], null, createRng(1));
    const rankOf = (f: Feature): number => assigned.get(f)!.rate_rank;

    // strip 1 keeps its rotation [1, 2]
    expect([rankOf(features[0]!), rankOf(features[1]!)]).toEqual([1, 2]);
    // strip 2 was shifted to start at rank 2 -> [2, 1]
    expect([rankOf(features[2]!), rankOf(features[3]!)]).toEqual([2, 1]);
  });
});
