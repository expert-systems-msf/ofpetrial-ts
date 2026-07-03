// Design diagnostics — port of R diagnose.R (check_alignment, check_ortho_inputs,
// check_ortho_with_chars, summarize_chars, summarize_indiv_char) and the
// make_harvest_path helper from utility_spatial.R (ofpetrial 0.1.3).
//
// R renders ggplot objects alongside these checks; per design.md's
// non-goals, only the tabular data is ported (no viz). All geometric work
// happens in a single shared UTM plane (meters), like R's make_sf_utm /
// st_transform_utm, reusing the projection helpers from projection.ts.
// Polygon clipping uses @turf/intersect (a polygon-clipping wrapper, same
// engine family as the @turf/union/difference already used in
// plot-layout.ts — design.md D2) since the harvester-strip-vs-field and
// design-vs-soil clips are genuine 2D boolean operations, not the
// axis-aligned scanline case plot-layout.ts optimizes for.
import intersect from "@turf/intersect";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from "geojson";
import { signedRingArea, utmEpsgFromVertexMean } from "./geometry-utils.js";
import { toUtm } from "./projection.js";
import type { RasterGrid } from "./raster.js";
import { plotKey, ValidationError } from "./types.js";
import type { InputDesign, SoilFragment, TrialDesign } from "./types.js";

type Pt = [number, number];
type BBox = [number, number, number, number]; // xmin, ymin, xmax, ymax

// !===========================================================
// ! Planar geometry helpers (meters — no lon/lat semantics assumed)
// !===========================================================

/** Polygon ring area with holes subtracted (R: st_area on a projected/UTM geometry). */
function polygonRingsArea(rings: Position[][]): number {
  if (rings.length === 0) return 0;
  let total = Math.abs(signedRingArea(rings[0]!));
  for (let index = 1; index < rings.length; index++)
    total -= Math.abs(signedRingArea(rings[index]!));
  return total;
}

function planarArea(geom: Polygon | MultiPolygon): number {
  if (geom.type === "Polygon") return polygonRingsArea(geom.coordinates);
  return geom.coordinates.reduce((sum, rings) => sum + polygonRingsArea(rings), 0);
}

function ringPointsOf(geom: Polygon | MultiPolygon): Position[] {
  const rings = geom.type === "Polygon" ? geom.coordinates : geom.coordinates.flat();
  return rings.flat();
}

function bboxOfGeom(geom: Polygon | MultiPolygon): BBox {
  let xmin = Infinity;
  let ymin = Infinity;
  let xmax = -Infinity;
  let ymax = -Infinity;
  for (const [x, y] of ringPointsOf(geom)) {
    if (x! < xmin) xmin = x!;
    if (x! > xmax) xmax = x!;
    if (y! < ymin) ymin = y!;
    if (y! > ymax) ymax = y!;
  }
  return [xmin, ymin, xmax, ymax];
}

