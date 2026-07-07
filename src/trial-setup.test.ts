import { describe, expect, it } from "vitest";
import {
  findPlotWidth,
  getLcm,
  getRates,
  prepPlot,
  prepRate,
  roundHalfEven,
} from "./trial-setup.js";
import { ValidationError } from "./types.js";

describe("getLcm / findPlotWidth", () => {
  it("finds the least common multiple within the bound", () => {
    expect(getLcm(30, 60, 120)).toBe(60);
    expect(findPlotWidth(30, 60, 120)).toBe(60);
  });

  it("returns null when no multiple fits", () => {
    expect(getLcm(50, 30, 60)).toBeNull();
  });

  it("falls back to twice the section width for 1 < ratio < 2", () => {
    expect(findPlotWidth(50, 30, 60)).toBe(100);
  });

  it("returns the section width for ratio > 2", () => {
    // getLcm(70, 30, 120) finds no near-multiple → ratio 70/30 = 2.33 > 2.
    expect(findPlotWidth(70, 30, 120)).toBe(70);
  });

  it("scales up a narrow section (ratio < 1) to cover the harvester", () => {
    // getLcm(30, 50, 120) is null → ratio 0.6 → ceil(2/0.6)*30 = 4*30 = 120.
    expect(findPlotWidth(30, 50, 120)).toBe(120);
  });

  it("rejects a bound below the larger width, like R's seq()", () => {
    const act = () => getLcm(30, 30, 20);
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/is below the larger machine width/);
  });

  it("accepts near-multiples within the 0.05 m tolerance", () => {
    expect(getLcm(2.5008, 30, 120)).toBe(30);
  });
});

describe("roundHalfEven", () => {
  it("rounds away from .5 for non-ties", () => {
    expect(roundHalfEven(2.6)).toBe(3);
    expect(roundHalfEven(2.3)).toBe(2);
  });

  it("breaks exact .5 ties toward the even integer (banker's rounding)", () => {
    expect(roundHalfEven(2.5)).toBe(2); // floor 2 is even
    expect(roundHalfEven(3.5)).toBe(4); // floor 3 is odd
    expect(roundHalfEven(4.5)).toBe(4);
    expect(roundHalfEven(5.5)).toBe(6);
  });
});

describe("getRates", () => {
  it("uses a plain even ladder when gcRate sits on a boundary", () => {
    expect(getRates(100, 260, 260, 4)).toEqual([100, 100 + 160 / 3, 100 + 320 / 3, 260]);
    expect(getRates(100, 260, 100, 4)).toEqual([100, 100 + 160 / 3, 100 + 320 / 3, 260]);
  });

  it("puts more levels on the roomier side of gcRate", () => {
    const high = getRates(100, 260, 120, 5);
    expect(high.filter((r) => r > 120).length).toBeGreaterThan(high.filter((r) => r < 120).length);
    // Exact ladder pins the asymmetric split arithmetic (difMax/difMin > 1.5,
    // the even/odd level rebalance and the roundHalfEven rounding).
    expect(high).toEqual([100, 120, 167, 213, 260]);
    const low = getRates(100, 260, 240, 5);
    expect(low.filter((r) => r < 240).length).toBeGreaterThan(low.filter((r) => r > 240).length);
    expect(low).toEqual([100, 147, 193, 240, 260]);
  });

  it("always includes gcRate on asymmetric splits", () => {
    expect(getRates(100, 260, 120, 4)).toContain(120);
    expect(getRates(100, 260, 190, 5)).toContain(190);
  });
});

describe("prepPlot", () => {
  it("derives defaults and stores everything in meters (imperial)", () => {
    const pi = prepPlot({
      inputName: "seed",
      unitSystem: "imperial",
      machineWidth: 60,
      sectionNum: 24,
      harvesterWidth: 30,
    });
    expect(pi.machine_width).toBeCloseTo(60 * 0.3048, 10);
    expect(pi.section_width).toBeCloseTo(2.5 * 0.3048, 10);
    expect(pi.plot_width).toBeCloseTo(30 * 0.3048, 10);
    expect(pi.headland_length).toBeCloseTo(120 * 0.3048, 10);
    expect(pi.side_length).toBeCloseTo(30 * 0.3048, 10);
    expect(pi.min_plot_length).toBeCloseTo(240 * 0.3048, 10);
    expect(pi.max_plot_length).toBeCloseTo(300 * 0.3048, 10);
  });

  it("keeps metric inputs unconverted", () => {
    const pi = prepPlot({
      inputName: "seed",
      unitSystem: "metric",
      machineWidth: 18,
      sectionNum: 24,
      harvesterWidth: 9,
    });
    expect(pi.machine_width).toBe(18);
    expect(pi.harvester_width).toBe(9);
    expect(pi.headland_length).toBe(36);
    expect(pi.min_plot_length).toBeCloseTo(240 * 0.3048, 10);
  });

  it("rejects zero, negative or non-finite machine dimensions", () => {
    const base = {
      inputName: "seed",
      unitSystem: "imperial" as const,
      machineWidth: 60,
      sectionNum: 24,
      harvesterWidth: 30,
    };
    expect(() => prepPlot({ ...base, machineWidth: 0 })).toThrow(ValidationError);
    expect(() => prepPlot({ ...base, machineWidth: 0 })).toThrow(
      /must be a positive finite number/
    );
    expect(() => prepPlot({ ...base, machineWidth: -60 })).toThrow(ValidationError);
    expect(() => prepPlot({ ...base, machineWidth: NaN })).toThrow(ValidationError);
    expect(() => prepPlot({ ...base, sectionNum: 0 })).toThrow(ValidationError);
    // guard runs even when plotWidth is supplied (R skips it in that case)
    expect(() => prepPlot({ ...base, sectionNum: 0, plotWidth: 30 })).toThrow(ValidationError);
    expect(() => prepPlot({ ...base, harvesterWidth: -1 })).toThrow(ValidationError);
  });

  it("honors explicit widths and lengths", () => {
    const pi = prepPlot({
      inputName: "seed",
      unitSystem: "imperial",
      machineWidth: 60,
      sectionNum: 24,
      harvesterWidth: 30,
      plotWidth: 30,
      headlandLength: 90,
      sideLength: 60,
    });
    expect(pi.plot_width).toBeCloseTo(30 * 0.3048, 10);
    expect(pi.headland_length).toBeCloseTo(90 * 0.3048, 10);
    expect(pi.side_length).toBeCloseTo(60 * 0.3048, 10);
  });
});

