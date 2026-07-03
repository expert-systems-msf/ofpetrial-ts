import { describe, expect, it } from "vitest";
import {
  ACRES_TO_HECTARES,
  FEET_TO_METERS,
  GENERIC_UNIT_CONVERSION_TABLE,
  INPUT_UNIT_CONVERSION_TABLE,
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
    expect(() => convUnit(1, "liters", "gallons")).toThrow(ValidationError);
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
  });

  it("falls back to factor 1 for an unknown (input, unit) combination (deviation: R yields numeric(0))", () => {
    expect(convertRates("urea", "gallons", 55)).toBe(55);
  });

  it("re-expresses metric kg rates per hectare in kg N (deviation: R yields numeric(0))", () => {
    // kg -> pounds, then (fallback factor 1) x lb->kg x ha->acres
    const rate = 100;
    const expected = rate * (1 / 0.45359237) * 1 * 0.45359237 * (1 / 0.40468564224);
    expect(convertRates("chicken_manure", "kg", rate)).toBeCloseTo(expected, 10);
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
