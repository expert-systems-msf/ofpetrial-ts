// TypeScript runner for the shared test-cases/ parity suite (design.md D5).
// Discovers every test-cases/*.json, dispatches each case to the registry
// below, and compares with relative closeness. Cases whose function is not
// yet in the registry are skipped (they activate as port groups land).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convUnit, convertRates } from "../src/units.js";
import { findPlotWidth, getRates } from "../src/trial-setup.js";
import { relClose } from "../test-cases-runner/compare.js";

interface SharedCase {
  name: string;
  function: string;
  input: Record<string, unknown>;
  expected: unknown;
  tolerance: number;
  rParity: boolean;
}

interface SharedSuite {
  suite: string;
  cases: SharedCase[];
}

type CaseRunner = (input: Record<string, unknown>) => unknown;

const registry: Record<string, CaseRunner> = {
  convUnit: (input) => convUnit(input.value as number, input.from as string, input.to as string),
  convertRates: (input) =>
    convertRates(
      input.inputName as string,
      input.unit as string,
      input.rate as number,
      (input.conversionType as "to_n_equiv" | "from_n_equiv" | undefined) ?? "to_n_equiv"
    ),
  getRates: (input) =>
    getRates(
      input.minRate as number,
      input.maxRate as number,
      input.gcRate as number,
      input.numLevels as number
    ),
  findPlotWidth: (input) =>
    findPlotWidth(
      input.sectionWidth as number,
      input.harvesterWidth as number,
      input.maxPlotWidth as number
    ),
};

function assertClose(actual: unknown, expected: unknown, tol: number, path: string): void {
  if (typeof expected === "number") {
    expect(typeof actual, path).toBe("number");
    expect(
      relClose(actual as number, expected, tol),
      `${path}: ${String(actual)} !~ ${expected}`
    ).toBe(true);
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, path).toBe(expected.length);
    expected.forEach((e, i) => assertClose((actual as unknown[])[i], e, tol, `${path}[${i}]`));
  } else if (expected !== null && typeof expected === "object") {
    for (const [key, e] of Object.entries(expected)) {
      assertClose((actual as Record<string, unknown>)[key], e, tol, `${path}.${key}`);
    }
  } else {
    expect(actual, path).toEqual(expected);
  }
}

const casesDir = join(import.meta.dirname, "..", "test-cases");
const suiteFiles = readdirSync(casesDir).filter((f) => f.endsWith(".json"));

describe("shared test cases", () => {
  expect(suiteFiles.length).toBeGreaterThan(0);

  for (const file of suiteFiles) {
    const suite = JSON.parse(readFileSync(join(casesDir, file), "utf8")) as SharedSuite;

    describe(suite.suite, () => {
      for (const c of suite.cases) {
        const runner = registry[c.function];
        if (!runner) {
          it.skip(`${c.name} (function ${c.function} not yet ported)`, () => {});
          continue;
        }
        it(c.name, () => {
          assertClose(runner(c.input), c.expected, c.tolerance, c.function);
        });
      }
    });
  }
});
