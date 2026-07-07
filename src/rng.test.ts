import { describe, expect, it } from "vitest";
import { createRng } from "./rng.js";
import { ValidationError } from "./types.js";

describe("createRng", () => {
  it("produces the same sequence for the same seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("produces a different sequence for a different seed", () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  // Golden snapshot: pins the splitmix32 constants (0x9e3779b9, the >>> shifts,
  // 0x21f0aaad, 0x735a2d97 and the 2^32 divisor). Any arithmetic mutation to
  // next() moves these exact values. splitmix32 is integer math (Math.imul plus
  // unsigned shifts), so the sequence is platform-independent.
  it("emits the exact splitmix32 sequence for seed 42 (golden)", () => {
    const rng = createRng(42);
    const seq = Array.from({ length: 6 }, () => rng.next());
    expect(seq).toEqual([
      0.12848330102860928, 0.03353364090435207, 0.07509804493747652,
      0.7065966189838946, 0.21141720796003938, 0.6166351919528097,
    ]);
  });

  it("next() returns values in [0, 1)", () => {
    const rng = createRng(7);
    for (let index = 0; index < 1000; index++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("is deterministic across repeated calls with the same seed (fresh instances)", () => {
    for (let trial = 0; trial < 3; trial++) {
      const rng = createRng(99);
      const seq = Array.from({ length: 5 }, () => rng.next());
      const rng2 = createRng(99);
      const seq2 = Array.from({ length: 5 }, () => rng2.next());
      expect(seq).toEqual(seq2);
    }
  });

  describe("nextInt", () => {
    it("returns integers within [0, maxExclusive)", () => {
      const rng = createRng(123);
      for (let index = 0; index < 500; index++) {
        const v = rng.nextInt(7);
        expect(Number.isSafeInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(7);
      }
    });

    it("maps the seed-42 stream to exact integers (golden)", () => {
      const rng = createRng(42);
      expect(Array.from({ length: 6 }, () => rng.nextInt(100))).toEqual([12, 3, 7, 70, 21, 61]);
    });

    it("throws on an empty range", () => {
      const rng = createRng(1);
      const zero = () => rng.nextInt(0);
      expect(zero).toThrow(ValidationError);
      expect(zero).toThrow(/nextInt requires maxExclusive > 0/);
      const negative = () => rng.nextInt(-3);
      expect(negative).toThrow(ValidationError);
      expect(negative).toThrow(/nextInt requires maxExclusive > 0/);
    });
  });

  describe("shuffle", () => {
    it("returns a permutation of the input (new array)", () => {
      const rng = createRng(5);
      const input = [1, 2, 3, 4, 5, 6, 7, 8];
      const shuffled = rng.shuffle(input);
      expect(shuffled).not.toBe(input);
      expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // untouched
      expect(shuffled.toSorted((x, y) => x - y)).toEqual(input);
    });

    it("is deterministic for a given seed", () => {
      const shuffledA = createRng(11).shuffle([1, 2, 3, 4, 5]);
      const shuffledB = createRng(11).shuffle([1, 2, 3, 4, 5]);
      expect(shuffledA).toEqual(shuffledB);
    });

    it("matches the golden Fisher-Yates permutation for seed 7", () => {
      // Pins the loop bounds and nextInt(index + 1) index math, not just that
      // the output is *a* permutation.
      expect(createRng(7).shuffle([1, 2, 3, 4, 5, 6, 7, 8])).toEqual([4, 1, 3, 5, 6, 2, 7, 8]);
    });
  });

  describe("sample", () => {
    it("returns n distinct elements drawn from the array", () => {
      const rng = createRng(3);
      const input = [10, 20, 30, 40, 50];
      const sampled = rng.sample(input, 3);
      expect(sampled).toHaveLength(3);
      for (const v of sampled) {
        expect(input).toContain(v);
      }
      expect(new Set(sampled).size).toBe(3);
    });

    it("is deterministic for a given seed", () => {
      const a = createRng(21).sample([1, 2, 3, 4, 5, 6], 4);
      const b = createRng(21).sample([1, 2, 3, 4, 5, 6], 4);
      expect(a).toEqual(b);
    });

    it("matches the golden draw for seed 7 (pins the shuffle + slice)", () => {
      expect(createRng(7).sample([10, 20, 30, 40, 50], 3)).toEqual([20, 30, 10]);
    });

    it("throws when n is out of range", () => {
      const rng = createRng(4);
      const tooMany = () => rng.sample([1, 2, 3], 4);
      expect(tooMany).toThrow(ValidationError);
      expect(tooMany).toThrow(/sample requires 0 <= n <= arr\.length/);
      const negative = () => rng.sample([1, 2, 3], -1);
      expect(negative).toThrow(ValidationError);
      expect(negative).toThrow(/sample requires 0 <= n <= arr\.length/);
    });
  });
});
