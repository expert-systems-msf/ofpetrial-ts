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
  assignRates,
  assignRatesConditional,
  genBasicRankWs,
  genBasicRankWsSparse,
  getRankForRb,
  getRankWsForStrip,
  getRankWsForStripSparse,
  getStartingRankAs,
  getStartingRankAsLs,
} from "./rate-assignment.js";
import { createRng } from "./rng.js";
import { prepPlot, prepRate } from "./trial-setup.js";
import { ValidationError } from "./types.js";
import type { ExpData, InputDesign, PlotInfo, RateInfo } from "./types.js";

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

function expProps(f: Feature): { stripId: number; plotId: number; rate: number; rateRank: number; type: string } {
  const p = f.properties as { strip_id: number; plot_id: number; rate: number; rate_rank: number; type: string };
  return { stripId: p.strip_id, plotId: p.plot_id, rate: p.rate, rateRank: p.rate_rank, type: p.type };
}

function groupByStripIds(input: InputDesign): Map<number, ReturnType<typeof expProps>[]> {
  const map = new Map<number, ReturnType<typeof expProps>[]>();
  for (const f of input.plots.features) {
    const props = expProps(f);
    const arr = map.get(props.stripId) ?? [];
    arr.push(props);
    map.set(props.stripId, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.plotId - b.plotId);
  return map;
}

describe("assignRates: single input (ls design, task 5.2)", () => {
  const plotInfo = seedPlotInfo();
  const expData = makeSingleInputExpData(plotInfo);
  const rateInfo = prepRate(plotInfo, {
    gcRate: 34000,
    unit: "seeds",
    rates: [20000, 26000, 32000, 38000, 44000],
  });

  it("assigns exactly one rate to every experimental plot, and gc_rate to the headland", () => {
    const td = assignRates(expData, rateInfo, { seed: 42 });
    const input = td.inputs[0]!;
    expect(input.plots.features.length).toBeGreaterThan(0);
    for (const f of input.plots.features) {
      const props = expProps(f);
      expect(rateInfo.tgt_rate_original).toContain(props.rate);
      expect(props.rateRank).toBeGreaterThanOrEqual(1);
      expect(props.rateRank).toBeLessThanOrEqual(5);
      expect(props.type).toBe("experiment");
    }
    for (const f of input.headlands.features) {
      expect((f.properties as { rate: number }).rate).toBe(34000);
    }
    expect(td.seed).toBe(42);
  });

  it("balances rate counts within each strip (off by at most 1)", () => {
    const td = assignRates(expData, rateInfo, { seed: 42 });
    const byStrip = groupByStripIds(td.inputs[0]!);
    for (const [, plots] of byStrip) {
      const counts = new Map<number, number>();
      for (const p of plots) counts.set(p.rate, (counts.get(p.rate) ?? 0) + 1);
      const values = [...counts.values()];
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
    }
  });

  it("respects the default rate_jump_threshold between adjacent plots within a strip", () => {
    const td = assignRates(expData, rateInfo, { seed: 7 });
    const threshold = Math.ceil(5 / 2); // default: ceil(numRates / 2)
    const byStrip = groupByStripIds(td.inputs[0]!);
    for (const [, plots] of byStrip) {
      for (let i = 1; i < plots.length; i++) {
        expect(Math.abs(plots[i]!.rateRank - plots[i - 1]!.rateRank)).toBeLessThanOrEqual(threshold);
      }
    }
  });

  it("is deterministic for a given seed", () => {
    const tdA = assignRates(expData, rateInfo, { seed: 123 });
    const tdB = assignRates(expData, rateInfo, { seed: 123 });
    const ratesA = tdA.inputs[0]!.plots.features.map((f) => expProps(f).rate);
    const ratesB = tdB.inputs[0]!.plots.features.map((f) => expProps(f).rate);
    expect(ratesA).toEqual(ratesB);
  });

  it("rejects a RateInfo whose input_name has no match in expData", () => {
    const badRateInfo: RateInfo = { ...rateInfo, input_name: "nope" };
    expect(() => assignRates(expData, badRateInfo)).toThrow(ValidationError);
  });
});

describe("assignRates: sparse design (task 5.1)", () => {
  it("marks roughly every other plot as gc_rate", () => {
    const plotInfo = seedPlotInfo();
    const expData = makeSingleInputExpData(plotInfo);
    const rateInfo = prepRate(plotInfo, {
      gcRate: 32000,
      unit: "seeds",
      rates: [32000, 20000, 26000, 38000, 44000],
      designType: "sparse",
    });

    const td = assignRates(expData, rateInfo, { seed: 5 });
    const byStrip = groupByStripIds(td.inputs[0]!);
    for (const [, plots] of byStrip) {
      const gcCount = plots.filter((p) => p.rate === 32000).length;
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
      gcRate: 34000,
      unit: "seeds",
      rates: [20000, 26000, 32000, 38000, 44000],
    });

    const td = assignRates(expData, seedRateInfo, { seed: 1 });
    const seedInput = td.inputs.find((i) => i.plotInfo.input_name === "seed")!;
    const nh3Input = td.inputs.find((i) => i.plotInfo.input_name === "NH3")!;

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
function twoJointInputs(numRates: number): { expData: ExpData; riA: RateInfo; riB: RateInfo } {
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
  const rates = Array.from({ length: numRates }, (_, i) => 100 + i * 10);
  const riA = prepRate(plotInfoA, { gcRate: rates[0]!, unit: "lb", rates });
  const riB = prepRate(plotInfoB, { gcRate: rates[0]!, unit: "lb", rates: rates.map((r) => r * 2) });
  return { expData, riA, riB };
}

describe("assignRates: two-input joint designing (task 5.2/5.3)", () => {
  it("keeps the correlation between the two rate-rank plans below 0.3 (general case)", () => {
    const { expData, riA, riB } = twoJointInputs(5);
    const td = assignRates(expData, [riA, riB], { seed: 42 });
    const inputA = td.inputs.find((i) => i.plotInfo.input_name === "A")!;
    const inputB = td.inputs.find((i) => i.plotInfo.input_name === "B")!;
    const ranksA = inputA.plots.features.map((f) => expProps(f).rateRank);
    const ranksB = inputB.plots.features.map((f) => expProps(f).rateRank);
    expect(Math.abs(sampleCorrelation(ranksA, ranksB))).toBeLessThan(0.3);
  });

  it("2x2 special case is deterministic regardless of seed", () => {
    const { expData, riA, riB } = twoJointInputs(2);
    const tdSeed1 = assignRates(expData, [riA, riB], { seed: 1 });
    const tdSeed2 = assignRates(expData, [riA, riB], { seed: 999 });
    const ratesOf = (td: typeof tdSeed1, name: string): number[] =>
      td.inputs.find((i) => i.plotInfo.input_name === name)!.plots.features.map((f) => expProps(f).rate);
    expect(ratesOf(tdSeed1, "A")).toEqual(ratesOf(tdSeed2, "A"));
    expect(ratesOf(tdSeed1, "B")).toEqual(ratesOf(tdSeed2, "B"));
  });

  it("every plot gets exactly one rate for both inputs, drawn from that input's ladder", () => {
    const { expData, riA, riB } = twoJointInputs(5);
    const td = assignRates(expData, [riA, riB], { seed: 3 });
    for (const input of td.inputs) {
      for (const f of input.plots.features) {
        expect(input.rateInfo!.tgt_rate_original).toContain(expProps(f).rate);
      }
    }
  });
});

describe("assignRatesConditional (task 5.3)", () => {
  it("balances joint (rateA, rateB) combinations and keeps correlation below 0.3", () => {
    const { expData, riA, riB } = twoJointInputs(5);
    const partial = assignRates(expData, riA, { seed: 42 });
    const conditioned = assignRatesConditional(expData, riB, partial, { seed: 42 });

    const inputA = conditioned.inputs.find((i) => i.plotInfo.input_name === "A")!;
    const inputB = conditioned.inputs.find((i) => i.plotInfo.input_name === "B")!;
    expect(inputB.rateInfo).not.toBeNull();

    const ranksA = inputA.plots.features.map((f) => expProps(f).rateRank);
    const ranksB = inputB.plots.features.map((f) => expProps(f).rateRank);
    expect(ranksB.length).toBe(ranksA.length);
    expect(Math.abs(sampleCorrelation(ranksA, ranksB))).toBeLessThan(0.3);

    const counts = new Map<number, number>();
    for (const r of ranksB) counts.set(r, (counts.get(r) ?? 0) + 1);
    const values = [...counts.values()];
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(Math.ceil(ranksB.length * 0.2));
  });

  it("rejects an array of RateInfo", () => {
    const { expData, riA, riB } = twoJointInputs(5);
    const partial = assignRates(expData, riA, { seed: 1 });
    expect(() => assignRatesConditional(expData, [riB], partial)).toThrow(ValidationError);
  });

  it("rejects a mono-input existingDesign", () => {
    const { expData, riA, riB } = twoJointInputs(5);
    const monoInput = assignRates({ inputs: [expData.inputs[0]!] }, riA, { seed: 1 });
    expect(() => assignRatesConditional(expData, riB, monoInput)).toThrow(ValidationError);
  });

  it("rejects an existingDesign whose second input is already dosed", () => {
    const { expData, riA, riB } = twoJointInputs(5);
    const fullyDosed = assignRates(expData, [riA, riB], { seed: 1 });
    expect(() => assignRatesConditional(expData, riB, fullyDosed)).toThrow(ValidationError);
  });
});

describe("assignRates: str / rstr / rb / ejca designs (task 5.1)", () => {
  const plotInfo = seedPlotInfo();
  const expData = makeSingleInputExpData(plotInfo);
  const RATES_5 = [20000, 26000, 32000, 38000, 44000];
  const RATES_4 = [20000, 26000, 38000, 44000];

  function rateInfoFor(designType: string, rates: number[]): RateInfo {
    return prepRate(plotInfo, { gcRate: 34000, unit: "seeds", rates, designType });
  }

  function assertOneRateFromLadder(designType: string, rates: number[]): void {
    const td = assignRates(expData, rateInfoFor(designType, rates), { seed: 11 });
    const input = td.inputs[0]!;
    expect(input.plots.features.length).toBeGreaterThan(0);
    for (const f of input.plots.features) {
      expect(rates).toContain(expProps(f).rate);
    }
  }

  function assertDeterministicBySeed(designType: string, rates: number[]): void {
    const ri = rateInfoFor(designType, rates);
    const a = assignRates(expData, ri, { seed: 77 }).inputs[0]!.plots.features.map((f) => expProps(f).rate);
    const b = assignRates(expData, ri, { seed: 77 }).inputs[0]!.plots.features.map((f) => expProps(f).rate);
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
    const numRates = 5;
    const td = assignRates(expData, rateInfoFor("rb", RATES_5), { seed: 13 });
    const input = td.inputs[0]!;
    // Recompute R's block partition: block_row/block_col by integer division.
    const byBlock = new Map<string, number[]>();
    for (const f of input.plots.features) {
      const { stripId, plotId, rateRank } = expProps(f);
      const key = `${Math.floor((plotId - 1) / numRates) + 1}:${Math.floor((stripId - 1) / numRates) + 1}`;
      const arr = byBlock.get(key) ?? [];
      arr.push(rateRank);
      byBlock.set(key, arr);
    }
    expect(byBlock.size).toBeGreaterThan(1);
    for (const ranks of byBlock.values()) {
      const counts = new Map<number, number>();
      for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
      const values = [...counts.values()];
      // partial border blocks: counts differ by at most 1
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
      if (ranks.length % numRates === 0) {
        // complete blocks: each rate appears exactly ranks.length / numRates times
        expect(counts.size).toBe(numRates);
        for (const v of values) expect(v).toBe(ranks.length / numRates);
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
  const layout = makeExpPlots({ inputPlotInfo: plotInfo, boundary: holesBoundary, abLine: holesAbLine });
  const rateInfo = prepRate(plotInfo, {
    gcRate: 34000,
    unit: "seeds",
    rates: [20000, 26000, 32000, 38000, 44000],
  });

  it("the fixture actually contains a hole-split strip (duplicate plot_ids)", () => {
    const seen = new Set<string>();
    let hasDuplicate = false;
    for (const f of layout.inputs[0]!.plots.features) {
      const { stripId, plotId } = expProps(f);
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
    for (let i = 0; i < inputFeatures.length; i++) {
      expect(JSON.stringify(outputFeatures[i]!.geometry)).toBe(JSON.stringify(inputFeatures[i]!.geometry));
      expect(expProps(outputFeatures[i]!).stripId).toBe(expProps(inputFeatures[i]!).stripId);
      expect(expProps(outputFeatures[i]!).plotId).toBe(expProps(inputFeatures[i]!).plotId);
    }
  });

  it("within each strip, ranks follow the within-strip rotation over the FEATURE order (not plot_id order)", () => {
    const td = assignRates(layout, rateInfo, { seed: 42 });
    const basicSeq = genBasicRankWs(5, null);
    const byStrip = new Map<number, number[]>();
    for (const f of td.inputs[0]!.plots.features) {
      const { stripId, rateRank } = expProps(f);
      const arr = byStrip.get(stripId) ?? [];
      arr.push(rateRank);
      byStrip.set(stripId, arr);
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
    expect([...seq].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(getStartingRankAsLs(rankSeqWs, createRng(42))).toEqual(seq);

    // R filter property: no diagonal (up or down) of the rotated-rank matrix
    // is constant across all rows (check_0_diagonal_up/down < num_rates).
    const n = 5;
    const mat = seq.map((x) => getRankWsForStrip(x, rankSeqWs));
    for (const colDelta of [-1, 1]) {
      for (let j = 0; j < n; j++) {
        let zeros = 0;
        for (let i = 0; i < n; i++) {
          const shifted = mat[(i + 1) % n]![(((j + colDelta) % n) + n) % n]!;
          if (mat[i]![j]! - shifted === 0) zeros += 1;
        }
        expect(zeros).toBeLessThan(n);
      }
    }
  });

  it("getStartingRankAs: permutation of 1..n, deterministic by seed", () => {
    const seq = getStartingRankAs(4, createRng(7));
    expect([...seq].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(getStartingRankAs(4, createRng(7))).toEqual(seq);
    expect(getStartingRankAs(1, createRng(7))).toEqual([1]);
  });

  it("getRankForRb: complete permutation per numRates chunk, distinct remainder, deterministic", () => {
    const ranks = getRankForRb(5, 12, createRng(3));
    expect(ranks).toHaveLength(12);
    expect([...ranks.slice(0, 5)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect([...ranks.slice(5, 10)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
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
      gcRate: 34000,
      unit: "seeds",
      rates: [20000, 26000, 32000, 38000, 44000],
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
