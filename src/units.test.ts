import { describe, expect, it } from "vitest";
import {
  ACRES_TO_HECTARES,
  FEET_TO_METERS,
  GENERIC_UNIT_CONVERSION_TABLE,
  INPUT_UNIT_CONVERSION_TABLE,
  LITERS_TO_GALLONS,
  POUNDS_TO_KG,
  acresToHectares,
  convUnit,
  convertRates,
  feetToMeters,
  hectaresToAcres,
  metersToFeet,
} from "./units.js";
import { ValidationError } from "./types.js";

describe("unit constants", () => {
  // ofpetrial `generic_unit_conversion_table`: feet -> meters = 0.3048 (exact).
  it("FEET_TO_METERS is exact", () => {
    expect(FEET_TO_METERS).toBe(0.3048);
  });

  // ofpetrial `generic_unit_conversion_table`: acres -> hectares =
  // 0.40468564224 (exact, international acre).
  it("ACRES_TO_HECTARES is exact", () => {
    expect(ACRES_TO_HECTARES).toBe(0.40468564224);
  });

  it("POUNDS_TO_KG is exact", () => {
    expect(POUNDS_TO_KG).toBe(0.45359237);
  });

  it("LITERS_TO_GALLONS is the reciprocal of 3.785411784", () => {
    expect(LITERS_TO_GALLONS).toBe(1 / 3.785411784);
    // Pins the value (and rules out the `1 * 3.785411784` mutant, which is ~3.79).
    expect(LITERS_TO_GALLONS).toBeCloseTo(0.264172052358, 12);
  });
});

describe("convUnit", () => {
  // Reference values printed from R: as.data.frame(ofpetrial:::generic_unit_conversion_table)
  it("matches R's generic_unit_conversion_table factors", () => {
    expect(convUnit(1, "hectares", "acres")).toBeCloseTo(2.47105381467165, 12);
    expect(convUnit(1, "meters", "feet")).toBeCloseTo(3.28083989501312, 12);
    expect(convUnit(1, "kg", "pounds")).toBeCloseTo(2.20462262184878, 12);
    expect(convUnit(1, "acres", "m2")).toBe(4046.856422);
    expect(convUnit(1, "m2", "acres")).toBeCloseTo(2.4710538149159e-4, 15);
  });

  it("throws on an unknown pair (unlike R, which returns an empty vector)", () => {
    const act = () => convUnit(1, "liters", "gallons");
    expect(act).toThrow(ValidationError);
    expect(act).toThrow(/No conversion factor from "liters" to "gallons"/);
  });
});

describe("convertRates", () => {
  it("converts imperial doses to N-equivalent via the input table", () => {
    expect(convertRates("NH3", "gallons", 10)).toBeCloseTo(42, 12); // 4.2 lb N/gal
    expect(convertRates("urea", "lb", 100)).toBeCloseTo(46, 12); // 0.46
    expect(convertRates("uan32", "gallons", 2)).toBeCloseTo(7.08, 12); // 3.54
  });

  it("passes through unknown input names unchanged", () => {
    expect(convertRates("seed", "seeds", 34_000)).toBe(34_000);
    // Even with a metric unit, an unknown input must short-circuit before the
    // liters/kg branches run — otherwise a "seed" liters rate would be scaled
    // by the gallons/mass factors instead of passing straight through.
    expect(convertRates("seed", "liters", 100)).toBe(100);
    expect(convertRates("seed", "kg", 100)).toBe(100);
  });

  it("falls back to factor 1 for an unknown (input, unit) combination (deviation: R yields numeric(0))", () => {
    expect(convertRates("urea", "gallons", 55)).toBe(55);
  });

  it("re-expresses a metric kg rate in agronomically correct kg N (M8: deliberate divergence from R)", () => {
    // M8: R inflates the metric N-equivalent by ~2.471x (an areal double-count).
    // TS drops the hectares->acres factor, so a metric kg rate maps to a real
    // kg-N-per-hectare value. urea is 46% N -> 100 kg urea/ha = 46 kg N/ha,
    // matching the imperial `convertRates("urea", "lb", 100)` case exactly.
    expect(convertRates("urea", "kg", 100)).toBeCloseTo(46, 10);
    // chicken_manure has no `_lb` table row -> factor 1, so its kg rate passes
    // through unchanged (was 100 x 2.471 under R's areal double-count).
    expect(convertRates("chicken_manure", "kg", 100)).toBeCloseTo(100, 10);
  });

  it("applies the liters->gallons metric factor (deviation: R yields numeric(0))", () => {
    // NH3 given in liters: rate * LITERS_TO_GALLONS -> gallons, then the
    // NH3/gallons factor 4.2, then the metric lb->kg factor (M8). This is the
    // only path that exercises the `unit === "liters"` branch.
    const expected = 10 * LITERS_TO_GALLONS * 4.2 * POUNDS_TO_KG;
    expect(convertRates("NH3", "liters", 10)).toBeCloseTo(expected, 10);
    expect(convertRates("NH3", "liters", 10)).toBeCloseTo(5.0327, 3);
  });

  it("inverts with from_n_equiv", () => {
    const nEquiv = convertRates("NH3", "gallons", 10);
    expect(convertRates("NH3", "gallons", nEquiv, "from_n_equiv")).toBeCloseTo(10, 12);
  });
});

