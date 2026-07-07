// Rate assignment — port of R assign_rates() / assign_rates_conditional() /
// add_blocks() / change_rates() and their internal helpers
// (ofpetrial 0.1.3, R/assign_rates.R and R/change_rates.R).
//
// Convention (see trial-setup.ts): camelCase for TS-facing options, snake_case
// for R-attribute-parity data (GeoJSON feature properties, RateInfo/RateData).
//
// RNG usage (design.md D4): every R sample()/replicate(sample(...)) call is
// replaced by the injected seedable Rng (src/rng.ts). Parity on the
// randomized parts is judged by properties (balance, determinism-by-seed,
// one rate per plot, rate-jump respect, joint-design correlation), never by
// reproducing R's actual random sequence.
import centroid from "@turf/centroid";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { toUtm } from "./projection.js";
import type { Rng } from "./rng.js";
import { createRng } from "./rng.js";
import { ValidationError } from "./types.js";
import type {
  ExpData,
  InputDesign,
  InputLayout,
  RateData,
  RateInfo,
  TrialDesign,
} from "./types.js";

// !===========================================================
// ! Small generic utilities
// !===========================================================

export function rangeStep(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  if (step > 0) {
    for (let v = from; v <= to; v += step) out.push(v);
  } else {
    for (let v = from; v >= to; v += step) out.push(v);
  }
  return out;
}

/** R `1:n` (or `from:to`, always ascending here). */
function range(from: number, to: number): number[] {
  return rangeStep(from, to, 1);
}

