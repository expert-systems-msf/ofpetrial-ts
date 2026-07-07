// Trial setup — ports of R prep_plot / prep_rate and their helpers
// (ofpetrial 0.1.3, R/prepare_plot_info.R and R/prepare_rate_info.R).
//
// Convention (applies to every ported module): options objects use
// camelCase (idiomatic TS input), returned data structures use snake_case
// (R attribute/tibble-column parity, see design.md D3).
import { FEET_TO_METERS, convUnit, convertRates } from "./units.js";
import { ValidationError } from "./types.js";
import type { PlotInfo, RateData, RateInfo } from "./types.js";

/** R round(): IEC 60559 half-to-even, unlike Math.round's half-up. */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** R seq(from, to, length.out = n). */
function seqLength(from: number, to: number, n: number): number[] {
  if (n === 1) return [from];
  const step = (to - from) / (n - 1);
  return Array.from({ length: n }, (_, index) => from + index * step);
}

/**
 * Port of R `get_lcm`: smallest multiple of the larger width, up to
 * maxPlotWidth, that both widths divide to within 0.05 m. Returns null when
 * none exists. Like R's seq(), maxPlotWidth below the larger width is an
 * error.
 */
export function getLcm(
  sectionWidth: number,
  harvesterWidth: number,
  maxPlotWidth: number
): number | null {
  const greater = Math.max(sectionWidth, harvesterWidth);
  if (maxPlotWidth < greater) {
    throw new ValidationError(
      `max_plot_width (${maxPlotWidth}) is below the larger machine width (${greater})`
    );
  }
  const absDif = (a: number, b: number): number => {
    const quotient = Math.floor(a / b);
    return Math.min(Math.abs(a - quotient * b), Math.abs(a - (quotient + 1) * b));
  };
  // multiply per index like R's seq() — an accumulating += drifts in float
  for (let index = 1; greater * index <= maxPlotWidth; index++) {
    const candidate = greater * index;
    if (absDif(candidate, sectionWidth) <= 0.05 && absDif(candidate, harvesterWidth) <= 0.05) {
      return candidate;
    }
  }
  return null;
}

/**
 * Port of R `find_plotwidth`: the LCM when one fits under maxPlotWidth,
 * otherwise a width-ratio fallback.
 */
export function findPlotWidth(
  sectionWidth: number,
  harvesterWidth: number,
  maxPlotWidth: number
): number {
  const lcm = getLcm(sectionWidth, harvesterWidth, maxPlotWidth);
  if (lcm !== null) return lcm;

  const widthRatio = sectionWidth / harvesterWidth;
  // NOTE (mutation testing): these branches mirror R's find_plotwidth cascade.
  // The `=== 1` / `=== 2` conditions are unreachable (getLcm returns non-null
  // when the ratio is exactly 1 or 2), and for every *reachable* ratio the
  // (1,2) and >2 branches happen to return the same value as the final
  // `ceil(2/ratio)*sectionWidth` fallback — so their `-> false` / boundary
  // (`>=`/`<=`) mutants are genuinely equivalent and survive. We deliberately do
  // NOT `// Stryker disable` them: an `all` suppression would also hide the
  // *killable* `-> true` / `!==` condition mutants, which the ratio>2 and
  // ratio<1 findPlotWidth tests do catch. Leaving them scored keeps the score honest.
  if (widthRatio === 1) return harvesterWidth;
  if (widthRatio > 1 && widthRatio < 2) return 2 * sectionWidth;
  if (widthRatio === 2) return harvesterWidth;
  if (widthRatio > 2) return sectionWidth;
  return Math.ceil(2 / widthRatio) * sectionWidth;
}

/**
 * Port of R `get_rates`: derives the trial-rate ladder from min/max/count,
 * anchored asymmetrically on the grower-chosen rate (gcRate) — more levels
 * on the side of gcRate with more room.
 */
