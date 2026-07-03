// ISOXML writer (task 7.3, BETA — see docs/isoxml-units.md). No R reference
// export exists for this format (write_trial_files() has no isoxml ext), so
// verification is a round-trip: write -> parse with an independent XML
// reader (tests/exports-isoxml-reader.ts) -> assert element/attribute
// counts and the documented DDI conversion.
import { describe, expect, it } from "vitest";
import type { MultiPolygon, Polygon } from "geojson";
import { ExportError } from "../src/types.js";
import type { IsoxmlPlotInput } from "../src/exports/isoxml.js";
import { rateToDdiValue, writeIsoxml } from "../src/exports/isoxml.js";
import { loadTrialDesign } from "./exports-fixtures.js";
import { countTag, parseTags } from "./exports-isoxml-reader.js";

function plotsOf(inputName: string, td: ReturnType<typeof loadTrialDesign>): IsoxmlPlotInput[] {
  const input = td.inputs.find((i) => i.plotInfo.input_name === inputName)!;
  const plots: IsoxmlPlotInput[] = input.plots.features.map((f) => ({
    geometry: f.geometry as Polygon | MultiPolygon,
    rate: (f.properties as { rate: number }).rate,
  }));
  for (const f of input.headlands.features) {
    plots.push({
      geometry: f.geometry as Polygon | MultiPolygon,
      rate: (f.properties as { rate: number }).rate,
    });
  }
  return plots;
}

describe("rateToDdiValue — documented worked examples (docs/isoxml-units.md)", () => {
  it("34000 seeds/ac (imperial) -> DDI 000B, raw 8402", () => {
    const { ddiHex, raw } = rateToDdiValue(34000, "imperial", "seeds");
    expect(ddiHex).toBe("000B");
    expect(raw).toBe(8402);
  });

  it("180 lb/ac (imperial) -> DDI 0006, raw 20175", () => {
    const { ddiHex, raw } = rateToDdiValue(180, "imperial", "lb");
    expect(ddiHex).toBe("0006");
    expect(raw).toBe(20175);
  });

  it("throws ExportError on an unmapped rate unit", () => {
    expect(() => rateToDdiValue(10, "imperial", "furlongs")).toThrow(ExportError);
  });
});

describe("writeIsoxml — round-trip structure (simple1, imperial, seed)", () => {
  const td = loadTrialDesign("simple1", "imperial", ["seed"]);
  const plots = plotsOf("seed", td);
  const xml = new TextDecoder().decode(
    writeIsoxml(plots, { inputName: "seed", unitSystem: "imperial", rateUnit: "seeds" })
  );
  const tags = parseTags(xml);

  it("is well-formed enough to parse: root, one PFD, one TSK", () => {
    expect(countTag(tags, "ISO11783_TaskData")).toBe(1);
    expect(countTag(tags, "PFD")).toBe(1);
    expect(countTag(tags, "TSK")).toBe(1);
  });

  it("root declares VersionMajor/VersionMinor/DataTransferOrigin (cross-checked against isoxml-js)", () => {
    const root = tags.find((t) => t.name === "ISO11783_TaskData")!;
    expect(root.attrs.VersionMajor).toBe("4");
    expect(root.attrs.DataTransferOrigin).toBe("1");
    expect(root.attrs.ManagementSoftwareManufacturer).toBeTruthy();
  });

  it("groups plots into one TZN per distinct rate, each with exactly one PDV", () => {
    const distinctRates = new Set(plots.map((p) => p.rate));
    expect(countTag(tags, "TZN")).toBe(distinctRates.size);
    expect(countTag(tags, "PDV")).toBe(distinctRates.size);
  });

  it("emits one PLN per plot (nested under its rate's TZN)", () => {
    // Every plot is a simple Polygon (1 ring) in this fixture, so 1 PLN per plot.
    expect(countTag(tags, "PLN")).toBe(plots.length);
  });

  it("PDV carries the documented DDI for the headland's gc_rate (34000 seeds/ac)", () => {
    const pdvs = tags.filter((t) => t.name === "PDV");
    const headlandPdv = pdvs.find((p) => p.attrs.B === "8402");
    expect(headlandPdv).toBeDefined();
    expect(headlandPdv!.attrs.A).toBe("000B");
  });

  it("throws ExportError on an empty plot list", () => {
    expect(() =>
      writeIsoxml([], { inputName: "seed", unitSystem: "imperial", rateUnit: "seeds" })
    ).toThrow(ExportError);
  });
});

