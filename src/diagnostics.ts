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
  for (let i = 1; i < rings.length; i++) total -= Math.abs(signedRingArea(rings[i]!));
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
function intersectPolygons(a: Polygon | MultiPolygon, b: Polygon | MultiPolygon): (Polygon | MultiPolygon) | null {
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

type PlotProps = { plot_id: number; strip_id: number };

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
    stripId: (f.properties as PlotProps).strip_id,
    geom: projectGeom(f.geometry, epsg),
  }));
  const headlandsUtm = headlandFeatures.map((f) => projectGeom(f.geometry, epsg));

  const guideLine = input.guidanceLines.features[0] as Feature<LineString>;
  const [g0, g1] = guideLine.geometry.coordinates;
  const p1 = toUtm([g0![0]!, g0![1]!], epsg).point;
  const p2 = toUtm([g1![0]!, g1![1]!], epsg).point;
  const abVec: Pt = [p2[0] - p1[0], p2[1] - p1[1]];
  const abLen = Math.hypot(abVec[0], abVec[1]);
  const nml: Pt = [abVec[0] / abLen, abVec[1] / abLen];
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
  const fromFrame = (u: number, v: number): Pt => [u * nml[0] + v * p90[0], u * nml[1] + v * p90[1]];
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
export function checkAlignment(td: TrialDesign, fragments?: AlignmentFragment[][]): AlignmentResult[] {
  if (fragments) {
    if (fragments.length !== td.inputs.length) {
      throw new ValidationError(
        `checkAlignment received ${fragments.length} fragment table(s) for ${td.inputs.length} input(s).`,
      );
    }
    return td.inputs.map((input, i) => ({
      inputName: input.plotInfo.input_name,
      overlapData: aggregateAlignmentFragments(fragments[i]!),
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
        "(R's own check_ortho_inputs errors the same way here: cor_input is never assigned).",
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

type DesignProps = { type?: string; strip_id?: number; plot_id?: number; rate: number };

function extractNumericValues(props: Record<string, unknown> | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!props) return out;
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "number") out[k] = v;
  }
  return out;
}

function designPlotKey(props: DesignProps): string {
  if (props.type === "headland") return "headland";
  return plotKey(props.strip_id!, props.plot_id!);
}

/**
 * Low-level spatial join (R: the `st_intersection`/`st_join` step inside
 * `summarize_chars`), exported per design.md's design-diagnostics spec so the
 * test harness can validate it independently of `checkOrthoWithChars`.
 *
 * Polygon soil layers (SSURGO case): one fragment per non-empty
 * design-polygon x soil-polygon intersection (R: `st_intersection`).
 * Point soil layers: one fragment per point falling inside a design polygon
 * (R: `st_join`). `values` carries every *numeric* soil property (R's scope
 * reduction to numeric/vector layers — factor/raster inputs are not ported,
 * see design-diagnostics/spec.md).
 */
export function spatialJoin(design: FeatureCollection, soilLayer: FeatureCollection): SoilFragment[] {
  const soilFeatures = soilLayer.features;
  if (soilFeatures.length === 0) return [];
  const isPointLayer = soilFeatures.every((f) => f.geometry?.type === "Point");

  const fragments: SoilFragment[] = [];
  if (isPointLayer) {
    for (const designFeature of design.features) {
      const dGeom = designFeature.geometry as Polygon | MultiPolygon | null;
      if (!dGeom) continue;
      const dFeature = asFeature(dGeom);
      const props = designFeature.properties as DesignProps;
      for (const soilFeature of soilFeatures) {
        const point = soilFeature.geometry as Point | null;
        if (!point) continue;
        if (!booleanPointInPolygon(point.coordinates as Position, dFeature)) continue;
        fragments.push({
          plotKey: designPlotKey(props),
          rate: props.rate,
          values: extractNumericValues(soilFeature.properties),
        });
      }
    }
  } else {
    for (const designFeature of design.features) {
      const dGeom = designFeature.geometry as Polygon | MultiPolygon | null;
      if (!dGeom) continue;
      const dBbox = bboxOfGeom(dGeom);
      const props = designFeature.properties as DesignProps;
      for (const soilFeature of soilFeatures) {
        const sGeom = soilFeature.geometry as Polygon | MultiPolygon | null;
        if (!sGeom) continue;
        if (!bboxOverlap(dBbox, bboxOfGeom(sGeom))) continue;
        const ov = intersectPolygons(dGeom, sGeom);
        if (!ov) continue;
        if (planarArea(ov) <= 0) continue;
        fragments.push({
          plotKey: designPlotKey(props),
          rate: props.rate,
          values: extractNumericValues(soilFeature.properties),
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

export interface OrthoWithCharsResult {
  inputName: string;
  correlations: CharCorrelation[];
}

function buildFullDesignFeatureCollection(input: InputDesign): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [...input.plots.features, ...input.headlands.features],
  };
}

function availableNumericKeys(props: Record<string, unknown>): string[] {
  return Object.keys(props).filter((k) => typeof props[k] === "number");
}

/**
 * Port of R `check_ortho_with_chars` (tabular data only, no ggplot — design.md
 * non-goals) restricted to numeric variables over vector (GeoJSON) soil
 * layers, per design-diagnostics/spec.md's documented scope reduction
 * (factor/categorical variables and raster layers are not ported).
 *
 * `soilData` accepts either a soil-layer `FeatureCollection` (spatialJoin
 * runs internally, per input) or a pre-computed `SoilFragment[]` table (e.g.
 * exported by R) — in the latter mode the same fragment table is used for
 * every input in `td` (no per-input re-derivation is possible from a fragment
 * table alone), which matches this port's parity fixtures (always a
 * single-input `td`).
 *
 * R semantics (verified against 0.1.3 sources): correlation is computed on
 * the raw `st_intersection` fragments of the *full* trial design (experiment
 * plots + headlands, headland rate = gc_rate) — no per-plot averaging.
 */
export function checkOrthoWithChars(
  td: TrialDesign,
  soilData: FeatureCollection | SoilFragment[],
  vars: string[],
): OrthoWithCharsResult[] {
  if (vars.length === 0) {
    throw new ValidationError("checkOrthoWithChars requires a non-empty vars list.");
  }

  if (Array.isArray(soilData)) {
    if (soilData.length === 0) {
      throw new ValidationError("checkOrthoWithChars received an empty soil fragment table.");
    }
    const sample = soilData[0]!.values;
    for (const v of vars) {
      if (!(v in sample)) {
        throw new ValidationError(
          `Variable "${v}" not found in the soil fragment table. Available columns: ${Object.keys(sample).join(", ")}.`,
        );
      }
    }
  } else {
    if (soilData.features.length === 0) {
      throw new ValidationError("checkOrthoWithChars received an empty soil layer (no features).");
    }
    const sampleProps = (soilData.features[0]!.properties ?? {}) as Record<string, unknown>;
    for (const v of vars) {
      if (typeof sampleProps[v] !== "number") {
        throw new ValidationError(
          `Variable "${v}" not found (or not numeric) in the soil layer. Available numeric columns: ${availableNumericKeys(sampleProps).join(", ")}.`,
        );
      }
    }
  }

  return td.inputs.map((input) => {
    const fragments: SoilFragment[] = Array.isArray(soilData)
      ? soilData
      : spatialJoin(buildFullDesignFeatureCollection(input), soilData);

    const correlations = vars.map((v) => ({
      var: v,
      corWithRate: pearsonCorrelation(
        fragments
          .map((f) => ({ x: f.rate, y: f.values[v] }))
          .filter(
            (p): p is { x: number; y: number } =>
              p.y !== undefined && Number.isFinite(p.y) && Number.isFinite(p.x),
          ),
      ),
    }));

    return { inputName: input.plotInfo.input_name, correlations };
  });
}
