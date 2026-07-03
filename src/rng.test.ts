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

    it("throws on an empty range", () => {
      const rng = createRng(1);
      expect(() => rng.nextInt(0)).toThrow(ValidationError);
      expect(() => rng.nextInt(-3)).toThrow(ValidationError);
    });
  });

  describe("shuffle", () => {
    it("returns a permutation of the input (new array)", () => {
      const rng = createRng(5);
      const input = [1, 2, 3, 4, 5, 6, 7, 8];
      const shuffled = rng.shuffle(input);
      expect(shuffled).not.toBe(input);
      expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // untouched
      expect([...shuffled].sort((x, y) => x - y)).toEqual(input);
    });

    it("is deterministic for a given seed", () => {
      const shuffledA = createRng(11).shuffle([1, 2, 3, 4, 5]);
      const shuffledB = createRng(11).shuffle([1, 2, 3, 4, 5]);
      expect(shuffledA).toEqual(shuffledB);
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

    it("throws when n is out of range", () => {
      const rng = createRng(4);
      expect(() => rng.sample([1, 2, 3], 4)).toThrow(ValidationError);
      expect(() => rng.sample([1, 2, 3], -1)).toThrow(ValidationError);
    });
  });
});
