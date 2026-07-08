import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { describe, expect, it } from "vitest";

import { signedRingArea } from "./geometry-utils.js";
import {
  cleanRing,
  distributionToRings,
  growRing,
  mergeIntervals,
  offsetRingRound,
  ringCentroid,
  ringIntervalsAt,
  ringIsSimple,
  ringToPolygonFeature,
  samplePointInRing,
  shrinkRing,
  subtractIntervals,
  toCcw,
  trialPlotLengths,
  unkinkRing,
} from "./plot-layout.js";
import { GeometryError } from "./types.js";

type Pt = [number, number];

// A CCW 4x4 square used across several cases.
const SQUARE: Pt[] = [
  [0, 0],
  [4, 0],
  [4, 4],
  [0, 4],
  [0, 0],
];

// A self-intersecting "bowtie" ring (single ring, two lobes).
const BOWTIE: Pt[] = [
  [0, 0],
  [4, 4],
  [4, 0],
  [0, 4],
  [0, 0],
];

describe("ringCentroid", () => {
  it("computes area and centroid of a 2x4 rectangle exactly", () => {
    const rect: Pt[] = [
      [0, 0],
      [2, 0],
      [2, 4],
      [0, 4],
      [0, 0],
    ];
    expect(ringCentroid(rect)).toEqual({ area: 8, cx: 1, cy: 2 });
  });
});

describe("cleanRing", () => {
  it("drops consecutive duplicates and re-closes the ring", () => {
    const dirty: Pt[] = [
      [0, 0],
      [0, 0],
      [2, 0],
      [2, 4],
      [2, 4],
      [0, 4],
      [0, 0],
    ];
    expect(cleanRing(dirty)).toEqual([
      [0, 0],
      [2, 0],
      [2, 4],
      [0, 4],
      [0, 0],
    ]);
  });

  it("returns null when fewer than three distinct points remain", () => {
    expect(
      cleanRing([
        [0, 0],
        [1, 1],
        [0, 0],
      ])
    ).toBeNull();
  });
});