function bboxOverlap(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function asFeature(geom: Polygon | MultiPolygon): Feature<Polygon | MultiPolygon> {
  return { type: "Feature", properties: {}, geometry: geom };
}

/** @turf/intersect wrapper: null when the two polygons don't overlap. */
function intersectPolygons(
  a: Polygon | MultiPolygon,
  b: Polygon | MultiPolygon
): (Polygon | MultiPolygon) | null {
  const result = intersect({ type: "FeatureCollection", features: [asFeature(a), asFeature(b)] });
  return result ? (result.geometry as Polygon | MultiPolygon) : null;
}

function projectGeom(geom: Polygon | MultiPolygon, epsg: number): Polygon | MultiPolygon {
  const project = (pos: Position): Position => toUtm([pos[0]!, pos[1]!], epsg).point;
  if (geom.type === "Polygon") {
    return { type: "Polygon", coordinates: geom.coordinates.map((ring) => ring.map(project)) };
  }
  return {
    type: "MultiPolygon",
    coordinates: geom.coordinates.map((poly) => poly.map((ring) => ring.map(project))),
  };
}

/**
 * Shared UTM zone for a set of polygon features. See utmEpsgFromVertexMean
 * for how this relates to R's make_sf_utm zone choice (same zone, different
 * algorithm; deliberate N/S hemisphere handling vs R's hardcoded 326xx).
 */
function utmEpsgFromFeatures(features: Array<Feature<Polygon | MultiPolygon>>): number {
  return utmEpsgFromVertexMean(features.flatMap((f) => ringPointsOf(f.geometry)));
}

// !===========================================================
// ! Correlation helpers
// !===========================================================

/** Unweighted Pearson correlation (R: stats::cor(use = "complete.obs") — caller filters nulls). */
function pearsonCorrelation(pairs: Array<{ x: number; y: number }>): number {
  const n = pairs.length;
  if (n === 0) return NaN;
  let sx = 0;
  let sy = 0;
  for (const { x, y } of pairs) {
    sx += x;
    sy += y;
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (const { x, y } of pairs) {
    const dx = x - mx;
    const dy = y - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  return cov / Math.sqrt(vx * vy);
}

/** Area-weighted Pearson correlation (R: stats::cov.wt(..., cor = TRUE)$cor[1, 2]). */
function weightedCorrelation(pairs: Array<{ x: number; y: number; w: number }>): number {
  let sw = 0;
  let swx = 0;
  let swy = 0;
  for (const { x, y, w } of pairs) {
    sw += w;
    swx += w * x;
    swy += w * y;
  }
  const mx = swx / sw;
  const my = swy / sw;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (const { x, y, w } of pairs) {
    const dx = x - mx;
    const dy = y - my;
    cov += w * dx * dy;
    vx += w * dx * dx;
    vy += w * dy * dy;
  }
  return cov / Math.sqrt(vx * vy);
}

// !===========================================================
// ! checkAlignment (R: check_alignment + make_harvest_path)
// !===========================================================

/** One row of `AlignmentResult.overlapData` (R: check_alignment's overlap_data, column names kept as-is). */
export interface AlignmentOverlapRow {
  ha_strip_id: number;
  strip_id: number;
  area: number;
  ha_area: number;
  total_intersecting_ha_area: number;
  intersecting_pct: number;
  dominant_pct: number;
}

export interface AlignmentResult {
  inputName: string;
  overlapData: AlignmentOverlapRow[];
}

/**
 * One pre-aggregation row of check_alignment's interior: a harvester-strip x
 * experiment-plot intersection fragment (R: st_intersection(harvester_path,
 * exp_plots) before the data.table group-by). `ha_area` is the harvester
 * strip's own area clipped to the field. Matches the rows exported by
 * tools/gen-fixtures.R as alignment-fragments.json.
 */
export interface AlignmentFragment {
  ha_strip_id: number;
  strip_id: number | null;
  area: number;
  ha_area: number;
}

/**
 * R check_alignment's aggregation tail (the data.table block): group
 * fragments by (ha_strip_id, strip_id) summing area (ha_area is constant per
 * harvester strip; R takes the group mean), drop harvester strips whose
 * intersecting area is <= 10% of their own, keep the first-max-area group per
 * harvester strip (R which.max), order by ha_strip_id.
 */
function aggregateAlignmentFragments(fragments: AlignmentFragment[]): AlignmentOverlapRow[] {
  interface Group {
    haStripId: number;
    stripId: number;
    area: number;
    haAreaSum: number;
    n: number;
  }
  const groups = new Map<string, Group>();
  const order: Group[] = [];
  for (const f of fragments) {
    if (f.strip_id === null) continue; // R: .[!is.na(strip_id), ]
    const key = `${f.ha_strip_id}|${f.strip_id}`;
    let g = groups.get(key);
    if (!g) {
      g = { haStripId: f.ha_strip_id, stripId: f.strip_id, area: 0, haAreaSum: 0, n: 0 };
      groups.set(key, g);
      order.push(g);
    }
    g.area += f.area;
    g.haAreaSum += f.ha_area;
    g.n += 1;
  }

  const byHa = new Map<number, Group[]>();
  for (const g of order) {
    const bucket = byHa.get(g.haStripId);
    if (bucket) bucket.push(g);
    else byHa.set(g.haStripId, [g]);
  }

  const overlapData: AlignmentOverlapRow[] = [];
  for (const [haId, rows] of byHa) {
    const totalIntersecting = rows.reduce((sum, r) => sum + r.area, 0);
    // R which.max: FIRST max in group order
    let dominant = rows[0]!;
    for (const r of rows) if (r.area > dominant.area) dominant = r;
    const haArea = dominant.haAreaSum / dominant.n;
    const intersectingPct = totalIntersecting / haArea;
    // R: remove strips whose intersecting area is less than 10% of its area
    if (!(intersectingPct > 0.1)) continue;
    overlapData.push({
      ha_strip_id: haId,
      strip_id: dominant.stripId,
      area: dominant.area,
      ha_area: haArea,
      total_intersecting_ha_area: totalIntersecting,
      intersecting_pct: intersectingPct,
      dominant_pct: dominant.area / totalIntersecting,
    });
  }
  overlapData.sort((a, b) => a.ha_strip_id - b.ha_strip_id);
  return overlapData;
}

type PlotProperties = { plot_id: number; strip_id: number };

/**
 * Harvester strips at `harvester_width` against the input's harvest guidance
 * line (R: make_harvest_path), clipped to the field (reconstructed here as
 * plots ∪ headlands, since InputDesign does not carry the raw boundary —
 * design.md D3), intersected with the experiment plots.
 *
 * Strip tiling: R anchors a grid on the field centroid and then shifts it so
 * one strip's center line coincides with the guidance line; after that shift
 * every strip center sits at `vLine + k * harvester_width` for integer k, so
 * this port derives the tiling directly from the guidance line —
 * algebraically identical to R's anchor-then-correct construction.
 *
 * Strip *ordering* is a provable invariant, not a fixture-specific
 * observation: R's rotate_mat_p90 maps the ab direction (x, y) to (y, -x)
 * (clockwise) and create_strips walks base points from +2*radius along that
 * vector downward, so R's group id increases as position . p90_R decreases.
 * This port's p90 is the counter-clockwise (-y, x) = -p90_R, so
 * position . p90 = -(position . p90_R) and iterating k (hence v) ascending
 * reproduces R's group order exactly — the two sign flips cancel.
 *
 * Strip *labels* (deviation, documented in parity-map.json): R numbers
 * ha_strip_id 1..n over the strips that survive its pre-shift field subset
 * and post-shift clip, so a sliver strip at the field edge surviving in one
 * engine and not the other shifts every subsequent label by a constant. Rows
 * are physically identical; live-mode parity is therefore checked by row
 * content and relative order rather than the raw label (the precomputed mode
 * carries R's own labels and matches them exactly).
 */
function alignmentForInput(input: InputDesign): AlignmentResult {
  const plotFeatures = input.plots.features as Array<Feature<Polygon | MultiPolygon>>;
  const headlandFeatures = input.headlands.features as Array<Feature<Polygon | MultiPolygon>>;
  const epsg = utmEpsgFromFeatures([...plotFeatures, ...headlandFeatures]);

  const plotsUtm = plotFeatures.map((f) => ({
    stripId: (f.properties as PlotProperties).strip_id,
    geom: projectGeom(f.geometry, epsg),
  }));
  const headlandsUtm = headlandFeatures.map((f) => projectGeom(f.geometry, epsg));

  const guideLine = input.guidanceLines.features[0] as Feature<LineString>;
  const [g0, g1] = guideLine.geometry.coordinates;
  const p1 = toUtm([g0![0]!, g0![1]!], epsg).point;
  const p2 = toUtm([g1![0]!, g1![1]!], epsg).point;
  const abVec: Pt = [p2[0] - p1[0], p2[1] - p1[1]];
  const abLength = Math.hypot(abVec[0], abVec[1]);
  const nml: Pt = [abVec[0] / abLength, abVec[1] / abLength];
  const p90: Pt = [-nml[1], nml[0]]; // R: ab_xy_nml_p90 (90 deg CCW rotation)
  const dot = (p: Pt, v: Pt): number => p[0] * v[0] + p[1] * v[1];
  const vLine = dot(p1, p90);

  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const geom of [...plotsUtm.map((p) => p.geom), ...headlandsUtm]) {
    for (const pt of ringPointsOf(geom)) {
      const u = dot(pt as Pt, nml);
      const v = dot(pt as Pt, p90);
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
  }

  const pw = input.plotInfo.harvester_width;
  const halfW = pw / 2;
  const uPad = 50;
  const stripU: [number, number] = [uMin - uPad, uMax + uPad];
  const fromFrame = (u: number, v: number): Pt => [
    u * nml[0] + v * p90[0],
    u * nml[1] + v * p90[1],
  ];
  const rectGeom = (vc: number): Polygon => {
    const c1 = fromFrame(stripU[0], vc - halfW);
    const c2 = fromFrame(stripU[1], vc - halfW);
    const c3 = fromFrame(stripU[1], vc + halfW);
    const c4 = fromFrame(stripU[0], vc + halfW);
    return { type: "Polygon", coordinates: [[c1, c2, c3, c4, c1]] };
  };

  const kMax = Math.ceil((vMax - vLine) / pw) + 1;
  const kMin = Math.floor((vMin - vLine) / pw) - 1;

  // One AlignmentFragment per (harvester strip, experiment strip) pair —
  // fragment areas within a pair are pre-summed here, which the aggregator's
  // own group-and-sum makes equivalent to R's per-fragment rows.
  const fragments: AlignmentFragment[] = [];
  let haStripId = 0;
  // Ascending k == ascending v reproduces R's group order (see docstring:
  // p90 sign flip vs R cancels against the iteration direction).
  for (let k = kMin; k <= kMax; k++) {
    const vc = vLine + k * pw;
    const rect = rectGeom(vc);
    const rectBbox = bboxOfGeom(rect);
    const overlapByStrip = new Map<number, number>();
    let haArea = 0;
    for (const { stripId, geom } of plotsUtm) {
      if (!bboxOverlap(rectBbox, bboxOfGeom(geom))) continue;
      const ov = intersectPolygons(rect, geom);
      if (!ov) continue;
      const a = planarArea(ov);
      if (a <= 0) continue;
      haArea += a;
      overlapByStrip.set(stripId, (overlapByStrip.get(stripId) ?? 0) + a);
    }
    for (const geom of headlandsUtm) {
      if (!bboxOverlap(rectBbox, bboxOfGeom(geom))) continue;
      const ov = intersectPolygons(rect, geom);
      if (!ov) continue;
      const a = planarArea(ov);
      if (a > 0) haArea += a;
    }
    if (haArea <= 1e-9) continue;
    haStripId += 1;
    for (const [stripId, area] of overlapByStrip) {
      fragments.push({ ha_strip_id: haStripId, strip_id: stripId, area, ha_area: haArea });
    }
  }

  return {
    inputName: input.plotInfo.input_name,
    overlapData: aggregateAlignmentFragments(fragments),
  };
}

/**
 * Port of R `check_alignment` (tabular data only — no ggplot objects, see
 * design.md non-goals).
 *
 * Dual input mode, mirroring checkOrthoWithChars:
 * - `checkAlignment(td)` — full geometric computation (harvester path,
 *   intersection with the experiment plots, aggregation).
 * - `checkAlignment(td, fragments)` — `fragments[i]` is the precomputed
 *   fragment table for `td.inputs[i]` (e.g. R's alignment-fragments.json);
 *   only the aggregation runs, no geometry. This is the 1e-6 parity path.
 */
export function checkAlignment(
  td: TrialDesign,
  fragments?: AlignmentFragment[][]
): AlignmentResult[] {
  if (fragments) {
    if (fragments.length !== td.inputs.length) {
      throw new ValidationError(
        `checkAlignment received ${fragments.length} fragment table(s) for ${td.inputs.length} input(s).`
      );
    }
    return td.inputs.map((input, index) => ({
      inputName: input.plotInfo.input_name,
      overlapData: aggregateAlignmentFragments(fragments[index]!),
    }));
  }
  return td.inputs.map(alignmentForInput);
}

// !===========================================================
// ! checkOrthoInputs (R: check_ortho_inputs)
// !===========================================================

/**
 * One pre-cov.wt row of check_ortho_inputs' interior: an experiment-plot x
 * experiment-plot intersection fragment of the two inputs' designs, carrying
 * the pair of rates and the fragment area (the cov.wt weight). Matches the
 * rows exported by tools/gen-fixtures.R as ortho-fragments.json.
 */
export interface OrthoInputsFragment {
  rate_1: number;
  rate_2: number;
  area: number;
}

/**
 * Port of R `check_ortho_inputs`: area-weighted correlation between the two
 * inputs' rates over `st_intersection` of their experiment plots only
 * (headlands excluded, matching R's `dplyr::filter(type == "experiment")`).
 *
 * Dual input mode, mirroring checkOrthoWithChars:
 * - `checkOrthoInputs(td)` — full geometric computation (pairwise plot
 *   intersection, then cov.wt).
 * - `checkOrthoInputs(td, fragments)` — precomputed pair-fragment table
 *   (e.g. R's ortho-fragments.json); only the weighted correlation runs, no
 *   geometry. This is the 1e-6 parity path.
 *
 * Deviation from R: R's single-input branch never assigns `cor_input` and
 * therefore errors with "object 'cor_input' not found" when the caller
 * prints/returns it — this port throws an explicit ValidationError instead.
 */
export function checkOrthoInputs(td: TrialDesign, fragments?: OrthoInputsFragment[]): number {
  if (td.inputs.length < 2) {
    throw new ValidationError(
      "checkOrthoInputs requires a two-input trial design; this design has only one input " +
        "(R's own check_ortho_inputs errors the same way here: cor_input is never assigned)."
    );
  }
  if (fragments) {
    return weightedCorrelation(fragments.map((f) => ({ x: f.rate_1, y: f.rate_2, w: f.area })));
  }
  const [inputA, inputB] = td.inputs as [InputDesign, InputDesign];
  const featuresA = inputA.plots.features as Array<Feature<Polygon | MultiPolygon>>;
  const featuresB = inputB.plots.features as Array<Feature<Polygon | MultiPolygon>>;
  const epsg = utmEpsgFromFeatures([...featuresA, ...featuresB]);

  const project = (f: Feature<Polygon | MultiPolygon>) => {
    const geom = projectGeom(f.geometry, epsg);
    return { rate: (f.properties as { rate: number }).rate, geom, bbox: bboxOfGeom(geom) };
  };
  const projA = featuresA.map(project);
  const projB = featuresB.map(project);

  const pairs: Array<{ x: number; y: number; w: number }> = [];
  for (const a of projA) {
    for (const b of projB) {
      if (!bboxOverlap(a.bbox, b.bbox)) continue;
      const ov = intersectPolygons(a.geom, b.geom);
      if (!ov) continue;
      const area = planarArea(ov);
      if (area <= 0) continue;
      pairs.push({ x: a.rate, y: b.rate, w: area });
    }
  }
  return weightedCorrelation(pairs);
}

// !===========================================================
// ! spatialJoin (R: st_intersection / st_join used inside summarize_chars)
// !===========================================================

type DesignProperties = { type?: string; strip_id?: number; plot_id?: number; rate: number };

/** Numeric and character/string soil properties (R: numeric + factor/character columns). */
function extractJoinableValues(
  properties: Record<string, unknown> | null
): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  if (!properties) return out;
  for (const [k, v] of Object.entries(properties)) {
    if (typeof v === "number" || typeof v === "string") out[k] = v;
  }
  return out;
}

function designPlotKey(properties: DesignProperties): string {
  if (properties.type === "headland") return "headland";
  return plotKey(properties.strip_id!, properties.plot_id!);
}

/**
 * Low-level spatial join (R: the `st_intersection`/`st_join` step inside
 * `summarize_chars`), exported per design.md's design-diagnostics spec so the
 * test harness can validate it independently of `checkOrthoWithChars`.
 *
 * Polygon soil layers (SSURGO case): one fragment per non-empty
 * design-polygon x soil-polygon intersection (R: `st_intersection`).
 * Point soil layers: one fragment per point falling inside a design polygon
 * (R: `st_join`). `values` carries every numeric *and* character/string soil
 * property (R's numeric and factor/character columns both feed
 * `summarize_indiv_char`) — vector soil layers only; raster (`SpatRaster`)
 * layers go through `extractRasterMeans` instead, see checkOrthoWithChars.
 */
export function spatialJoin(
  design: FeatureCollection,
  soilLayer: FeatureCollection
): SoilFragment[] {
  const soilFeatures = soilLayer.features;
  if (soilFeatures.length === 0) return [];
  const isPointLayer = soilFeatures.every((f) => f.geometry?.type === "Point");

  const fragments: SoilFragment[] = [];
  if (isPointLayer) {
    for (const designFeature of design.features) {
      const dGeom = designFeature.geometry as Polygon | MultiPolygon | null;
      if (!dGeom) continue;
      const dFeature = asFeature(dGeom);
      const properties = designFeature.properties as DesignProperties;
      for (const soilFeature of soilFeatures) {
        const point = soilFeature.geometry as Point | null;
        if (!point) continue;
        if (!booleanPointInPolygon(point.coordinates as Position, dFeature)) continue;
        fragments.push({
          plotKey: designPlotKey(properties),
          rate: properties.rate,
          values: extractJoinableValues(soilFeature.properties),
        });
      }
    }
  } else {
    for (const designFeature of design.features) {
      const dGeom = designFeature.geometry as Polygon | MultiPolygon | null;
      if (!dGeom) continue;
      const dBbox = bboxOfGeom(dGeom);
      const properties = designFeature.properties as DesignProperties;
      for (const soilFeature of soilFeatures) {
        const sGeom = soilFeature.geometry as Polygon | MultiPolygon | null;
        if (!sGeom) continue;
        if (!bboxOverlap(dBbox, bboxOfGeom(sGeom))) continue;
        const ov = intersectPolygons(dGeom, sGeom);
        if (!ov) continue;
        if (planarArea(ov) <= 0) continue;
        fragments.push({
          plotKey: designPlotKey(properties),
          rate: properties.rate,
          values: extractJoinableValues(soilFeature.properties),
        });
      }
    }
  }
  return fragments;
}

// !===========================================================
// ! checkOrthoWithChars (R: check_ortho_with_chars / summarize_indiv_char)
// !===========================================================

export interface CharCorrelation {
  var: string;
  corWithRate: number;
}

/** One class's rate summary (R: summarize_indiv_char's character/factor branch, one data.frame row). */
export interface FactorClassSummary {
  class: string;
  rateMean: number;
  /** R sample sd (n - 1); NaN when the class has fewer than 2 fragments (R's sd() returns NA there). */
  rateSd: number;
}

/** Per-class rate summary for one character/factor variable. */
export interface FactorVarSummary {
  var: string;
  classes: FactorClassSummary[];
}

/**
 * `correlations` keeps its original shape (numeric variables only) so
 * existing consumers are unaffected; `factorSummaries` is new and always
 * present (empty when `variables` has no character/factor entries) rather
 * than folding both variable kinds into one discriminated-union array — the
 * least-breaking shape for R's mixed numeric/factor `variable` list.
 */
export interface OrthoWithCharsResult {
  inputName: string;
  correlations: CharCorrelation[];
  factorSummaries: FactorVarSummary[];
}

/** One design-polygon's raster mean (R: one row of terra::extract's output, joined back to rate_design). */
export interface RasterPlotMean {
  plotKey: string;
  rate: number;
  /** NaN when no non-nodata cell center falls inside the polygon (R: NA). */
  mean: number;
}

/**
 * Raster soil-data input for checkOrthoWithChars (R: check_ortho_with_chars'
 * `SpatRaster` branch). `raster` must already be decoded (readGeoTiffRaster);
 * `variable` names the single band read into it and must be `variables`'
 * only entry when this mode is used — a raster carries one band, so there is
 * nothing to disambiguate a list of variable names against.
 */
export interface RasterSoilData {
  raster: RasterGrid;
  variable: string;
}

function isRasterSoilData(
  x: FeatureCollection | SoilFragment[] | RasterSoilData
): x is RasterSoilData {
  return !Array.isArray(x) && "raster" in x;
}

function buildFullDesignFeatureCollection(input: InputDesign): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [...input.plots.features, ...input.headlands.features],
  };
}

