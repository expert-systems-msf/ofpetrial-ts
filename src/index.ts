// ofpetrial-ts — TypeScript port of the ofpetrial R package (GPL-3).
// Public API surface is built up task by task; see openspec/changes/port-ofpetrial-ts/.

export const OFPETRIAL_R_VERSION = "0.1.3";

export type {
  ExpData,
  InputDesign,
  InputLayout,
  PlotInfo,
  RateInfo,
  SoilFragment,
  TrialDesign,
} from "./types.js";
export { ExportError, GeometryError, OfpetrialError, ValidationError, plotKey } from "./types.js";

export {
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

export { toUtm, toWgs, utmEpsg, utmProjString, utmZone } from "./projection.js";

export type { Rng } from "./rng.js";
export { createRng } from "./rng.js";