function repeatArray<T>(array: T[], times: number): T[] {
  const out: T[] = [];
  for (let index = 0; index < times; index++) out.push(...array);
  return out;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * All permutations of `arr`, in the same order R's recursive
 * `return_permutations` produces (fix element i first, recurse on the rest) —
 * matters because both `gen_basic_rank_ws` and `get_starting_rank_as_ls`
 * break ties by taking the first-encountered best permutation.
 */
function allPermutations<T>(array: T[]): T[][] {
  if (array.length <= 1) return [[...array]];
  const out: T[][] = [];
  for (let index = 0; index < array.length; index++) {
    const rest = [...array.slice(0, index), ...array.slice(index + 1)];
    for (const p of allPermutations(rest)) out.push([array[index]!, ...p]);
  }
  return out;
}

/** `.GRP` semantics: group id (1-based) assigned by order of first appearance. */
export function groupIdsByFirstAppearance<T>(
  items: T[],
  keyFunction: (item: T) => string
): number[] {
  const seen = new Map<string, number>();
  let next = 1;
  return items.map((item) => {
    const key = keyFunction(item);
    let id = seen.get(key);
    if (id === undefined) {
      id = next;
      next += 1;
      seen.set(key, id);
    }
    return id;
  });
}

// !===========================================================
// ! Plot geometry helpers (UTM centroids, per-strip grouping)
// !===========================================================

function plotProperties(f: Feature): { stripId: number; plotId: number } {
  const p = f.properties as { strip_id: number; plot_id: number };
  return { stripId: p.strip_id, plotId: p.plot_id };
}

/**
 * Groups plot features by strip_id, preserving the input feature order within
 * each strip (R: dplyr::filter keeps exp_sf row order; plot-layout emits
 * features in physical along-strip order). Never re-sort by plot_id — on
 * hole-split strips plot_id restarts per piece, so sorting would interleave
 * the pieces and scramble the physical order.
 */
function groupByStrip(plots: FeatureCollection): Map<number, Feature[]> {
  const map = new Map<number, Feature[]>();
  for (const f of plots.features) {
    const { stripId } = plotProperties(f);
    const array = map.get(stripId) ?? [];
    array.push(f);
    map.set(stripId, array);
  }
  return map;
}

function firstEpsg(features: Feature[]): number {
  const f = features[0];
  if (!f) throw new ValidationError("Cannot assign rates to an empty plot collection.");
  const c = centroid(f as Feature<Polygon | MultiPolygon>).geometry.coordinates as [number, number];
  return toUtm(c).epsg;
}

function utmCentroid(f: Feature, epsg: number): [number, number] {
  const c = centroid(f as Feature<Polygon | MultiPolygon>).geometry.coordinates as [number, number];
  return toUtm(c, epsg).point;
}

function distribution2(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function distance(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// !===========================================================
// ! Deterministic rank-sequence primitives (R: gen_basic_rank_ws family)
// !===========================================================

/**
 * R `get_rank_ws_for_strip`: rotates `basicSeq` to start at `startingRank`
 * (the dedup-by-index in R's `unique(c(f_seq, s_seq))` is just array rotation).
 */
export function getRankWsForStrip(startingRank: number, basicSeq: number[]): number[] {
  const index = basicSeq.indexOf(startingRank);
  return [...basicSeq.slice(index), ...basicSeq.slice(0, index)];
}

/** R `get_rank_ws_for_strip_sparse`. */
export function getRankWsForStripSparse(
  startingRank: number,
  basicSeq: number[],
  stripId: number
): number[] {
  const rotated = getRankWsForStrip(startingRank, basicSeq);
  return stripId % 2 === 0 ? [1, ...rotated.slice(0, -1)] : rotated;
}

/**
 * R `gen_basic_rank_ws_sparse`: within-strip rank sequence for the sparse
 * design, with gc_rate (rank 1) interleaved every other position.
 */
export function genBasicRankWsSparse(length: number): number[] {
  const base =
    length % 2 === 0
      ? [...rangeStep(1, length, 2), ...rangeStep(length, 2, -2)]
      : [...rangeStep(1, length, 2), ...rangeStep(length - 1, 2, -2)];
  const seq = base.slice(1);
  const nInsert = 2 * seq.length - 1;
  for (let index = 1; index <= nInsert; index += 2) seq.splice(index, 0, 1);
  return seq;
}

/**
 * R `gen_basic_rank_ws`: within-strip rank sequence keeping rate jumps under
 * `rateJumpThreshold` (default ceil(numRates/2)), chosen deterministically
 * (least jump/zigzag score, first tie wins — no randomness here, unlike most
 * of this module).
 */
export function genBasicRankWs(numberRates: number, rateJumpThresholdIn: number | null): number[] {
  const rateJumpThreshold = rateJumpThresholdIn ?? Math.ceil(numberRates / 2);

  if (numberRates >= 9) {
    return numberRates % 2 === 0
      ? [...rangeStep(1, numberRates, 2), ...rangeStep(numberRates, 2, -2)]
      : [...rangeStep(1, numberRates, 2), ...rangeStep(numberRates - 1, 2, -2)];
  }
  if (numberRates === 2) return [1, 2];

  const perms = allPermutations(range(1, numberRates));
  let bestId = -1;
  let bestScore = Infinity;
  for (const [index, perm] of perms.entries()) {
    const seq = perm!;
    const diffs = seq.map((v, index) => v - seq[(index + 1) % seq.length]!);
    const maxJump = Math.max(...diffs.map((d) => Math.abs(d)));
    if (maxJump > rateJumpThreshold) continue;
    const jumpScore = diffs.reduce((a, d) => a + d * d, 0);
    const rolling = diffs.slice(0, -1).map((d, index) => d + diffs[index + 1]!);
    const zigzagScore = rolling.reduce((a, d) => a + Math.abs(d), 0) ** 2;
    const totalScore = jumpScore + zigzagScore;
    if (totalScore < bestScore) {
      bestScore = totalScore;
      bestId = index;
    }
  }
  if (bestId === -1) {
    throw new ValidationError(
      `No rank sequence for ${numberRates} rates satisfies rate_jump_threshold=${rateJumpThreshold}.`
    );
  }
  return perms[bestId]!;
}

// !===========================================================
// ! Randomized rank-sequence primitives (R: get_starting_rank_as family)
// !===========================================================

/** R `get_starting_rank_as` (design_type "str"/"sparse" across-strip rotation). */
export function getStartingRankAs(numberLevels: number, rng: Rng): number[] {
  if (numberLevels <= 1) return [1];
  const perms = allPermutations(range(1, numberLevels));
  let bestScore = -Infinity;
  let best: number[][] = [];
  for (const seq of perms) {
    let sum = 0;
    for (let index = 0; index < numberLevels; index++) {
      const diff = seq[index]! - seq[(index + 1) % numberLevels]!;
      sum += diff * diff;
    }
    const score = sum / numberLevels;
    if (score > bestScore) {
      bestScore = score;
      best = [seq];
    } else if (score === bestScore) {
      best.push(seq);
    }
  }
  return rng.sample(best, 1)[0]!;
}

export function circShift(mat: number[][], rowDelta: number, colDelta: number): number[][] {
  const n = mat.length;
  const m = mat[0]!.length;
  const out: number[][] = [];
  for (let index = 0; index < n; index++) {
    const si = (((index + rowDelta) % n) + n) % n;
    const row: number[] = [];
    for (let index = 0; index < m; index++) {
      const sj = (((index + colDelta) % m) + m) % m;
      row.push(mat[si]![sj]!);
    }
    out.push(row);
  }
  return out;
}

export function matSub(a: number[][], b: number[][]): number[][] {
  return a.map((row, index) => row.map((v, index_) => v - b[index]![index_]!));
}

export function maxOverColumns(mat: number[][], pred: (v: number) => number): number {
  const cols = mat[0]!.length;
  let best = -Infinity;
  for (let index = 0; index < cols; index++) {
    let sum = 0;
    for (const row of mat) sum += pred(row[index]!);
    if (sum > best) best = sum;
  }
  return best;
}

export function meanAbs(mat: number[][]): number {
  let sum = 0;
  let count = 0;
  for (const row of mat)
    for (const v of row) {
      sum += Math.abs(v);
      count += 1;
    }
  return count === 0 ? 0 : sum / count;
}

export function meanAbsSum(a: number[][], b: number[][]): number {
  let sum = 0;
  let count = 0;
  for (const [index, element] of a.entries()) {
    for (let index_ = 0; index_ < element!.length; index_++) {
      sum += Math.abs(element![index_]!) + Math.abs(b[index]![index_]!);
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * R `get_starting_rank_as_ls`: across-strip starting-rank sequence for the
 * "ls" design, avoiding gradual (horizontal/diagonal) rank drift across
 * strips. num_rates <= 3 has no degrees of freedom (any permutation is
 * random); >= 9 gives up on the search (deterministic interleave); 4..8 does
 * the full permutation search R does.
 */
export function getStartingRankAsLs(rankSeqWs: number[], rng: Rng): number[] {
  const numberRates = rankSeqWs.length;

  if (numberRates <= 3) return rng.shuffle(range(1, numberRates));

  if (numberRates >= 9) {
    const temporary = range(1, numberRates);
    const out: number[] = Array.from({ length: numberRates });
    const evenPositions: number[] = [];
    for (let index = 0; index < numberRates; index++)
      if ((index + 1) % 2 === 0) evenPositions.push(index);
    const evenValsReversed = evenPositions.map((index) => temporary[index]!).toReversed();
    for (const [k, index] of evenPositions.entries()) {
      out[index] = evenValsReversed[k]!;
    }
    for (let index = 0; index < numberRates; index++)
      if ((index + 1) % 2 !== 0) out[index] = temporary[index]!;
    return out;
  }

  const perms = allPermutations(range(1, numberRates));
  const scored = perms.map((seq) => {
    const mat = seq.map((x) => getRankWsForStrip(x, rankSeqWs));
    const matDif = matSub(mat, circShift(mat, 1, 0));
    const diagUp = matSub(mat, circShift(mat, 1, -1));
    const diagDown = matSub(mat, circShift(mat, 1, 1));
    return {
      seq,
      check1Horizontal: maxOverColumns(matDif, (v) => (Math.abs(v) === 1 ? 1 : 0)),
      check0DiagUp: maxOverColumns(diagUp, (v) => (Math.abs(v) === 0 ? 1 : 0)),
      check0DiagDown: maxOverColumns(diagDown, (v) => (Math.abs(v) === 0 ? 1 : 0)),
      score: meanAbs(matDif) + meanAbsSum(diagUp, diagDown),
    };
  });

  const minCheck1 = Math.min(...scored.map((s) => s.check1Horizontal));
  let filtered = scored.filter(
    (s) =>
      s.check1Horizontal <= minCheck1 + 2 &&
      s.check0DiagUp < numberRates &&
      s.check0DiagDown < numberRates
  );
  if (filtered.length === 0) filtered = scored; // defensive: R's own filters would leave 0 rows too

  const maxScore = Math.max(...filtered.map((s) => s.score));
  const tied = filtered.filter((s) => s.score === maxScore);
  return rng.sample(tied, 1)[0]!.seq;
}

/** R `get_rank_for_rb`: full-block random permutations plus a random remainder. */
export function getRankForRb(numberRates: number, numberPlots: number, rng: Rng): number[] {
  const nCompBlock = Math.floor(numberPlots / numberRates);
  const nRemaining = numberPlots % numberRates;
  const out: number[] = [];
  for (let b = 0; b < nCompBlock; b++) out.push(...rng.shuffle(range(1, numberRates)));
  out.push(...rng.sample(range(1, numberRates), nRemaining));
  return out;
}

// !===========================================================
// ! Per-design-type assignment (R: assign_rates_by_input branches)
// !===========================================================

export function assignLs(
  plots: FeatureCollection,
  ratesData: RateData[],
  rankSeqWsIn: number[] | null,
  rankSeqAsIn: number[] | null,
  rateJumpThreshold: number | null,
  rng: Rng
): Map<Feature, RateData> {
  const numberRates = ratesData.length;
  let rankSeqWs = rankSeqWsIn;
  let rankSeqAs = rankSeqAsIn;
  if (rankSeqWs === null && rankSeqAs === null) {
    rankSeqWs = genBasicRankWs(numberRates, rateJumpThreshold);
    rankSeqAs = getStartingRankAsLs(rankSeqWs, rng);
  } else if (rankSeqWs !== null && rankSeqAs === null) {
    rankSeqAs = getStartingRankAsLs(rankSeqWs, rng);
  } else if (rankSeqWs === null && rankSeqAs !== null) {
    rankSeqWs = genBasicRankWs(numberRates, rateJumpThreshold);
  }
  // else: both specified, use as-is (R message about respecting the specified
  // sequences skipped — no effect on the returned design).

  const stripGroups = groupByStrip(plots);
  const stripIds = stripGroups.keys().toArray();
  const maxStripId = stripIds.length === 0 ? 0 : Math.max(...stripIds);
  // Size the repeat off maxStripId, not numberRates (M4): the access index is
  // `index - 1 + shiftCounter`, with shiftCounter growing up to once per strip,
  // so the worst-case index approaches 2*maxStripId. Deriving reps from
  // rankSeqAs.length keeps this correct even if a caller supplies a rankSeqAs
  // shorter than numberRates (prepRate now rejects that, but stay defensive).
  const reps = Math.ceil((2 * maxStripId + 5) / rankSeqAs!.length) + 1;
  const fullStartSeqLong = repeatArray(rankSeqAs!, reps);

  const epsg = firstEpsg(plots.features);
  const centroidsByStrip = new Map<number, Array<[number, number]>>();
  for (const [sid, feats] of stripGroups) {
    centroidsByStrip.set(
      sid,
      feats.map((f) => utmCentroid(f, epsg))
    );
  }

  const result = new Map<Feature, RateData>();
  const finishedRanks = new Map<number, number[]>();
  let shiftCounter = 0;

  for (let index = 1; index <= maxStripId; index++) {
    const workingFeatures = stripGroups.get(index) ?? [];
    const numberPlotsWs = workingFeatures.length;
    let startRank = fullStartSeqLong[index - 1 + shiftCounter]!;
    let rateRanks = repeatArray(
      getRankWsForStrip(startRank, rankSeqWs!),
      Math.ceil(numberPlotsWs / rankSeqWs!.length)
    ).slice(0, numberPlotsWs);

    if (index > 1) {
      const previousCentroids = centroidsByStrip.get(index - 1) ?? [];
      const previousRanks = finishedRanks.get(index - 1) ?? [];
      const currentCentroids = centroidsByStrip.get(index)!;
      const neighborRanks = currentCentroids.map((c) => {
        let bestIndex = 0;
        let bestDistribution = Infinity;
        for (const [k, previousCentroid] of previousCentroids.entries()) {
          const d = distribution2(c, previousCentroid!);
          if (d < bestDistribution) {
            bestDistribution = d;
            bestIndex = k;
          }
        }
        return previousRanks[bestIndex];
      });
      const duplicationScore = mean(rateRanks.map((r, k) => (r === neighborRanks[k] ? 1 : 0)));
      if (duplicationScore > 0.5) {
        shiftCounter += 1;
        startRank = fullStartSeqLong[index - 1 + shiftCounter]!;
        rateRanks = repeatArray(
          getRankWsForStrip(startRank, rankSeqWs!),
          Math.ceil(numberPlotsWs / rankSeqWs!.length)
        ).slice(0, numberPlotsWs);
      }
    }

    finishedRanks.set(index, rateRanks);
    workingFeatures.forEach((f, k) => result.set(f, ratesData[rateRanks[k]! - 1]!));
  }

  return result;
}

export function assignRb(
  plots: FeatureCollection,
  ratesData: RateData[],
  rng: Rng
): Map<Feature, RateData> {
  const numberRates = ratesData.length;
  const features = plots.features;
  const blockKey = (f: Feature): string => {
    const { plotId, stripId } = plotProperties(f);
    const blockRow = Math.floor((plotId - 1) / numberRates) + 1;
    const blockCol = Math.floor((stripId - 1) / numberRates) + 1;
    return `${blockRow}:${blockCol}`;
  };
  const blockIds = groupIdsByFirstAppearance(features, blockKey);
  const byBlock = new Map<number, Feature[]>();
  features.forEach((f, index) => {
    const bid = blockIds[index]!;
    const array = byBlock.get(bid) ?? [];
    array.push(f);
    byBlock.set(bid, array);
  });

  const result = new Map<Feature, RateData>();
  for (const blockFeatures of byBlock.values()) {
    const ranks = getRankForRb(numberRates, blockFeatures.length, rng);
    blockFeatures.forEach((f, index) => result.set(f, ratesData[ranks[index]! - 1]!));
  }
  return result;
}

export function assignString(
  plots: FeatureCollection,
  ratesData: RateData[],
  rankSeqAsIn: number[] | null,
  rng: Rng
): Map<Feature, RateData> {
  const numberRates = ratesData.length;
  const startRankAs = rankSeqAsIn ?? getStartingRankAs(numberRates, rng);
  const stripGroups = groupByStrip(plots);
  const result = new Map<Feature, RateData>();
  for (const [sid, feats] of stripGroups) {
    const rank = startRankAs[(sid - 1) % startRankAs.length]!;
    for (const f of feats) result.set(f, ratesData[rank - 1]!);
  }
  return result;
}

export function assignRstr(
  plots: FeatureCollection,
  ratesData: RateData[],
  rng: Rng
): Map<Feature, RateData> {
  const numberRates = ratesData.length;
  const stripGroups = groupByStrip(plots);
  const stripIds = stripGroups.keys().toArray();
  const maxStripId = stripIds.length === 0 ? 0 : Math.max(...stripIds);
  const blocks = Math.max(1, Math.ceil(maxStripId / numberRates));
  const startRankAs: number[] = [];
  for (let b = 0; b < blocks; b++) startRankAs.push(...rng.shuffle(range(1, numberRates)));

  const result = new Map<Feature, RateData>();
  for (const [sid, feats] of stripGroups) {
    const rank = startRankAs[(sid - 1) % startRankAs.length]!;
    for (const f of feats) result.set(f, ratesData[rank - 1]!);
  }
  return result;
}

function assignSparse(
  plots: FeatureCollection,
  ratesData: RateData[],
  rankSeqWsIn: number[] | null,
  rankSeqAsIn: number[] | null,
  rng: Rng
): Map<Feature, RateData> {
  const numberRates = ratesData.length;
  const basicSeq = rankSeqWsIn ?? genBasicRankWsSparse(numberRates);
  const startRankAs = rankSeqAsIn ?? getStartingRankAs(numberRates - 1, rng).map((x) => x + 1);
  const stripGroups = groupByStrip(plots);
  const result = new Map<Feature, RateData>();
  for (const [sid, feats] of stripGroups) {
    const startRank = startRankAs[(sid - 1) % startRankAs.length]!;
    const rotated = getRankWsForStripSparse(startRank, basicSeq, sid);
    const ranks = repeatArray(rotated, Math.ceil(feats.length / rotated.length)).slice(
      0,
      feats.length
    );
    feats.forEach((f, index) => result.set(f, ratesData[ranks[index]! - 1]!));
  }
  return result;
}

export function assignEjca(
  plots: FeatureCollection,
  ratesData: RateData[],
  rateJumpThreshold: number | null
): Map<Feature, RateData> {
  const sorted = ratesData.toSorted((a, b) => a.rate_rank - b.rate_rank);
  const medianRank = median(sorted.map((r) => r.rate_rank));
  const tiers: Array<{ rates: RateData[]; isOddStrip: boolean }> = [
    { rates: sorted.filter((r) => r.rate_rank < medianRank), isOddStrip: true },
    { rates: sorted.filter((r) => r.rate_rank >= medianRank), isOddStrip: false },
  ];

  const stripGroups = groupByStrip(plots);
  const result = new Map<Feature, RateData>();

  for (const tier of tiers) {
    if (tier.rates.length === 0) continue;
    const numberLevels = tier.rates.length;
    const basicSeq = genBasicRankWs(numberLevels, rateJumpThreshold);

    const stripIds = stripGroups
      .keys()
      .filter((sid) => (sid % 2 === 1) === tier.isOddStrip)
      .toArray()
      .toSorted((a, b) => a - b);

    const rows: Feature[] = [];
    stripIds.forEach((sid, groupIndex) => {
      const feats = stripGroups.get(sid)!;
      rows.push(...((groupIndex + 1) % 2 === 0 ? feats.toReversed() : feats));
    });

    const rankInTierSeq = repeatArray(basicSeq, Math.ceil(rows.length / numberLevels)).slice(
      0,
      rows.length
    );
    for (const [index, f] of rows.entries()) result.set(f, tier.rates[rankInTierSeq[index]! - 1]!);
  }

  return result;
}

/** R `assign_rates_by_input`: dispatches to the design_type's strategy (null -> "ls"). */
export function assignRatesByInput(
  plots: FeatureCollection,
  ratesData: RateData[],
  designTypeIn: string | null,
  rankSeqWs: number[] | null,
  rankSeqAs: number[] | null,
  rateJumpThreshold: number | null,
  rng: Rng
): Map<Feature, RateData> {
  const designType = designTypeIn ?? "ls";
  switch (designType) {
    case "ls": {
      return assignLs(plots, ratesData, rankSeqWs, rankSeqAs, rateJumpThreshold, rng);
    }
    case "rb": {
      return assignRb(plots, ratesData, rng);
    }
    case "str": {
      return assignString(plots, ratesData, rankSeqAs, rng);
    }
    case "rstr": {
      return assignRstr(plots, ratesData, rng);
    }
    case "sparse": {
      return assignSparse(plots, ratesData, rankSeqWs, rankSeqAs, rng);
    }
    case "ejca": {
      return assignEjca(plots, ratesData, rateJumpThreshold);
    }
    default: {
      throw new ValidationError(
        `design_type "${designType}" does not match any of the design type options available.`
      );
    }
  }
}

// !===========================================================
// ! Two-input joint designing (R: get_design_for_second, make_design_for_2_by_2)
// !===========================================================

/** R `assign_rate_rank_by_strip`: no neighbor-avoidance, just per-strip rotation. */
export function assignRateRankByStrip(
  stripGroups: Map<number, Feature[]>,
  rankSeqWs: number[],
  rankSeqAs: number[]
): Map<Feature, number> {
  const result = new Map<Feature, number>();
  for (const [sid, feats] of stripGroups) {
    const startRank = rankSeqAs[(sid - 1) % rankSeqAs.length]!;
    const rotated = getRankWsForStrip(startRank, rankSeqWs);
    const ranks = repeatArray(rotated, Math.ceil(feats.length / rotated.length)).slice(
      0,
      feats.length
    );
    feats.forEach((f, index) => result.set(f, ranks[index]!));
  }
  return result;
}

/** R `make_design_for_2_by_2`: fully deterministic special case for two 2-rate inputs. */
export function makeDesignFor2By2(
  sharedPlots: FeatureCollection,
  ratesDataA: RateData[],
  ratesDataB: RateData[]
): { a: Map<Feature, RateData>; b: Map<Feature, RateData> } {
  const stripGroups = groupByStrip(sharedPlots);
  const rankA = assignRateRankByStrip(stripGroups, [1, 2], [1, 2]);
  const rankB = assignRateRankByStrip(stripGroups, [1, 2], [1, 1, 2, 2]);
  const a = new Map<Feature, RateData>();
  const b = new Map<Feature, RateData>();
  for (const [feature, rank] of rankA) a.set(feature, ratesDataA[rank - 1]!);
  for (const [feature, rank] of rankB) b.set(feature, ratesDataB[rank - 1]!);
  return { a, b };
}

export function defaultRateJumpThreshold(numberRates: number): number {
  return numberRates <= 4 ? numberRates - 1 : numberRates - 2;
}

interface CombEntry {
  rateRank1: number;
  rateRank2: number;
  cases: number;
}

export function variabilityScore(
  rowIndex: number,
  plotId: number,
  candidateRank: number,
  rateTable: number[],
  W: number[][]
): number {
  let sum = 0;
  if (plotId === 1) {
    for (let k = 0; k < rowIndex; k++) {
      const diff = rateTable[k]! - candidateRank;
      sum += diff * diff * W[rowIndex]![k]!;
    }
  } else {
    for (let k = 0; k < rowIndex - 1; k++) {
      const diff = rateTable[k]! - candidateRank;
      sum += diff * diff * W[rowIndex]![k]!;
    }
    const diffPrevious = rateTable[rowIndex - 1]! - candidateRank;
    sum += (-(diffPrevious * diffPrevious) / 2) * W[rowIndex]![rowIndex - 1]!;
  }
  return sum / rowIndex;
}

/**
 * R `find_rate`. Note: R's own call site never forwards its computed
 * rate_jump_threshold here — find_rate always uses its hardcoded default of
 * 3, regardless of num_rates. That's an upstream quirk, replicated as-is.
 */
export function findRate(
  rowIndex: number,
  plotId: number,
  info: { rateRank1st: number; rateRank2ndNb: number; rateRank2ndPrev: number },
  combEntries: CombEntry[],
  rateTable: number[],
  W: number[][],
  rng: Rng
): number {
  const rateJumpThreshold = 3;
  const base =
    plotId === 1
      ? combEntries.filter(
          (c) => c.rateRank2 !== info.rateRank2ndNb && c.rateRank1 === info.rateRank1st
        )
      : combEntries.filter(
          (c) =>
            c.rateRank2 !== info.rateRank2ndPrev &&
            c.rateRank2 !== info.rateRank2ndNb &&
            c.rateRank1 === info.rateRank1st
        );
  const options = base.map((c) => ({
    ...c,
    variabilityScore: variabilityScore(rowIndex, plotId, c.rateRank2, rateTable, W),
  }));

  const minCases = Math.min(...options.map((o) => o.cases));
  const withinJump = (o: (typeof options)[number]): boolean =>
    Math.abs(o.rateRank2 - info.rateRank2ndPrev) <= rateJumpThreshold;

  // Primary path (R assign_rates.R:1220-1222): min(cases) computed over ALL
  // options, then intersected with the jump constraint.
  let finalOptions = options.filter(
    (o) => (o.cases === minCases || o.cases === minCases + 1) && withinJump(o)
  );
  if (finalOptions.length === 0) {
    // R's fallback (assign_rates.R:1228-1234): re-filter by the JUMP
    // constraint FIRST, then take min(cases) on that jump-filtered subset —
    // the order matters, it can pick options the primary path missed.
    const jumpCompliant = options.filter(withinJump);
    if (jumpCompliant.length > 0) {
      const minJump = Math.min(...jumpCompliant.map((o) => o.cases));
      finalOptions = jumpCompliant.filter((o) => o.cases === minJump || o.cases === minJump + 1);
    }
  }
  // Last resort (TS-only, documented deviation). Even `options` itself can be
  // empty: with a 2-rate second input, excluding BOTH the previous plot's rank
  // (rateRank2ndPrev) and the strip-neighbour's rank (rateRank2ndNb) at
  // l.725-730 can eliminate every candidate. R samples from that empty set and
  // silently yields NA; instead, rebuild from all combos of the current
  // rateRank1st (dropping the prev/nb exclusion) so a rank is always assignable
  // — guaranteed non-empty since numberRates >= 1.
  if (finalOptions.length === 0) {
    finalOptions = combEntries
      .filter((c) => c.rateRank1 === info.rateRank1st)
      .map((c) => ({
        ...c,
        variabilityScore: variabilityScore(rowIndex, plotId, c.rateRank2, rateTable, W),
      }));
  }

  const maxScore = Math.max(...finalOptions.map((o) => o.variabilityScore));
  const tied = finalOptions.filter((o) => o.variabilityScore === maxScore);
  return rng.sample(tied, 1)[0]!.rateRank2;
}

/**
 * R `get_design_for_second`: greedily assigns the second input's rate ranks
 * so the joint (rate_rank_1, rate_rank_2) combinations stay balanced across
 * plots, weighted by inverse spatial distance. `firstDesignRates` must be
 * index-aligned with `secondFeatures` (same row order — a precondition the
 * callers below establish via geometryIdentical).
 */
export function getDesignForSecond(
  firstDesignRates: number[],
  secondFeatures: Feature[],
  ratesDataSecond: RateData[],
  rateJumpThresholdIn: number | null,
  rng: Rng
): Map<Feature, RateData> {
  const numberRates = ratesDataSecond.length;
  const numberPlots = secondFeatures.length;
  const rateJumpThreshold = rateJumpThresholdIn ?? defaultRateJumpThreshold(numberRates);

  const distinctFirstRanks = [...new Set(firstDesignRates)];
  const combEntries: CombEntry[] = [];
  for (const r1 of distinctFirstRanks) {
    for (let r2 = 1; r2 <= numberRates; r2++)
      combEntries.push({ rateRank1: r1, rateRank2: r2, cases: 0 });
  }
  const updateComb = (r1: number, r2: number): void => {
    for (const e of combEntries) if (e.rateRank1 === r1 && e.rateRank2 === r2) e.cases += 1;
  };

  const epsg = firstEpsg(secondFeatures);
  const centroids = secondFeatures.map((f) => utmCentroid(f, epsg));
  const n = numberPlots;
  const invDistribution: number[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => 0)
  );
  for (let index = 0; index < n; index++) {
    for (let index_ = 0; index_ < n; index_++) {
      if (index !== index_)
        invDistribution[index]![index_] =
          1 / Math.max(distance(centroids[index]!, centroids[index_]!), 1e-9);
    }
  }
  const rowSums = invDistribution.map((row) => row.reduce((a, b) => a + b, 0));
  const W: number[][] = Array.from({ length: n }, (_, a) =>
    Array.from({ length: n }, (_, b) =>
      rowSums[b] === 0 ? 0 : invDistribution[a]![b]! / rowSums[b]!
    )
  );

  const stripIndex = new Map<number, number[]>();
  for (const [index, f] of secondFeatures.entries()) {
    const { stripId } = plotProperties(f);
    const array = stripIndex.get(stripId) ?? [];
    array.push(index);
    stripIndex.set(stripId, array);
  }

  const rateTable: number[] = Array.from({ length: numberPlots });

  for (let rowIndex = 0; rowIndex < numberPlots; rowIndex++) {
    const { stripId, plotId } = plotProperties(secondFeatures[rowIndex]!);
    const rateRank1st = firstDesignRates[rowIndex]!;

    let rateRank2nd: number;
    if (stripId === 1) {
      if (plotId === 1) {
        rateRank2nd = rng.nextInt(numberRates) + 1;
      } else {
        const previous = rateTable[rowIndex - 1]!;
        const candidates = combEntries.filter(
          (c) =>
            c.rateRank2 !== previous &&
            c.rateRank1 === rateRank1st &&
            Math.abs(c.rateRank2 - previous) <= rateJumpThreshold
        );
        const minCases = Math.min(...candidates.map((c) => c.cases));
        const tied = candidates.filter((c) => c.cases === minCases);
        rateRank2nd = rng.sample(tied, 1)[0]!.rateRank2;
      }
    } else {
      const previousIndices = stripIndex.get(stripId - 1) ?? [];
      let nearestIndex = previousIndices[0] ?? rowIndex - 1;
      let bestDistribution = Infinity;
      for (const index of previousIndices) {
        const d = distribution2(centroids[rowIndex]!, centroids[index]!);
        if (d < bestDistribution) {
          bestDistribution = d;
          nearestIndex = index;
        }
      }
      const rateRank2ndNb = rateTable[nearestIndex]!;
      const rateRank2ndPrevious = rateTable[rowIndex - 1]!;
      rateRank2nd = findRate(
        rowIndex,
        plotId,
        { rateRank1st, rateRank2ndNb, rateRank2ndPrev: rateRank2ndPrevious },
        combEntries,
        rateTable,
        W,
        rng
      );
    }
    rateTable[rowIndex] = rateRank2nd;
    updateComb(rateRank1st, rateRank2nd);
  }

  const result = new Map<Feature, RateData>();
  for (const [index, f] of secondFeatures.entries())
    result.set(f, ratesDataSecond[rateTable[index]! - 1]!);
  return result;
}

// !===========================================================
// ! Joint-designing eligibility (R: assign_rates two-input branch)
// !===========================================================

export function multipleOfTheOther(a: number, b: number): boolean {
  return Math.max(a, b) % Math.min(a, b) === 0;
}

function geometryIdentical(a: FeatureCollection, b: FeatureCollection): boolean {
  if (a.features.length !== b.features.length) return false;
  for (let index = 0; index < a.features.length; index++) {
    if (JSON.stringify(a.features[index]!.geometry) !== JSON.stringify(b.features[index]!.geometry))
      return false;
  }
  return true;
}

function noRankSeqSpecified(infos: RateInfo[]): boolean {
  return (
    infos.every((ri) => ri.rank_seq_ws === null) && infos.every((ri) => ri.rank_seq_as === null)
  );
}

function bothLs(infos: RateInfo[]): boolean {
  return infos.every((ri) => ri.design_type === "ls" || ri.design_type === null);
}

function assignRatesTwoInput(
  layouts: [InputLayout, InputLayout],
  rateInfos: [RateInfo, RateInfo],
  rng: Rng
): Map<string, Map<Feature, RateData>> {
  const [layoutA, layoutB] = layouts;
  const [riA, riB] = rateInfos;

  const numberRatesLs: [number, number] = [riA.rates_data.length, riB.rates_data.length];
  const isRequireJoint =
    geometryIdentical(layoutA.plots, layoutB.plots) &&
    bothLs(rateInfos) &&
    multipleOfTheOther(numberRatesLs[0], numberRatesLs[1]) &&
    noRankSeqSpecified(rateInfos);

  const result = new Map<string, Map<Feature, RateData>>();

  if (isRequireJoint) {
    if (numberRatesLs[0] === 2 && numberRatesLs[1] === 2) {
      const { a, b } = makeDesignFor2By2(layoutA.plots, riA.rates_data, riB.rates_data);
      result.set(layoutA.plotInfo.input_name, a);
      // makeDesignFor2By2 keys both maps on layoutA's features (the 2x2 design
      // is computed on the shared geometry). layoutB owns positionally-aligned
      // but distinct feature objects (see makeExpPlots M3 clone), so re-key b
      // onto layoutB's features by index before it reaches buildInputDesign.
      const bByLayoutB = new Map<Feature, RateData>();
      layoutA.plots.features.forEach((fa, index) =>
        bByLayoutB.set(layoutB.plots.features[index]!, b.get(fa)!)
      );
      result.set(layoutB.plotInfo.input_name, bByLayoutB);
    } else {
      const firstAssigned = assignRatesByInput(
        layoutA.plots,
        riA.rates_data,
        riA.design_type,
        riA.rank_seq_ws,
        riA.rank_seq_as,
        riA.rate_jump_threshold,
        rng
      );
      result.set(layoutA.plotInfo.input_name, firstAssigned);

      const firstRanksByFeature = new Map<Feature, number>();
      for (const [f, rd] of firstAssigned) firstRanksByFeature.set(f, rd.rate_rank);
      const firstDesignRates = layoutA.plots.features.map((f) => firstRanksByFeature.get(f)!);

      const secondAssigned = getDesignForSecond(
        firstDesignRates,
        layoutB.plots.features,
        riB.rates_data,
        riB.rate_jump_threshold,
        rng
      );
      result.set(layoutB.plotInfo.input_name, secondAssigned);
    }
  } else {
    for (const [layout, ri] of [
      [layoutA, riA],
      [layoutB, riB],
    ] as const) {
      const assigned = assignRatesByInput(
        layout.plots,
        ri.rates_data,
        ri.design_type,
        ri.rank_seq_ws,
        ri.rank_seq_as,
        ri.rate_jump_threshold,
        rng
      );
      result.set(layout.plotInfo.input_name, assigned);
    }
  }

  return result;
}

function buildInputDesign(
  layout: InputLayout,
  ri: RateInfo,
  assigned: Map<Feature, RateData>
): InputDesign {
  const plots: FeatureCollection = {
    ...layout.plots,
    features: layout.plots.features.map((f) => {
      const rd = assigned.get(f)!;
      return {
        ...f,
        properties: { ...f.properties, rate: rd.rate, rate_rank: rd.rate_rank, type: "experiment" },
      };
    }),
  };
  const headlands: FeatureCollection = {
    ...layout.headlands,
    features: layout.headlands.features.map((f) => ({
      ...f,
      properties: { ...f.properties, rate: ri.gc_rate },
    })),
  };
  return {
    plotInfo: layout.plotInfo,
    rateInfo: ri,
    plots,
    headlands,
    abLine: layout.abLine,
    guidanceLines: layout.guidanceLines,
  };
}

// !===========================================================
// ! Public API
// !===========================================================

export interface AssignRatesOptions {
  /** Seed for the injected RNG (design.md D4). Default 42. */
  seed?: number;
}

/**
 * R `assign_rates`. Pairs each RateInfo to its ExpData input by input_name
 * (never by position). When fewer RateInfo are given than there are inputs,
 * the unmatched inputs come back with `rateInfo: null` (geometry only) — an
 * intermediate state consumed by `assignRatesConditional`.
 */
export function assignRates(
  expData: ExpData,
  rateInfo: RateInfo | RateInfo[],
  options?: AssignRatesOptions
): TrialDesign {
  const seed = options?.seed ?? 42;
  const rng = createRng(seed);
  const rateInfos = Array.isArray(rateInfo) ? rateInfo : [rateInfo];
  if (rateInfos.length === 0) {
    throw new ValidationError("assignRates requires at least one RateInfo.");
  }

  const inputNames = new Set(expData.inputs.map((l) => l.plotInfo.input_name));
  for (const ri of rateInfos) {
    if (!inputNames.has(ri.input_name)) {
      throw new ValidationError(
        `RateInfo for input "${ri.input_name}" has no matching input in expData.`
      );
    }
  }
  const rateInfoByName = new Map(rateInfos.map((ri) => [ri.input_name, ri]));
  const dosedInputs = expData.inputs.filter((l) => rateInfoByName.has(l.plotInfo.input_name));

  let designByName: Map<string, Map<Feature, RateData>>;
  if (dosedInputs.length === 2) {
    const layouts = dosedInputs as [InputLayout, InputLayout];
    const infos = layouts.map((l) => rateInfoByName.get(l.plotInfo.input_name)!) as [
      RateInfo,
      RateInfo,
    ];
    designByName = assignRatesTwoInput(layouts, infos, rng);
  } else {
    designByName = new Map();
    for (const layout of dosedInputs) {
      const ri = rateInfoByName.get(layout.plotInfo.input_name)!;
      designByName.set(
        layout.plotInfo.input_name,
        assignRatesByInput(
          layout.plots,
          ri.rates_data,
          ri.design_type,
          ri.rank_seq_ws,
          ri.rank_seq_as,
          ri.rate_jump_threshold,
          rng
        )
      );
    }
  }

  const inputs: InputDesign[] = expData.inputs.map((layout) => {
    const ri = rateInfoByName.get(layout.plotInfo.input_name);
    if (!ri) {
      return {
        plotInfo: layout.plotInfo,
        rateInfo: null,
        plots: layout.plots,
        headlands: layout.headlands,
        abLine: layout.abLine,
        guidanceLines: layout.guidanceLines,
      };
    }
    const assigned = designByName.get(layout.plotInfo.input_name)!;
    return buildInputDesign(layout, ri, assigned);
  });

  return { inputs, seed };
}

/**
 * R `assign_rates_conditional`. Reduced scope vs R (documented in
 * specs/rate-assignment/spec.md and parity-map.json): only the "partial
 * design" flow is supported — `existingDesign` must be a two-input
 * TrialDesign with exactly one dosed input and one geometry-only input (the
 * one `rateInfo` doses now). R's other supported case (conditioning on a
 * second, already-fully-dosed and separately-created TrialDesign) is not
 * ported.
 */
export function assignRatesConditional(
  expData: ExpData,
  rateInfo: RateInfo | RateInfo[],
  existingDesign: TrialDesign,
  options?: AssignRatesOptions
): TrialDesign {
  if (Array.isArray(rateInfo)) {
    throw new ValidationError(
      "assignRatesConditional accepts a single RateInfo — you cannot assign rates for two inputs using this function."
    );
  }
  if (!existingDesign || existingDesign.inputs.length !== 2) {
    throw new ValidationError(
      "existingDesign must be a two-input TrialDesign with exactly one dosed input and one geometry-only input."
    );
  }
  const dosedIndex = existingDesign.inputs.findIndex((index) => index.rateInfo !== null);
  const undosedIndex = existingDesign.inputs.findIndex((index) => index.rateInfo === null);
  if (dosedIndex === -1 || undosedIndex === -1) {
    throw new ValidationError(
      "existingDesign must be a two-input TrialDesign with exactly one dosed input and one geometry-only input."
    );
  }
  const dosedInput = existingDesign.inputs[dosedIndex]!;
  const undosedInput = existingDesign.inputs[undosedIndex]!;

  if (rateInfo.input_name !== undosedInput.plotInfo.input_name) {
    throw new ValidationError(
      `RateInfo is for input "${rateInfo.input_name}", but the undosed input in existingDesign is "${undosedInput.plotInfo.input_name}".`
    );
  }

  const matchingLayout = expData.inputs.find((l) => l.plotInfo.input_name === rateInfo.input_name);
  if (!matchingLayout) {
    throw new ValidationError(
      `RateInfo for input "${rateInfo.input_name}" has no matching input in expData.`
    );
  }
  if (!geometryIdentical(matchingLayout.plots, undosedInput.plots)) {
    throw new ValidationError(
      "It seems you are trying to add a third input. This package does not accommodate a three-input experiment."
    );
  }

  const seed = options?.seed ?? 42;
  const rng = createRng(seed);

  // rate_rank per plot of the existing dosed design, index-aligned with
  // matchingLayout's plots (geometryIdentical, checked above, guarantees the
  // same row order). Reusing the stored rate_rank instead of R's .GRP-by-rate
  // recompute is a numbering-scheme-only simplification: the algorithm below
  // only needs a bijection between plots and first-design rate identity, not
  // R's particular first-appearance numbering.
  const firstRatesByFeature = new Map<Feature, number>();
  for (const f of dosedInput.plots.features) {
    const p = f.properties as { rate_rank: number };
    firstRatesByFeature.set(f, p.rate_rank);
  }
  const firstDesignRates = dosedInput.plots.features.map((f) => firstRatesByFeature.get(f)!);

  const numberRatesLs: [number, number] = [
    rateInfo.rates_data.length,
    new Set(firstDesignRates).size,
  ];
  // Joint designing indexes the dosed design's ranks positionally against the
  // undosed input's plots (getDesignForSecond precondition, l.769-770). That
  // only holds when the two inputs share the same plot geometry; with
  // different machine widths the plot lists differ in length and spatial
  // order, so the joint path would silently mis-pair plots (or crash on the
  // undefined tail). R (assign_rates.R:311-329) ANDs geometry_identical into
  // require_joint_designing for exactly this reason — when geometries differ it
  // designs each input independently instead of throwing.
  const isRequireJoint =
    geometryIdentical(dosedInput.plots, matchingLayout.plots) &&
    (rateInfo.design_type === "ls" || rateInfo.design_type === null) &&
    multipleOfTheOther(numberRatesLs[0], numberRatesLs[1]) &&
    rateInfo.rank_seq_ws === null &&
    rateInfo.rank_seq_as === null;

  const assigned = isRequireJoint
    ? getDesignForSecond(
        firstDesignRates,
        matchingLayout.plots.features,
        rateInfo.rates_data,
        rateInfo.rate_jump_threshold,
        rng
      )
    : assignRatesByInput(
        matchingLayout.plots,
        rateInfo.rates_data,
        rateInfo.design_type,
        rateInfo.rank_seq_ws,
        rateInfo.rank_seq_as,
        rateInfo.rate_jump_threshold,
        rng
      );

  const newInputDesign = buildInputDesign(matchingLayout, rateInfo, assigned);
  const inputs = [...existingDesign.inputs];
  inputs[undosedIndex] = newInputDesign;
  return { inputs, seed };
}

/**
 * R `add_blocks`: 2D grid partition (block_row/block_col by integer division
 * on numRates, numbered by first appearance), plus plot_id_within_block.
 * Headland plots get block_id/plot_id_within_block = null (R: NA). Inputs
 * without an assigned rate (rateInfo: null) pass through unchanged — R has no
 * equivalent state (partial dosing is a TS-only extension, see assignRates).
 */
export function addBlocks(td: TrialDesign): TrialDesign {
  return { ...td, inputs: td.inputs.map(addBlocksForInput) };
}

function addBlocksForInput(input: InputDesign): InputDesign {
  if (input.rateInfo === null) return input;

  const features = input.plots.features;
  const numberRates = new Set(features.map((f) => (f.properties as { rate: number }).rate)).size;
  if (numberRates === 0) return input;

  const blockKey = (f: Feature): string => {
    const { plotId, stripId } = plotProperties(f);
    const blockRow = Math.floor((plotId - 1) / numberRates) + 1;
    const blockCol = Math.floor((stripId - 1) / numberRates) + 1;
    return `${blockRow}:${blockCol}`;
  };
  const blockIds = groupIdsByFirstAppearance(features, blockKey);

  const withinBlockCounters = new Map<number, number>();
  const newFeatures = features.map((f, index) => {
    const blockId = blockIds[index]!;
    const count = (withinBlockCounters.get(blockId) ?? 0) + 1;
    withinBlockCounters.set(blockId, count);
    return {
      ...f,
      properties: { ...f.properties, block_id: blockId, plot_id_within_block: count },
    };
  });
  const newHeadlands = input.headlands.features.map((f) => ({
    ...f,
    properties: { ...f.properties, block_id: null, plot_id_within_block: null },
  }));

  return {
    ...input,
    plots: { ...input.plots, features: newFeatures },
    headlands: { ...input.headlands, features: newHeadlands },
  };
}

export interface ChangeRatesOptions {
  /** Required when the trial design has more than one input. */
  inputName?: string;
  stripIds: number[];
  plotIds?: number[];
  newRates: number | number[] | number[][];
  /** Default "all", like R. */
  rateBy?: "all" | "strip" | "plot";
}

/**
 * R `change_rates`. Deviation from R (spec.md, parity-map.json): the input
 * to modify is the one NAMED by `inputName`, not R's first input (R 0.1.3
 * has `dplyr::filter(input_name == input_name)`, a tautology that always
 * modifies the first input regardless of the option). Also: unknown
 * strip/plot targets throw here instead of R's silent no-op.
 */
export function changeRates(td: TrialDesign, options: ChangeRatesOptions): TrialDesign {
  const rateBy = options.rateBy ?? "all";

  let targetIndex: number;
  if (td.inputs.length === 1) {
    targetIndex = 0;
  } else {
    if (!options.inputName) {
      throw new ValidationError(
        'Please specify which input you want to change rates for using the "inputName" option.'
      );
    }
    targetIndex = td.inputs.findIndex((inp) => inp.plotInfo.input_name === options.inputName);
    if (targetIndex === -1) {
      throw new ValidationError(`No input named "${options.inputName}" in this trial design.`);
    }
  }
  const target = td.inputs[targetIndex]!;

  const existingStripIds = new Set(target.plots.features.map((f) => plotProperties(f).stripId));
  const missingStrips = options.stripIds.filter((s) => !existingStripIds.has(s));
  if (missingStrips.length > 0) {
    throw new ValidationError(
      `Strip id(s) not found in this input's design: ${missingStrips.join(", ")}.`
    );
  }

  if (options.plotIds) {
    const missingPairs: string[] = [];
    for (const s of options.stripIds) {
      const plotIdsInStrip = new Set(
        target.plots.features
          .filter((f) => plotProperties(f).stripId === s)
          .map((f) => plotProperties(f).plotId)
      );
      for (const p of options.plotIds) {
        if (!plotIdsInStrip.has(p)) missingPairs.push(`(${s}, ${p})`);
      }
    }
    if (missingPairs.length > 0) {
      throw new ValidationError(`Plot position(s) not found: ${missingPairs.join(", ")}.`);
    }
  }

  let scalarRate = 0;
  let stripRates: number[] = [];
  let plotMatrix: number[][] = [];

  if (rateBy === "all") {
    const array = Array.isArray(options.newRates) ? options.newRates : [options.newRates];
    if (array.length !== 1 || Array.isArray(array[0])) {
      throw new ValidationError('For rateBy "all", newRates must be a single number.');
    }
    scalarRate = array[0] as number;
  } else if (rateBy === "strip") {
    // Accept a scalar when there is a single strip (R accepts the scalar form;
    // the old check required an array and rejected it with a self-contradictory
    // "length (1), got 1" message) — L11.
    const stripArray =
      typeof options.newRates === "number"
        ? [options.newRates]
        : Array.isArray(options.newRates) && !Array.isArray(options.newRates[0])
          ? (options.newRates as number[])
          : null;
    if (!stripArray || stripArray.length !== options.stripIds.length) {
      const got = Array.isArray(options.newRates) ? options.newRates.length : 1;
      throw new ValidationError(
        `For rateBy "strip", newRates must be a number (single strip) or an array with the same ` +
          `length as stripIds (${options.stripIds.length}), got ${got}.`
      );
    }
    stripRates = stripArray;
  } else {
    if (!options.plotIds || options.plotIds.length === 0) {
      throw new ValidationError('For rateBy "plot", plotIds is required.');
    }
    for (let index = 1; index < options.plotIds.length; index++) {
      if (options.plotIds[index]! <= options.plotIds[index - 1]!) {
        throw new ValidationError('plotIds must be strictly increasing for rateBy "plot".');
      }
    }
    const mat = options.newRates as number[][];
    const isRowsOk = Array.isArray(mat) && mat.length === options.plotIds.length;
    const colsOk =
      isRowsOk && mat.every((row) => Array.isArray(row) && row.length === options.stripIds.length);
    if (!isRowsOk || !colsOk) {
      throw new ValidationError(
        `For rateBy "plot", newRates must be a ${options.plotIds.length} x ${options.stripIds.length} matrix (plotIds x stripIds).`
      );
    }
    plotMatrix = mat;
  }

  const newFeatures = target.plots.features.map((f) => {
    const { stripId, plotId } = plotProperties(f);
    if (!options.stripIds.includes(stripId)) return f;

    let newRate: number;
    if (rateBy === "all") {
      if (options.plotIds && !options.plotIds.includes(plotId)) return f;
      newRate = scalarRate;
    } else if (rateBy === "strip") {
      if (options.plotIds && !options.plotIds.includes(plotId)) return f;
      newRate = stripRates[options.stripIds.indexOf(stripId)]!;
    } else {
      if (!options.plotIds!.includes(plotId)) return f;
      const plotIndex = options.plotIds!.indexOf(plotId);
      const stripIndex = options.stripIds.indexOf(stripId);
      newRate = plotMatrix[plotIndex]![stripIndex]!;
    }
    return { ...f, properties: { ...f.properties, rate: newRate } };
  });

  const newInput: InputDesign = { ...target, plots: { ...target.plots, features: newFeatures } };
  const newInputs = [...td.inputs];
  newInputs[targetIndex] = newInput;
  return { ...td, inputs: newInputs };
}
