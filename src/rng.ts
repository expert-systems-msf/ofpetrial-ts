// Seedable RNG (splitmix32) — not a reproduction of R's RNG (see design.md D4);
// parity with R on randomized parts is judged by properties, not by sequence.
import { ValidationError } from "./types.js";

export interface Rng {
  /** Next pseudo-random number in [0, 1). */
  next(): number;
  /** Next pseudo-random integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /** Fisher-Yates shuffle; returns a new array, leaves the input untouched. */
  shuffle<T>(array: T[]): T[];
  /** n distinct elements drawn from arr (order = shuffled order), as a new array. */
  sample<T>(array: T[], n: number): T[];
}

export function createRng(seed: number): Rng {
  let state = seed | 0;

  function next(): number {
    state = (state + 0x9e_37_79_b9) | 0;
    let t = state ^ (state >>> 16);
    t = Math.imul(t, 0x21_f0_aa_ad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x73_5a_2d_97);
    t ^= t >>> 15;
    return (t >>> 0) / 4_294_967_296;
  }

  function nextInt(maxExclusive: number): number {
    if (maxExclusive <= 0) {
      throw new ValidationError(`nextInt requires maxExclusive > 0, got ${maxExclusive}`);
    }
    return Math.floor(next() * maxExclusive);
  }

  function shuffle<T>(array: T[]): T[] {
    const out = [...array];
    for (let index = out.length - 1; index > 0; index--) {
      const index_ = nextInt(index + 1);
      const temporary = out[index]!;
      out[index] = out[index_]!;
      out[index_] = temporary;
    }
    return out;
  }

  function sample<T>(array: T[], n: number): T[] {
    if (n < 0 || n > array.length) {
      throw new ValidationError(`sample requires 0 <= n <= arr.length (${array.length}), got ${n}`);
    }
    return shuffle(array).slice(0, n);
  }

  return { next, nextInt, shuffle, sample };
}