export function getRates(
  minRate: number,
  maxRate: number,
  gcRate: number,
  numberLevels: number
): number[] {
  // Inherited R quirk (utility.R get_rates): with an interior gcRate the
  // returned ladder can differ in length from numLevels (e.g. numLevels = 1
  // yields 2 rates). Consumers must size off rates_data.length, never the
  // requested count.
  if (maxRate === gcRate || minRate === gcRate) {
    return seqLength(minRate, maxRate, numberLevels);
  }

  const difMin = gcRate - minRate;
  const difMax = maxRate - gcRate;
  const numberLevelsTemporary = numberLevels + 1;
  let numberHigh: number;
  let numberLow: number;

  if (difMax > difMin) {
    if (numberLevelsTemporary % 2 === 1) {
      numberHigh = Math.floor(numberLevelsTemporary / 2) + 1;
      numberLow = Math.floor(numberLevelsTemporary / 2);
    } else if (difMax / difMin > 1.5) {
      numberHigh = Math.floor(numberLevelsTemporary / 2) + 1;
      numberLow = Math.floor(numberLevelsTemporary / 2) - 1;
    } else {
      numberHigh = Math.floor(numberLevelsTemporary / 2);
      numberLow = Math.floor(numberLevelsTemporary / 2);
    }
  } else {
    if (numberLevelsTemporary % 2 === 1) {
      numberHigh = Math.floor(numberLevelsTemporary / 2);
      numberLow = Math.floor(numberLevelsTemporary / 2) + 1;
    } else if (difMin / difMax > 1.5) {
      numberHigh = Math.floor(numberLevelsTemporary / 2) - 1;
      numberLow = Math.floor(numberLevelsTemporary / 2) + 1;
    } else {
      numberHigh = Math.floor(numberLevelsTemporary / 2);
      numberLow = Math.floor(numberLevelsTemporary / 2);
    }
  }

  const ratesLow = seqLength(minRate, gcRate, numberLow).map(roundHalfEven);
  const ratesHigh = seqLength(gcRate, maxRate, numberHigh).map(roundHalfEven);
  return [...new Set([...ratesLow, ...ratesHigh])];
}

export interface PrepPlotOptions {
  inputName: string;
  unitSystem: "imperial" | "metric";
  /** Applicator/planter width, in unitSystem units (feet or meters). */
  machineWidth: number;
  sectionNum: number;
  harvesterWidth: number;
  plotWidth?: number;
  headlandLength?: number;
  sideLength?: number;
  maxPlotWidth?: number;
  minPlotLength?: number;
  maxPlotLength?: number;
}

/**
 * Port of R `prep_plot`. Inputs are taken in the unit system's own units;
 * the returned PlotInfo is entirely in meters, like R's tibble.
 */
export function prepPlot(options: PrepPlotOptions): PlotInfo {
  const { inputName, unitSystem, machineWidth, sectionNum, harvesterWidth } = options;
  // Guard the machine dimensions unconditionally (spec trial-setup): R only
  // trips over degenerate widths as a seq() side effect, and only when
  // plot_width is not supplied.
  for (const [name, value] of [
    ["machineWidth", machineWidth],
    ["harvesterWidth", harvesterWidth],
    ["sectionNum", sectionNum],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new ValidationError(`${name} must be a positive finite number, got ${value}`);
    }
  }
  const sectionWidth = machineWidth / sectionNum;

  const defaultFt = (feet: number): number =>
    unitSystem === "imperial" ? feet : feet * FEET_TO_METERS;

  const maxPlotWidth = options.maxPlotWidth ?? defaultFt(120);
  const minPlotLength = options.minPlotLength ?? defaultFt(240);
  const maxPlotLength = options.maxPlotLength ?? defaultFt(300);
  // side length needs to be at least 30 feet
  const sideLength = options.sideLength ?? Math.max(sectionWidth, defaultFt(30));
  const plotWidth = options.plotWidth ?? findPlotWidth(sectionWidth, harvesterWidth, maxPlotWidth);
  const headlandLength = options.headlandLength ?? 2 * machineWidth;

  const toMeters = (v: number): number =>
    unitSystem === "imperial" ? convUnit(v, "feet", "meters") : v;

  return {
    input_name: inputName,
    unit_system: unitSystem,
    machine_width: toMeters(machineWidth),
    section_num: sectionNum,
    section_width: toMeters(sectionWidth),
    harvester_width: toMeters(harvesterWidth),
    plot_width: toMeters(plotWidth),
    headland_length: toMeters(headlandLength),
    side_length: toMeters(sideLength),
    min_plot_length: toMeters(minPlotLength),
    max_plot_length: toMeters(maxPlotLength),
  };
}