function availableJoinableKeys(properties: Record<string, unknown>): string[] {
  return Object.keys(properties).filter(
    (k) => typeof properties[k] === "number" || typeof properties[k] === "string"
  );
}

/** R sample standard deviation (n - 1); NaN for n < 2, matching stats::sd(). */
function sampleStdDev(values: number[]): number {
  const n = values.length;
  if (n < 2) return NaN;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

/**
 * R `summarize_indiv_char`'s character/factor branch: group fragments by
 * `values[v]`'s string value, unweighted mean/sample-sd of rate per group.
 * Group order is first-appearance order (R: data.table's default `by=`,
 * which does not sort — matches its own row order here).
 */
function summarizeFactorVar(fragments: SoilFragment[], v: string): FactorClassSummary[] {
  const groups = new Map<string, number[]>();
  const order: string[] = [];
  for (const f of fragments) {
    const raw = f.values[v];
    if (raw === undefined) continue;
    const cls = String(raw);
    let rates = groups.get(cls);
    if (!rates) {
      rates = [];
      groups.set(cls, rates);
      order.push(cls);
    }
    rates.push(f.rate);
  }
  return order.map((cls) => {
    const rates = groups.get(cls)!;
    return {
      class: cls,
      rateMean: rates.reduce((a, b) => a + b, 0) / rates.length,
      rateSd: sampleStdDev(rates),
    };
  });
}

const UTM_EPSG_MIN_NORTH = 32_601;
const UTM_EPSG_MAX_NORTH = 32_660;
const UTM_EPSG_MIN_SOUTH = 32_701;
const UTM_EPSG_MAX_SOUTH = 32_760;

function isUtmEpsg(epsg: number): boolean {
  return (
    (epsg >= UTM_EPSG_MIN_NORTH && epsg <= UTM_EPSG_MAX_NORTH) ||
    (epsg >= UTM_EPSG_MIN_SOUTH && epsg <= UTM_EPSG_MAX_SOUTH)
  );
}

/**
 * Cell-center point-in-polygon extraction over the *full* trial design (R:
 * `terra::extract(raster, rate_design, fun = mean, na.rm = TRUE)`, where
 * `rate_design = select(trial_design, rate)` is plots + headlands). Unlike
 * the vector-fragment path, this is a per-polygon mean, not per-fragment.
 *
 * Row orientation follows `raster.yres`'s sign (negative = north-up, row 0
 * at maxY; positive = south-up, row 0 at minY) — both are handled.
 *
 * If the raster's CRS is not WGS84, the design polygons are reprojected into
 * it (proj4, reusing projection.ts's UTM helpers) rather than resampling the
 * raster — cheaper, and exact for the point-in-polygon test either way.
 * A raster with no CRS at all (`epsg: null`, missing/unknown GeoKeys) throws:
 * silently assuming WGS84 would mis-place every cell for projected rasters.
 * Raster CRSs outside WGS84/UTM also throw explicitly (out of scope: see
 * projection.ts, which only derives WGS84<->UTM transforms).
 */
export function extractRasterMeans(
  design: FeatureCollection,
  raster: RasterGrid
): RasterPlotMean[] {
  if (raster.epsg === null) {
    throw new ValidationError(
      "extractRasterMeans: the raster carries no CRS (missing or unrecognized GeoTIFF GeoKeys). " +
        "Supply a georeferenced GeoTIFF whose CRS is WGS84 (EPSG:4326) or a UTM zone " +
        "(EPSG:326xx north / 327xx south)."
    );
  }
  const needsReprojection = raster.epsg !== 4326;
  if (needsReprojection && !isUtmEpsg(raster.epsg)) {
    throw new ValidationError(
      `extractRasterMeans: unsupported raster CRS (EPSG:${raster.epsg}). Only WGS84 (EPSG:4326) ` +
        "and UTM zones (EPSG:326xx north / 327xx south) are supported; reproject the design " +
        "polygons yourself for other CRSs."
    );
  }

  const [minX, minY, , maxY] = raster.bbox;
  const { width, height, xres, data } = raster;
  // yres is SIGNED (see RasterGrid): negative = north-up (row 0 at maxY),
  // positive = south-up (row 0 at minY).
  const northUp = raster.yres < 0;
  const yresAbs = Math.abs(raster.yres);
  // Fractional row index of a y coordinate, respecting orientation.
  const rowOf = (y: number): number => (northUp ? (maxY - y) / yresAbs : (y - minY) / yresAbs);
  const results: RasterPlotMean[] = [];

  for (const feature of design.features) {
    const rawGeom = feature.geometry as Polygon | MultiPolygon | null;
    if (!rawGeom) continue;
    const geom = needsReprojection ? projectGeom(rawGeom, raster.epsg) : rawGeom;
    const properties = feature.properties as DesignProperties;
    const dBbox = bboxOfGeom(geom);
    const dFeature = asFeature(geom);

    const colLo = Math.max(0, Math.floor((dBbox[0] - minX) / xres) - 1);
    const colHi = Math.min(width - 1, Math.ceil((dBbox[2] - minX) / xres) + 1);
    // With a north-up raster rowOf(ymax) < rowOf(ymin); south-up flips that.
    const rowA = rowOf(dBbox[1]);
    const rowB = rowOf(dBbox[3]);
    const rowLo = Math.max(0, Math.floor(Math.min(rowA, rowB)) - 1);
    const rowHi = Math.min(height - 1, Math.ceil(Math.max(rowA, rowB)) + 1);

    let sum = 0;
    let count = 0;
    for (let row = rowLo; row <= rowHi; row++) {
      const cellY = northUp ? maxY - (row + 0.5) * yresAbs : minY + (row + 0.5) * yresAbs;
      for (let col = colLo; col <= colHi; col++) {
        const value = data[row * width + col]!;
        if (Number.isNaN(value)) continue;
        const cellX = minX + (col + 0.5) * xres;
        if (!booleanPointInPolygon([cellX, cellY], dFeature)) continue;
        sum += value;
        count += 1;
      }
    }

    results.push({
      plotKey: designPlotKey(properties),
      rate: properties.rate,
      mean: count > 0 ? sum / count : NaN,
    });
  }

  return results;
}

/**
 * Port of R `check_ortho_with_chars` (tabular data only, no ggplot — design.md
 * non-goals). Three `soilData` modes, discriminated by shape:
 * - `FeatureCollection` — a vector (GeoJSON) soil layer; `spatialJoin` runs
 *   internally, per input, and each requested variable is treated as numeric
 *   (correlation) or character/factor (per-class rate_mean/rate_sd) based on
 *   its value's runtime type, matching R's `class(joined_data[[var]])`.
 * - `SoilFragment[]` — a pre-computed fragment table (e.g. exported by R);
 *   the same table is used for every input in `td` (no per-input
 *   re-derivation is possible from a fragment table alone), matching this
 *   port's parity fixtures (always a single-input `td`).
 * - `RasterSoilData` — a decoded single-band `SpatRaster` (R's raster
 *   branch): per-polygon cell-center means via `extractRasterMeans`, then an
 *   unweighted correlation with rate — no fragments, no per-class summary
 *   (raster bands are always numeric in R's own branch).
 *
 * R semantics for the vector modes (verified against 0.1.3 sources):
 * correlation/per-class summary is computed on the raw `st_intersection`
 * fragments of the *full* trial design (experiment plots + headlands,
 * headland rate = gc_rate) — no per-plot averaging. The raster mode differs
 * (see extractRasterMeans): R's `terra::extract` output is one row per
 * design polygon, so its correlation is over per-polygon means, not fragments.
 */
export function checkOrthoWithChars(
  td: TrialDesign,
  soilData: FeatureCollection | SoilFragment[] | RasterSoilData,
  variables: string[]
): OrthoWithCharsResult[] {
  if (variables.length === 0) {
    throw new ValidationError("checkOrthoWithChars requires a non-empty vars list.");
  }

  if (isRasterSoilData(soilData)) {
    if (variables.length !== 1 || variables[0] !== soilData.variable) {
      throw new ValidationError(
        `checkOrthoWithChars: raster soilData carries a single band ("${soilData.variable}"); ` +
          `vars must be exactly ["${soilData.variable}"], got [${variables.join(", ")}].`
      );
    }
    return td.inputs.map((input) => {
      const means = extractRasterMeans(buildFullDesignFeatureCollection(input), soilData.raster);
      const corWithRate = pearsonCorrelation(
        means
          .map((m) => ({ x: m.rate, y: m.mean }))
          .filter(
            (p): p is { x: number; y: number } => Number.isFinite(p.x) && Number.isFinite(p.y)
          )
      );
      return {
        inputName: input.plotInfo.input_name,
        correlations: [{ var: soilData.variable, corWithRate }],
        factorSummaries: [],
      };
    });
  }

  let sampleValues: Record<string, unknown>;
  if (Array.isArray(soilData)) {
    if (soilData.length === 0) {
      throw new ValidationError("checkOrthoWithChars received an empty soil fragment table.");
    }
    sampleValues = soilData[0]!.values;
    for (const v of variables) {
      if (!Object.hasOwn(sampleValues, v)) {
        throw new ValidationError(
          `Variable "${v}" not found in the soil fragment table. Available columns: ${Object.keys(sampleValues).join(", ")}.`
        );
      }
    }
  } else {
    if (soilData.features.length === 0) {
      throw new ValidationError("checkOrthoWithChars received an empty soil layer (no features).");
    }
    sampleValues = (soilData.features[0]!.properties ?? {}) as Record<string, unknown>;
    for (const v of variables) {
      if (typeof sampleValues[v] !== "number" && typeof sampleValues[v] !== "string") {
        throw new ValidationError(
          `Variable "${v}" not found (or not numeric/character) in the soil layer. Available columns: ${availableJoinableKeys(sampleValues).join(", ")}.`
        );
      }
    }
  }

  return td.inputs.map((input) => {
    const fragments: SoilFragment[] = Array.isArray(soilData)
      ? soilData
      : spatialJoin(buildFullDesignFeatureCollection(input), soilData);

    const correlations: CharCorrelation[] = [];
    const factorSummaries: FactorVarSummary[] = [];

    for (const v of variables) {
      if (typeof sampleValues[v] === "string") {
        factorSummaries.push({ var: v, classes: summarizeFactorVar(fragments, v) });
      } else {
        correlations.push({
          var: v,
          corWithRate: pearsonCorrelation(
            fragments
              .map((f) => ({ x: f.rate, y: f.values[v] }))
              .filter(
                (p): p is { x: number; y: number } =>
                  typeof p.y === "number" && Number.isFinite(p.y) && Number.isFinite(p.x)
              )
          ),
        });
      }
    }

    return { inputName: input.plotInfo.input_name, correlations, factorSummaries };
  });
}
