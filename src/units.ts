// Imperial <-> metric conversions and input-dose (rate) conversions.
// Constants match ofpetrial 0.1.3's internal `generic_unit_conversion_table`
// and `input_unit_conversion_table` (R sources verified; ofpetrial does not
// depend on the `measurements` package).
import { ValidationError } from "./types.js";

/** 1 foot = 0.3048 meters (exact, international foot). */
export const FEET_TO_METERS = 0.3048;

/** 1 acre = 4046.8564224 m^2 = 0.40468564224 ha (exact, international acre). */
export const ACRES_TO_HECTARES = 0.40468564224;

/** 1 pound = 0.45359237 kg (exact, international avoirdupois pound). */
export const POUNDS_TO_KG = 0.45359237;

/**
 * 1 US gallon = 3.785411784 liters (exact). Used by `convertRates` for
 * metric liquid rates. Deviation from R 0.1.3: upstream `conv_unit(rate,
 * "liters", "gallons")` looks up a pair missing from
 * `generic_unit_conversion_table` and yields `numeric(0)` (empty); the TS
 * port applies the correct factor instead.
 */
export const LITERS_TO_GALLONS = 1 / 3.785411784;

/**
 * Pairwise conversion table, mirroring R's `generic_unit_conversion_table`
 * row for row (including its `acres -> m2` factor 4046.856422, which upstream
 * truncated relative to the exact 4046.8564224).
 */
export const GENERIC_UNIT_CONVERSION_TABLE: ReadonlyArray<{
  from: string;
  to: string;
  convFactor: number;
}> = [
  { from: "hectares", to: "acres", convFactor: 1 / ACRES_TO_HECTARES },
  { from: "acres", to: "hectares", convFactor: ACRES_TO_HECTARES },
  { from: "meters", to: "feet", convFactor: 1 / FEET_TO_METERS },
  { from: "feet", to: "meters", convFactor: FEET_TO_METERS },
  { from: "kg", to: "pounds", convFactor: 1 / POUNDS_TO_KG },
  { from: "pounds", to: "kg", convFactor: POUNDS_TO_KG },
  { from: "acres", to: "m2", convFactor: 4046.856422 },
  { from: "m2", to: "acres", convFactor: 1 / 4046.856422 },
];

/** Port of R `conv_unit(value, from, to)`: table lookup, error if the pair is unknown. */
export function convUnit(value: number, from: string, to: string): number {
  const row = GENERIC_UNIT_CONVERSION_TABLE.find((r) => r.from === from && r.to === to);
  if (!row) {
    throw new ValidationError(`No conversion factor from "${from}" to "${to}"`);
  }
  return value * row.convFactor;
}

export function feetToMeters(feet: number): number {
  return feet * FEET_TO_METERS;
}

export function metersToFeet(meters: number): number {
  return meters / FEET_TO_METERS;
}

export function acresToHectares(acres: number): number {
  return acres * ACRES_TO_HECTARES;
}

export function hectaresToAcres(hectares: number): number {
  return hectares / ACRES_TO_HECTARES;
}

/**
 * Nutrient-form dose table, mirroring R's `input_unit_conversion_table`:
 * multiplying a rate given in `unit` of the named input form by `convFactor`
 * yields the nitrogen-equivalent rate in lb (per acre).
 */
export const INPUT_UNIT_CONVERSION_TABLE: ReadonlyArray<{
  type: string;
  unit: string;
  convFactor: number;
}> = [
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
];

/**
 * Port of R `convert_rates(input_name, unit, rate, conversion_type)`.
 * Converts an input dose to its nitrogen-equivalent rate ("to_n_equiv",
 * default) or back ("from_n_equiv"). Unknown input names pass through
 * unchanged (faithful to R). Metric rates (liters, kg) are first converted
 * to imperial units, then the resulting factor is re-expressed per hectare
 * in kg.
 *
 * Documented deviations from R 0.1.3 (verified by direct execution; these
 * paths all return the empty vector `numeric(0)` upstream, which has no TS
 * equivalent and would poison downstream math):
 * - `unit = "liters"`: R looks up a liters->gallons pair missing from its
 *   generic table; TS applies the exact `LITERS_TO_GALLONS` factor.
 * - Unknown (input, unit) combination: R's intended fallback to factor 1 is
 *   dead code (the empty data.frame lookup is still `numeric`), so R yields
 *   `numeric(0)`; TS actually applies the fallback factor 1.
 * - Metric `kg` rates whose table row is kg-only (e.g. chicken_manure): R
 *   converts kg->lb then looks up `<input>_lb`, which misses, hitting the
 *   dead-fallback path above; TS falls back to factor 1.
 * These paths are excluded from R parity in parity-map.json; the affected
 * value (`tgt_rate_equiv`) is informational only in the ported scope.
 */
export function convertRates(
  inputName: string,
  unit: string,
  rate: number,
  conversionType: "to_n_equiv" | "from_n_equiv" = "to_n_equiv"
): number {
  if (!INPUT_UNIT_CONVERSION_TABLE.some((r) => r.type === inputName)) {
    return rate;
  }

  let workingRate = rate;
  let newUnit = unit;
  let metricReporting = false;
  if (unit === "liters") {
    workingRate = rate * LITERS_TO_GALLONS;
    newUnit = "gallons";
    metricReporting = true;
  } else if (unit === "kg") {
    workingRate = convUnit(rate, "kg", "pounds");
    newUnit = "lb";
    metricReporting = true;
  }

  let convFactorN: number;
  if (inputName === "N_equiv") {
    convFactorN = 1;
  } else {
    const row = INPUT_UNIT_CONVERSION_TABLE.find(
      (r) => `${r.type}_${r.unit}` === `${inputName}_${newUnit}`
    );
    // R: "no combination ... we will assume the conversion is 1"
    convFactorN = row ? row.convFactor : 1;
  }

  if (metricReporting) {
    convFactorN = convFactorN * convUnit(1, "pounds", "kg") * convUnit(1, "hectares", "acres");
  }

  return conversionType === "to_n_equiv"
    ? convFactorN * workingRate
    : (1 / convFactorN) * workingRate;
}
