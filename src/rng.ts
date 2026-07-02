// Seedable RNG (splitmix32) — not a reproduction of R's RNG (see design.md D4);
// parity with R on randomized parts is judged by properties, not by sequence.
import { ValidationError } from "./types.js";

export interface Rng {
  /** Next pseudo-random number in [0, 1). */
  next(): number;
  /** Next pseudo-random integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /** Fisher-Yates shuffle; returns a new array, leaves the input untouched. */
  shuffle<T>(arr: T[]): T[];
  /** n distinct elements drawn from arr (order = shuffled order), as a new array. */
  sample<T>(arr: T[], n: number): T[];
}

export function createRng(seed: number): Rng {
  let state = seed | 0;

  function next(): number {
    state = (state + 0x9e3779b9) | 0;
    let t = state ^ (state >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return (t >>> 0) / 4294967296;
  }

  function nextInt(maxExclusive: number): number {
    if (maxExclusive <= 0) {
      throw new ValidationError(`nextInt requires maxExclusive > 0, got ${maxExclusive}`);
    }
    return Math.floor(next() * maxExclusive);
  }

  function shuffle<T>(arr: T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = nextInt(i + 1);
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  }

  function sample<T>(arr: T[], n: number): T[] {
    if (n < 0 || n > arr.length) {
      throw new ValidationError(`sample requires 0 <= n <= arr.length (${arr.length}), got ${n}`);
    }
    return shuffle(arr).slice(0, n);
  }

  return { next, nextInt, shuffle, sample };
}