describe("conversion tables", () => {
  it("mirror R's row counts", () => {
    expect(GENERIC_UNIT_CONVERSION_TABLE).toHaveLength(8);
    expect(INPUT_UNIT_CONVERSION_TABLE).toHaveLength(13);
  });

  // Full row-by-row assertions: pins every `from`/`to`/`type`/`unit` string and
  // every convFactor, so a blanked object literal or string mutant is caught.
  // Derived factors are recomputed from the same exact constants, so the
  // comparison is bit-for-bit.
  it("mirrors R's generic_unit_conversion_table exactly", () => {
    expect(GENERIC_UNIT_CONVERSION_TABLE).toEqual([
      { from: "hectares", to: "acres", convFactor: 1 / ACRES_TO_HECTARES },
      { from: "acres", to: "hectares", convFactor: ACRES_TO_HECTARES },
      { from: "meters", to: "feet", convFactor: 1 / FEET_TO_METERS },
      { from: "feet", to: "meters", convFactor: FEET_TO_METERS },
      { from: "kg", to: "pounds", convFactor: 1 / POUNDS_TO_KG },
      { from: "pounds", to: "kg", convFactor: POUNDS_TO_KG },
      { from: "acres", to: "m2", convFactor: 4046.856422 },
      { from: "m2", to: "acres", convFactor: 1 / 4046.856422 },
    ]);
  });

  it("mirrors R's input_unit_conversion_table exactly", () => {
    expect(INPUT_UNIT_CONVERSION_TABLE).toEqual([
      { type: "NH3", unit: "gallons", convFactor: 4.2 },
      { type: "uan32", unit: "gallons", convFactor: 3.54 },
      { type: "uan28", unit: "gallons", convFactor: 2.9876 },
      { type: "n_equiv", unit: "lb", convFactor: 1 },
      { type: "uan28_ats", unit: "gallons", convFactor: 2.822 },
      { type: "urea", unit: "lb", convFactor: 0.46 },
      { type: "ammonium_nitrate", unit: "lb", convFactor: 0.34 },
      { type: "NH3", unit: "lb", convFactor: 0.82 },
      { type: "KCL", unit: "gallons", convFactor: 0.91 },
      { type: "cover", unit: "lb", convFactor: 1 },
      { type: "chicken_manure", unit: "kg", convFactor: 1 },
      { type: "24-0-0-3 UAN", unit: "gallons", convFactor: 2.4336 },
      { type: "general", unit: "given", convFactor: 1 },
    ]);
  });
});

describe("feetToMeters / metersToFeet", () => {
  it("converts feet to meters", () => {
    expect(feetToMeters(1)).toBe(0.3048);
    expect(feetToMeters(10)).toBeCloseTo(3.048, 10);
  });

  it("converts meters to feet", () => {
    expect(metersToFeet(0.3048)).toBeCloseTo(1, 10);
  });

  it("round-trips within floating point precision", () => {
    expect(metersToFeet(feetToMeters(123.456))).toBeCloseTo(123.456, 9);
  });
});

describe("acresToHectares / hectaresToAcres", () => {
  it("converts acres to hectares", () => {
    expect(acresToHectares(1)).toBe(0.40468564224);
    expect(acresToHectares(10)).toBeCloseTo(4.0468564224, 10);
  });

  it("converts hectares to acres", () => {
    expect(hectaresToAcres(0.40468564224)).toBeCloseTo(1, 10);
  });

  it("round-trips within floating point precision", () => {
    expect(hectaresToAcres(acresToHectares(42))).toBeCloseTo(42, 9);
  });
});
