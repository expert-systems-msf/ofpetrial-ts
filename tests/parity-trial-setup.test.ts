// Golden-master parity: prepPlot / prepRate against the frozen R fixtures
// (every case x unit system). Length fields match to 1 cm (task 3.1), rate
// fields to 1e-6 relative.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepPlot, prepRate } from "../src/trial-setup.js";
import type { PrepPlotOptions, PrepRateOptions } from "../src/trial-setup.js";
import { relClose } from "../test-cases-runner/compare.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

interface FixtureParameters {
  input_name: string;
  machine_width: number;
  section_num: number;
  harvester_width: number;
  gc_rate: number;
  unit: string;
  rates?: number[];
  min_rate?: number;
  max_rate?: number;
  num_rates?: number;
}

function fixtureDirectories(): Array<{
  caseName: string;
  unitSystem: "imperial" | "metric";
  dir: string;
}> {
  const out: Array<{ caseName: string; unitSystem: "imperial" | "metric"; dir: string }> = [];
  for (const caseName of readdirSync(FIXTURES)) {
    const casePath = join(FIXTURES, caseName);
    if (!statSync(casePath).isDirectory()) continue;
    for (const unitSystem of ["imperial", "metric"] as const) {
      out.push({ caseName, unitSystem, dir: join(casePath, unitSystem) });
    }
  }
  return out;
}

describe("prepPlot / prepRate parity with R fixtures", () => {
  for (const { caseName, unitSystem, dir } of fixtureDirectories()) {
    const parameters = JSON.parse(
      readFileSync(join(dir, "params.json"), "utf8")
    ) as FixtureParameters[];
    const rPlotInfos = JSON.parse(readFileSync(join(dir, "plot-info.json"), "utf8")) as Array<
      Array<Record<string, number | string>>
    >;
    const rRateInfos = JSON.parse(readFileSync(join(dir, "rate-info.json"), "utf8")) as Array<
      Array<Record<string, unknown>>
    >;

    describe(`${caseName}/${unitSystem}`, () => {
      for (const [index, p] of parameters.entries()) {
        it(`prepPlot matches R for input ${p.input_name}`, () => {
          const r = rPlotInfos[index]![0]!;
          const plotOptions: PrepPlotOptions = {
            inputName: p.input_name,
            unitSystem,
            machineWidth: p.machine_width,
            sectionNum: p.section_num,
            harvesterWidth: p.harvester_width,
          };
          const ts = prepPlot(plotOptions);
          expect(ts.input_name).toBe(r.input_name);
          expect(ts.unit_system).toBe(r.unit_system);
          expect(ts.section_num).toBe(r.section_num);
          for (const field of [
            "machine_width",
            "section_width",
            "harvester_width",
            "plot_width",
            "headland_length",
            "side_length",
            "min_plot_length",
            "max_plot_length",
          ] as const) {
            // 1 cm tolerance (task 3.1)
            expect(
              Math.abs(ts[field] - (r[field] as number)),
              `${field}: ${ts[field]} vs R ${String(r[field])}`
            ).toBeLessThanOrEqual(0.01);
          }
        });

        it(`prepRate matches R for input ${p.input_name}`, () => {
          const r = rRateInfos[index]![0]!;
          const rateOptions: PrepRateOptions = {
            gcRate: p.gc_rate,
            unit: p.unit,
            ...(p.rates && { rates: p.rates }),
            ...(p.min_rate !== undefined && { minRate: p.min_rate }),
            ...(p.max_rate !== undefined && { maxRate: p.max_rate }),
            ...(p.num_rates !== undefined && { numRates: p.num_rates }),
          };
          const plotOptions: PrepPlotOptions = {
            inputName: p.input_name,
            unitSystem,
            machineWidth: p.machine_width,
            sectionNum: p.section_num,
            harvesterWidth: p.harvester_width,
          };
          const ts = prepRate(prepPlot(plotOptions), rateOptions);

          expect(ts.input_name).toBe(r.input_name);
          expect(ts.design_type).toBe(r.design_type);
          expect(ts.num_rates).toBe(r.num_rates);
          expect(ts.gc_rate).toBe(r.gc_rate);
          expect(ts.unit).toBe(r.unit);
          expect(ts.rank_seq_ws).toEqual(r.rank_seq_ws);
          expect(ts.rank_seq_as).toEqual(r.rank_seq_as);
          expect(ts.rate_jump_threshold).toBe(r.rate_jump_threshold);

          const rRatesData = r.rates_data as Array<{ rate: number; rate_rank: number }>;
          expect(ts.rates_data).toHaveLength(rRatesData.length);
          ts.rates_data.forEach((rd, index) => {
            expect(relClose(rd.rate, rRatesData[index]!.rate, 1e-6)).toBe(true);
            expect(rd.rate_rank).toBe(rRatesData[index]!.rate_rank);
          });

          const rEquiv = r.tgt_rate_equiv as number[];
          // Deviation: R's convert_rates returns numeric(0) (serialized [])
          // on metric kg/liters paths; TS returns real values. Compare only
          // when R produced values.
          if (rEquiv.length > 0) {
            expect(ts.tgt_rate_equiv).toHaveLength(rEquiv.length);
            ts.tgt_rate_equiv.forEach((v, index) => {
              expect(relClose(v, rEquiv[index]!, 1e-6), `tgt_rate_equiv[${index}]`).toBe(true);
            });
          }
        });
      }
    });
  }
});