describe("prepRate", () => {
  const pi = prepPlot({
    inputName: "seed",
    unitSystem: "imperial",
    machineWidth: 60,
    sectionNum: 24,
    harvesterWidth: 30,
  });

  it("freezes explicit rates with sequential ranks", () => {
    const ri = prepRate(pi, {
      gcRate: 34_000,
      unit: "seeds",
      rates: [20_000, 26_000, 32_000, 38_000, 44_000],
    });
    expect(ri.rates_data.map((r) => r.rate)).toEqual([20_000, 26_000, 32_000, 38_000, 44_000]);
    expect(ri.rates_data.map((r) => r.rate_rank)).toEqual([1, 2, 3, 4, 5]);
    expect(ri.design_type).toBeNull(); // NA in R; ls applies at assignment
    expect(ri.num_rates).toBe(5);
    expect(ri.tgt_rate_equiv).toEqual([20_000, 26_000, 32_000, 38_000, 44_000]); // passthrough
  });

  it("derives rates from min/max anchored on gcRate", () => {
    const ri = prepRate(pi, {
      gcRate: 180,
      unit: "lb",
      minRate: 100,
      maxRate: 260,
      numRates: 4,
    });
    expect(Math.min(...ri.tgt_rate_original)).toBe(100);
    expect(Math.max(...ri.tgt_rate_original)).toBe(260);
    expect(ri.num_rates).toBe(4);
  });

  it("reorders sparse rates with gcRate first (rank 1)", () => {
    const ri = prepRate(pi, {
      gcRate: 34_000,
      unit: "seeds",
      rates: [20_000, 27_000, 34_000, 41_000, 48_000],
      designType: "sparse",
    });
    expect(ri.rates_data[0]).toEqual({ rate: 34_000, rate_rank: 1 });
    expect(ri.rates_data).toHaveLength(5);
  });

  it("rejects sparse without gcRate in the rates (R: silent corrupt output)", () => {
    const act = () =>
      prepRate(pi, {
        gcRate: 34_000,
        unit: "seeds",
        rates: [20_000, 27_000, 41_000, 48_000],
        designType: "sparse",
      });
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/do not include gcRate/);
  });

  it("rejects odd ejca rate counts and unknown design types", () => {
    expect(() =>
      prepRate(pi, { gcRate: 1, unit: "lb", rates: [1, 2, 3], designType: "ejca" })
    ).toThrow(/odd number/);
    expect(() =>
      prepRate(pi, { gcRate: 1, unit: "lb", rates: [1, 2, 3], designType: "jcls" })
    ).toThrow(/design type/);
  });

  it("requires a rate specification", () => {
    const act = () => prepRate(pi, { gcRate: 1, unit: "lb" });
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/provide either rates as a vector/);
  });

  it("carries rank sequences and the rate jump threshold", () => {
    const ri = prepRate(pi, {
      gcRate: 34_000,
      unit: "seeds",
      rates: [1, 2, 3, 4, 5],
      rankSeqWs: [1, 3, 5, 2, 4],
      rankSeqAs: [2, 4, 1, 3, 5],
      rateJumpThreshold: 2,
    });
    expect(ri.rank_seq_ws).toEqual([1, 3, 5, 2, 4]);
    expect(ri.rank_seq_as).toEqual([2, 4, 1, 3, 5]);
    expect(ri.rate_jump_threshold).toBe(2);
  });

  // Regression for audit M4: a rankSeqAs/rankSeqWs that is not a permutation of
  // 1..num_rates previously indexed out of bounds in assignLs and silently
  // produced duplicated tail strips. prepRate must reject it (R fails loudly).
  it("rejects a rankSeqAs shorter than num_rates", () => {
    expect(() =>
      prepRate(pi, {
        gcRate: 1,
        unit: "lb",
        rates: [1, 2, 3, 4, 5],
        rankSeqAs: [2, 4],
      })
    ).toThrow(/permutation of 1\.\.5/);
  });

  it("rejects a rankSeqWs that is not a permutation of 1..num_rates", () => {
    expect(() =>
      prepRate(pi, {
        gcRate: 1,
        unit: "lb",
        rates: [1, 2, 3, 4, 5],
        rankSeqWs: [1, 2, 3, 4, 4], // wrong: 5 missing, 4 duplicated
      })
    ).toThrow(/rankSeqWs must be a permutation of 1\.\.5/);
  });

  it("accepts a valid permutation rankSeqAs and stores it verbatim", () => {
    const ri = prepRate(pi, {
      gcRate: 1,
      unit: "lb",
      rates: [1, 2, 3, 4, 5],
      rankSeqAs: [5, 4, 3, 2, 1],
    });
    expect(ri.rank_seq_as).toEqual([5, 4, 3, 2, 1]);
    expect(ri.rates_data.map((r) => r.rate)).toEqual([1, 2, 3, 4, 5]);
    expect(ri.num_rates).toBe(5);
  });
});