describe("mergeIntervals", () => {
  it("merges overlapping intervals and sorts unsorted input", () => {
    expect(
      mergeIntervals([
        [5, 7],
        [1, 3],
        [2, 5],
      ])
    ).toEqual([[1, 7]]);
  });

  it("merges intervals that only touch at an endpoint", () => {
    // Pins the `s <= last[1]` boundary: with `<` these would stay split.
    expect(
      mergeIntervals([
        [0, 2],
        [2, 4],
      ])
    ).toEqual([[0, 4]]);
  });

  it("returns an empty list unchanged", () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe("subtractIntervals", () => {
  it("removes two interior gaps from a base interval", () => {
    expect(
      subtractIntervals(
        [[0, 10]],
        [
          [2, 4],
          [6, 8],
        ]
      )
    ).toEqual([
      [0, 2],
      [4, 6],
      [8, 10],
    ]);
  });

  it("returns the base unchanged when nothing is subtracted", () => {
    expect(subtractIntervals([[0, 5]], [])).toEqual([[0, 5]]);
  });
});

describe("ringIntervalsAt", () => {
  it("returns the interior x-span of a square at a horizontal scanline", () => {
    expect(ringIntervalsAt(SQUARE, 2)).toEqual([[0, 4]]);
  });

  it("throws on an odd crossing count (non-simple / open ring)", () => {
    // An open 3-point chain crosses v=2 exactly once → odd → guard fires.
    const open: Pt[] = [
      [0, 0],
      [4, 0],
      [4, 4],
    ];
    expect(() => ringIntervalsAt(open, 2)).toThrow(GeometryError);
    expect(() => ringIntervalsAt(open, 2)).toThrow(/odd crossing count/);
  });
});

describe("distributionToRings", () => {
  it("returns the exact minimum distance from a point to a ring's edges", () => {
    // (6,2) projects onto the right edge x=4 at (4,2) → distance 2.
    expect(distributionToRings([6, 2], [SQUARE])).toBe(2);
  });
});

describe("toCcw", () => {
  it("reverses a clockwise ring to counter-clockwise", () => {
    const cw: Pt[] = [
      [0, 0],
      [0, 3],
      [2, 3],
      [2, 0],
      [0, 0],
    ];
    const ccw = toCcw(cw);
    expect(ccw).toEqual([
      [0, 0],
      [2, 0],
      [2, 3],
      [0, 3],
      [0, 0],
    ]);
    expect(signedRingArea(ccw)).toBe(6);
  });

  it("leaves an already counter-clockwise ring untouched", () => {
    expect(toCcw(SQUARE)).toBe(SQUARE);
  });
});

describe("trialPlotLengths", () => {
  it("spreads the remainder evenly when the plots stay under maxLength", () => {
    // 100 / 18 → 5 plots, remainder 10 spread as +2 each → length 20.
    expect(trialPlotLengths(100, 18, 30)).toEqual([20, 20, 20, 20, 20]);
  });

  it("clamps the plot length to maxLength", () => {
    expect(trialPlotLengths(100, 18, 19)).toEqual([19, 19, 19, 19, 19]);
  });

  it("returns no plots when the strip is shorter than one minimum plot", () => {
    expect(trialPlotLengths(10, 18, 30)).toEqual([]);
  });
});

describe("ringIsSimple", () => {
  it("accepts a plain square", () => {
    expect(ringIsSimple(SQUARE)).toBe(true);
  });

  it("rejects a self-intersecting bowtie ring", () => {
    expect(ringIsSimple(BOWTIE)).toBe(false);
  });
});

describe("samplePointInRing", () => {
  it("returns the vertex mean when it lies inside (convex ring)", () => {
    expect(samplePointInRing(SQUARE)).toEqual([2, 2]);
  });

  it("falls back to a diagonal midpoint when the vertex mean is outside", () => {
    // L-shape: vertex mean (2.67, 2.67) sits in the notch (outside); the first
    // diagonal midpoint (0,0)-(6,2) → (3,1) is inside the bottom bar.
    const ell: Pt[] = [
      [0, 0],
      [6, 0],
      [6, 2],
      [2, 2],
      [2, 6],
      [0, 6],
      [0, 0],
    ];
    expect(samplePointInRing(ell)).toEqual([3, 1]);
  });

  it("uses the scanline-median fallback when the mean and every diagonal midpoint miss", () => {
    // The deep fallback (mean outside AND every (i, i+2) diagonal midpoint
    // outside) is unreachable for a SIMPLE ring: by the Two Ears Theorem every
    // simple polygon (n >= 4) has >= 2 ears, and an ear's neighbour midpoint
    // (exactly one of the (i, i+2) midpoints) lies in the interior — so the
    // diagonal-midpoint loop always returns first. A self-intersecting ring is
    // not bound by that theorem: a pentagram {5/2} has its centre OUTSIDE under
    // the even-odd rule (crossed twice), its vertex mean is the centre, and
    // every diagonal midpoint falls in an outer notch — so the fallback fires.
    const R = 10;
    const outer: Pt[] = [];
    for (let k = 0; k < 5; k++) {
      const ang = Math.PI / 2 + (2 * Math.PI * k) / 5;
      outer.push([R * Math.cos(ang), R * Math.sin(ang)]);
    }
    // ring order {5/2}: skip every other point -> self-intersecting star
    const ring: Pt[] = [0, 2, 4, 1, 3].map((k) => outer[k]!);
    ring.push([ring[0]![0], ring[0]![1]]);
    const poly = ringToPolygonFeature(ring);

    // Preconditions that force the fallback: mean outside and no diagonal
    // midpoint inside.
    const n = ring.length - 1;
    const mean: Pt = [
      ring.slice(0, n).reduce((s, p) => s + p[0], 0) / n,
      ring.slice(0, n).reduce((s, p) => s + p[1], 0) / n,
    ];
    expect(booleanPointInPolygon(mean, poly)).toBe(false);
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 2) % n]!;
      expect(booleanPointInPolygon([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], poly)).toBe(false);
    }

    // Fallback result: midpoint of the widest interval at the median vertex
    // height nudged up by 1e-9. Re-derive the nudged v the same way the code
    // does and pin it exactly; x is the centre of the star's widest span (0).
    const ys = ring
      .slice(0, n)
      .map((p) => p[1])
      .toSorted((a, b) => a - b);
    const vExpected = ys[Math.floor(n / 2)]! + 1e-9;
    const point = samplePointInRing(ring);
    expect(point).not.toBeNull();
    expect(point![1]).toBe(vExpected);
    expect(point![0]).toBeCloseTo(0, 9);
    expect(booleanPointInPolygon(point!, poly)).toBe(true);
  });
});

describe("unkinkRing", () => {
  it("splits a bowtie into two simple, non-degenerate rings", () => {
    const pieces = unkinkRing(BOWTIE);
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) {
      expect(piece[0]).toEqual(piece.at(-1)); // closed
      expect(Math.abs(signedRingArea(piece))).toBeGreaterThan(0);
    }
  });
});

describe("offsetRingRound / shrinkRing / growRing", () => {
  it("grows a CCW square outward (area increases)", () => {
    const grown = offsetRingRound(SQUARE, 1);
    expect(grown).not.toBeNull();
    expect(signedRingArea(grown!)).toBeGreaterThan(16);
  });

  it("returns a single larger piece from growRing", () => {
    const pieces = growRing(SQUARE, 1);
    expect(pieces).toHaveLength(1);
    expect(Math.abs(signedRingArea(pieces[0]!))).toBeGreaterThan(16);
  });

  it("shrinks a large square inward (area decreases, stays non-empty)", () => {
    const big: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const pieces = shrinkRing(big, 1);
    expect(pieces.length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(signedRingArea(pieces[0]!))).toBeLessThan(100);
  });
});