describe("writeIsoxml — 254-zone ceiling", () => {
  it("throws ExportError when more than 254 distinct rates are given", () => {
    const geometry: Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [0, 0.001],
          [0.001, 0.001],
          [0.001, 0],
          [0, 0],
        ],
      ],
    };
    const plots: IsoxmlPlotInput[] = Array.from({ length: 255 }, (_, i) => ({ geometry, rate: i }));
    expect(() =>
      writeIsoxml(plots, { inputName: "seed", unitSystem: "imperial", rateUnit: "seeds" })
    ).toThrow(ExportError);
  });
});

describe("writeIsoxml — metric units (hectare basis, kg and liters DDI mappings)", () => {
  // A tiny synthetic TrialDesign: one plot at a known rate. Exercised through
  // writeTrialFiles to cover the full metric ISOXML path end to end.
  async function tinyMetricZip(rateUnit: string, rate: number) {
    const { writeTrialFiles } = await import("../src/exports/write-trial-files.js");
    const { unzipSync } = await import("fflate");
    const geometry: Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [-71.2, 46.8],
          [-71.2, 46.801],
          [-71.199, 46.801],
          [-71.199, 46.8],
          [-71.2, 46.8],
        ],
      ],
    };
    const base = loadTrialDesign("two-input", "metric", ["NH3"]);
    const input = base.inputs[0]!;
    const td = {
      seed: 0,
      inputs: [
        {
          ...input,
          plotInfo: { ...input.plotInfo, input_name: "tiny", unit_system: "metric" as const },
          rateInfo: { ...input.rateInfo!, unit: rateUnit },
          plots: {
            type: "FeatureCollection" as const,
            features: [
              {
                type: "Feature" as const,
                properties: { rate, strip_id: 1, plot_id: 1 },
                geometry,
              },
            ],
          },
          headlands: { type: "FeatureCollection" as const, features: [] },
        },
      ],
    };
    const files = unzipSync(writeTrialFiles(td, { ext: "isoxml" }));
    return new TextDecoder().decode(files["tiny/TASKDATA.XML"]!);
  }

  it("kg/ha -> DDI 0006 with mg/m2 conversion over 10 000 m2 (200 kg/ha -> 20000)", async () => {
    // 200 kg/ha = 200e6 mg / 10 000 m2 = 20 000 mg/m2, resolution 1 -> 20000.
    expect(rateToDdiValue(200, "metric", "kg")).toEqual({ ddiHex: "0006", raw: 20000 });
    const xml = await tinyMetricZip("kg", 200);
    const pdvs = parseTags(xml).filter((t) => t.name === "PDV");
    expect(pdvs).toHaveLength(1);
    expect(pdvs[0]!.attrs.A).toBe("0006");
    expect(pdvs[0]!.attrs.B).toBe("20000");
  });

  it("liters/ha -> DDI 0001 with mm3/m2 conversion over 10 000 m2 (150 L/ha -> 1 500 000)", async () => {
    // 150 L/ha = 150e6 mm3 / 10 000 m2 = 15 000 mm3/m2, resolution 0.01 -> 1 500 000.
    expect(rateToDdiValue(150, "metric", "liters")).toEqual({ ddiHex: "0001", raw: 1_500_000 });
    const xml = await tinyMetricZip("liters", 150);
    const pdvs = parseTags(xml).filter((t) => t.name === "PDV");
    expect(pdvs).toHaveLength(1);
    expect(pdvs[0]!.attrs.A).toBe("0001");
    expect(pdvs[0]!.attrs.B).toBe("1500000");
  });

  it("metric fixture NH3 (kg) flows through writeTrialFiles with DDI 0006", async () => {
    const { writeTrialFiles } = await import("../src/exports/write-trial-files.js");
    const { unzipSync } = await import("fflate");
    const td = loadTrialDesign("two-input", "metric", ["seed", "NH3"]);
    const files = unzipSync(writeTrialFiles(td, { ext: "isoxml" }));
    const nh3Pdvs = parseTags(new TextDecoder().decode(files["NH3/TASKDATA.XML"]!)).filter(
      (t) => t.name === "PDV"
    );
    expect(nh3Pdvs.length).toBeGreaterThan(0);
    expect(nh3Pdvs.every((p) => p.attrs.A === "0006")).toBe(true);
    const gcRate = td.inputs.find((i) => i.plotInfo.input_name === "NH3")!.rateInfo!.gc_rate;
    const { raw } = rateToDdiValue(gcRate, "metric", "kg");
    expect(nh3Pdvs.some((p) => p.attrs.B === String(raw))).toBe(true);
  });
});