export interface PrepRateOptions {
  gcRate: number;
  unit: string;
  rates?: number[];
  minRate?: number;
  maxRate?: number;
  /** Default 5, like R. */
  numRates?: number;
  designType?: string;
  rankSeqWs?: number[];
  rankSeqAs?: number[];
  rateJumpThreshold?: number;
}

/** Port of R `find_rates_data`: rate ladder + ranks per design type. */
function findRatesData(
  gcRate: number,
  rates: number[] | undefined,
  minRate: number | undefined,
  maxRate: number | undefined,
  numberRates: number,
  designType: string | null
): RateData[] {
  // design_type NA always defaults to ls here (rank ordering only)
  const design = designType ?? "ls";

  let ratesLs: number[];
  if (rates !== undefined) {
    ratesLs = rates;
  } else if (minRate !== undefined && maxRate !== undefined) {
    ratesLs = getRates(minRate, maxRate, gcRate, numberRates);
  } else {
    throw new ValidationError(
      "Please provide either rates as a vector or all of minRate, maxRate, and numRates."
    );
  }

  if ((["ls", "str", "rstr", "rb"] as readonly string[]).includes(design)) {
    return ratesLs.map((rate, index) => ({ rate, rate_rank: index + 1 }));
  }
  if (design === "sparse") {
    if (!ratesLs.includes(gcRate)) {
      // R only messages and returns NULL, producing a corrupt rate info;
      // the TS port fails fast instead (documented deviation)
      throw new ValidationError(
        "The rates do not include gcRate. For the sparse design, please include gcRate in the rates."
      );
    }
    const others = ratesLs.filter((r) => r !== gcRate);
    return [gcRate, ...others].map((rate, index) => ({ rate, rate_rank: index + 1 }));
  }
  if (design === "ejca") {
    if (ratesLs.length % 2 === 1) {
      throw new ValidationError(
        "You cannot have an odd number of rates for the ejca design. Please either specify rates directly with an even number of rates or specify an even numRates along with minRate and maxRate."
      );
    }
    return ratesLs.map((rate, index) => ({ rate, rate_rank: index + 1 }));
  }
  throw new ValidationError(
    `design_type "${design}" does not match any of the design type options available.`
  );
}

/** Port of R `prep_rate`. */
export function prepRate(plotInfo: PlotInfo, options: PrepRateOptions): RateInfo {
  const { gcRate, unit } = options;
  const designType = options.designType ?? null;
  const ratesData = findRatesData(
    gcRate,
    options.rates,
    options.minRate,
    options.maxRate,
    options.numRates ?? 5,
    designType
  );

  // A user-supplied rank sequence must be a permutation of 1..num_rates
  // (M4): a shorter/ill-formed sequence would otherwise index out of bounds in
  // assignLs and silently emit duplicated tail strips. R fails loudly here.
  const numRates = ratesData.length;
  const rankSeqOptions = [
    ["rankSeqWs", options.rankSeqWs],
    ["rankSeqAs", options.rankSeqAs],
  ] as const;
  for (const [name, seq] of rankSeqOptions) {
    if (seq === undefined) continue;
    const sorted = seq.toSorted((a, b) => a - b);
    const isPermutation = sorted.length === numRates && sorted.every((v, i) => v === i + 1);
    if (!isPermutation) {
      throw new ValidationError(
        `${name} must be a permutation of 1..${numRates} (the number of rates), got [${seq.join(", ")}].`
      );
    }
  }

  const tgtRateOriginal = ratesData.map((r) => r.rate);
  const tgtRateEquiv = tgtRateOriginal.map((r) => convertRates(plotInfo.input_name, unit, r));

  return {
    input_name: plotInfo.input_name,
    rates_data: ratesData,
    design_type: designType,
    num_rates: ratesData.length,
    gc_rate: gcRate,
    unit,
    tgt_rate_original: tgtRateOriginal,
    tgt_rate_equiv: tgtRateEquiv,
    rank_seq_ws: options.rankSeqWs ?? null,
    rank_seq_as: options.rankSeqAs ?? null,
    rate_jump_threshold: options.rateJumpThreshold ?? null,
  };
}
