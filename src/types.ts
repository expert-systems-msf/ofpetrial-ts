// Public data types — see openspec/changes/port-ofpetrial-ts/design.md (D3).
import type { Feature, FeatureCollection, LineString } from "geojson";

/**
 * Plot layout parameters (R: prep_plot output, one row).
 * All lengths are stored in meters regardless of the input unit system,
 * exactly like R (imperial inputs are converted on the way in).
 */
export interface PlotInfo {
  input_name: string;
  unit_system: "imperial" | "metric";
  machine_width: number;
  section_num: number;
  section_width: number;
  harvester_width: number;
  plot_width: number;
  headland_length: number;
  side_length: number;
  min_plot_length: number;
  max_plot_length: number;
}

/** One trial rate and its rank (R: rates_data row). */
export interface RateData {
  rate: number;
  rate_rank: number;
}

/** Rate design parameters (R: prep_rate output, one row). */
export interface RateInfo {
  input_name: string;
  rates_data: RateData[];
  /** null mirrors R's NA — the ls default applies at assignment time. */
  design_type: string | null;
  num_rates: number;
  gc_rate: number;
  unit: string;
  tgt_rate_original: number[];
  /** Nitrogen-equivalent rates (informational; see convertRates deviations). */
  tgt_rate_equiv: number[];
  rank_seq_ws: number[] | null;
  rank_seq_as: number[] | null;
  rate_jump_threshold: number | null;
}

/**
 * Output of makeExpPlots, input of assignRates.
 * plot_id restarts at 1 within each strip_id — only the (strip_id, plot_id)
 * pair identifies a plot (see plotKey below). Caveat, inherited from R: when
 * a boundary hole splits a strip into disjoint pieces, plot_id restarts per
 * piece, so (strip_id, plot_id) can repeat within such a strip.
 */
export interface InputLayout {
  plotInfo: PlotInfo;
  plots: FeatureCollection; // Feature<Polygon>, props: plot_id, strip_id
  headlands: FeatureCollection; // Feature<Polygon>, props: type: "headland"
  abLine: Feature<LineString>;
  guidanceLines: FeatureCollection;
}

export interface ExpData {
  inputs: InputLayout[];
}

/** Output of assignRates / assignRatesConditional. */
export interface InputDesign {
  plotInfo: PlotInfo;
  /**
   * null = ungauged input (geometry only), an intermediate state before
   * assignRatesConditional runs.
   */
  rateInfo: RateInfo | null;
  plots: FeatureCollection; // props: plot_id, strip_id, type (inherited from InputLayout) + rate, rate_rank when rateInfo != null
  headlands: FeatureCollection;
  abLine: Feature<LineString>;
  guidanceLines: FeatureCollection; // carried over from InputLayout (never dropped)
}

export interface TrialDesign {
  inputs: InputDesign[];
  /** Seed of the last randomization (assignRates or assignRatesConditional). */
  seed: number;
}

/**
 * One row of a spatial-join fragment table (R: st_intersection of the full
 * trial design, headlands included).
 */
export interface SoilFragment {
  /** `"${strip_id}:${plot_id}"` or `"headland"`. */
  plotKey: string;
  rate: number;
  values: Record<string, number>;
}

/**
 * Canonical plot key: `"${stripId}:${plotId}"` — matches SoilFragment.plotKey.
 * NOT guaranteed unique on fields with holes: R (and this port) restarts
 * plot_id per strip piece, so hole-split strips repeat keys. Consumers that
 * need a unique identity must key by feature, not by plotKey.
 */
export function plotKey(stripId: number, plotId: number): string {
  return `${stripId}:${plotId}`;
}

/** Base class for all errors thrown by ofpetrial-ts. */
export class OfpetrialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfpetrialError";
    Object.setPrototypeOf(this, OfpetrialError.prototype);
  }
}

/** Invalid or inconsistent input parameters. */
export class ValidationError extends OfpetrialError {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/** Geometry construction or repair failure (e.g. irreparable field boundary). */
export class GeometryError extends OfpetrialError {
  constructor(message: string) {
    super(message);
    this.name = "GeometryError";
    Object.setPrototypeOf(this, GeometryError.prototype);
  }
}

/** Machine-file export failure (Shapefile / GeoJSON / ISOXML). */
export class ExportError extends OfpetrialError {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
    Object.setPrototypeOf(this, ExportError.prototype);
  }
}
